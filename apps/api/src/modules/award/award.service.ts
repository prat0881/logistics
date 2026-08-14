import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AwardDecisionStatus, Prisma, type LegAwardDecision, type Query } from "@prisma/client";
import {
  AIR_VARIANT_KEY,
  LegEvent,
  LegStatus,
  QuoteEvent,
  QuoteStatus,
  computeQuoteTotals,
  latestRateByCurrency,
  toUsd,
  transitKeyForVariant,
  type QueryAwardSnapshot,
  type QueryAwardSnapshotLeg,
  type QuoteDraft,
  type RejectInput,
  type SendForApprovalInput,
  type ShortlistInput,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import type { RequestUser } from "../auth/types";
import { ComparisonService } from "../comparison/comparison.service";
import { FxRatesService } from "../fx-rates/fx-rates.service";
import { QueryStatusProjector } from "../status/query-status.projector";
import { StatusService } from "../status/status.service";

// Quote statuses that still might yield a NEW comparable price if we wait longer — the leg
// hasn't heard back (RFQ_SENT), is mid-negotiation (REQUOTED), or needs re-distribution
// (INVALID). Mirrors leg-quote.projector.ts's RESOLVED set (inverted) — kept as a small local
// literal rather than importing that module's internal constant across a module boundary.
const OUTSTANDING_QUOTE_STATUSES: readonly QuoteStatus[] = [
  QuoteStatus.RFQ_SENT,
  QuoteStatus.REQUOTED,
  QuoteStatus.INVALID,
];

// S5.4 — the maker-checker award workflow (design §9). shortlist/sendForApproval (Task 2,
// steps 1+3; validation catalogue §13 A1/A2/A3/A9) are only ever a write to LegAwardDecision +
// an audit event. approve/reject (Task 3, steps 2+4, Manager+ + four-eyes) are the checker
// half — unlike the maker methods, they actually fire quote/leg status transitions via
// StatusService.
@Injectable()
export class AwardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
    private readonly status: StatusService,
    private readonly projector: QueryStatusProjector,
    private readonly fxRates: FxRatesService,
  ) {}

  async shortlist(
    queryId: string,
    legId: string,
    input: ShortlistInput,
    user: RequestUser,
  ): Promise<LegAwardDecision> {
    // Reused for two things: (a) A1 — prove `input.quoteId`/`variant` is a real, PRICED offer
    // on this leg (comparison offers are already QUOTED/REQUOTED-only, so finding one here also
    // proves the status requirement); (b) the live recommendation to snapshot onto the decision
    // (D3). `getComparison` emits one OfferDto per `variantsForMode` slot unconditionally, so an
    // FF that only priced e.g. DEDICATED still has a GROUPAGE placeholder (`priced: false`,
    // ~$0) — `&& o.priced` keeps that placeholder from passing A1 and pinning the award to a
    // never-quoted, zero-freight variant.
    const comparison = await this.comparison.getComparison(queryId);
    const leg = comparison.legs.find((l) => l.legId === legId);
    if (!leg) throw new NotFoundException("Leg not found");

    const offer = leg.offers.find(
      (o) => o.quoteId === input.quoteId && o.variant === input.variant && o.priced,
    );
    if (!offer) {
      throw new BadRequestException("Selected quote/variant is not an offer on this leg");
    }

    const rec = leg.recommendation;
    return this.prisma.$transaction(async (tx) => {
      const decision = await tx.legAwardDecision.upsert({
        where: { legId },
        create: {
          legId,
          queryId,
          shortlistedQuoteId: input.quoteId,
          shortlistedVariant: input.variant,
          recommendedQuoteId: rec?.quoteId ?? null,
          recommendedVariant: rec?.variant ?? null,
          overrideReason: input.overrideReason ?? null,
          status: AwardDecisionStatus.DRAFT,
        },
        update: {
          shortlistedQuoteId: input.quoteId,
          shortlistedVariant: input.variant,
          recommendedQuoteId: rec?.quoteId ?? null,
          recommendedVariant: rec?.variant ?? null,
          overrideReason: input.overrideReason ?? null,
          status: AwardDecisionStatus.DRAFT,
        },
      });
      await tx.awardDecisionEvent.create({
        data: {
          legId,
          queryId,
          type: "SHORTLIST",
          quoteId: input.quoteId,
          variant: input.variant,
          actorId: user.userId,
        },
      });
      return decision;
    });
  }

  async sendForApproval(
    queryId: string,
    legId: string,
    input: SendForApprovalInput,
    user: RequestUser,
  ): Promise<LegAwardDecision> {
    const leg = await this.prisma.leg.findFirst({
      where: { id: legId, queryId },
      select: {
        status: true,
        quotes: {
          where: { status: { not: QuoteStatus.SELECT } },
          select: { status: true, rfq: { select: { submissionDeadline: true } } },
        },
      },
    });
    if (!leg) throw new NotFoundException("Leg not found");

    const decision = await this.prisma.legAwardDecision.findUnique({ where: { legId } });
    if (!decision || !decision.shortlistedQuoteId) {
      throw new BadRequestException("Shortlist an offer on this leg before sending for approval");
    }

    // A3 (D10) — either the rollup already reached FULLY_QUOTED, or every still-outstanding
    // FF's RFQ window has closed (so waiting longer cannot produce a better offer).
    const fullyQuoted = leg.status === LegStatus.FULLY_QUOTED;
    const outstanding = leg.quotes.filter((q) => OUTSTANDING_QUOTE_STATUSES.includes(q.status));
    const deadlinePassed =
      outstanding.length > 0 &&
      outstanding.every((q) => q.rfq != null && q.rfq.submissionDeadline.getTime() <= Date.now());
    if (!fullyQuoted && !deadlinePassed) {
      throw new BadRequestException(
        "This leg is not fully quoted yet and its RFQ deadline has not passed",
      );
    }

    // A2 — an override reason is required whenever the shortlist deviates from the
    // recommendation snapshotted at shortlist time (including "there was no recommendation").
    const matchesRecommendation =
      decision.shortlistedQuoteId === decision.recommendedQuoteId &&
      decision.shortlistedVariant === decision.recommendedVariant;
    if (!matchesRecommendation && !decision.overrideReason) {
      throw new BadRequestException(
        "An override reason is required when the shortlist differs from the recommendation",
      );
    }

    // A9 — a re-quote in flight on this leg must be explicitly proceeded past.
    const hasInFlightRequote = leg.quotes.some((q) => q.status === QuoteStatus.REQUOTED);
    if (hasInFlightRequote && !(input.proceedWithoutWaiting === true && input.proceedReason)) {
      throw new BadRequestException(
        "This leg has an in-flight re-quote; confirm proceeding without waiting for it",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.legAwardDecision.update({
        where: { legId },
        data: {
          status: AwardDecisionStatus.PENDING_APPROVAL,
          sentByUserId: user.userId,
          sentForApprovalAt: new Date(),
        },
      });
      await tx.awardDecisionEvent.create({
        data: {
          legId,
          queryId,
          type: "SEND_FOR_APPROVAL",
          reason: input.proceedReason ?? decision.overrideReason ?? null,
          actorId: user.userId,
        },
      });
      return updated;
    });
  }

  // Shared preconditions for both checker actions, in order: (0) the leg must actually belong
  // to the URL's queryId — 404 otherwise. This mirrors sendForApproval's own
  // `where: { id: legId, queryId }` scoping (line ~114 above); without it, a mismatched queryId
  // in the URL (any other real query, correct legId) would still succeed and thread the WRONG
  // queryId into the fire()s / AwardDecisionEvent / QueryStatusProjector rollup — corrupting the
  // audit trail and recomputing the wrong query's status. (1) the decision must exist (404);
  // (2) it must be PENDING_APPROVAL — you cannot decide something not sent for approval (409);
  // (3) four-eyes — the Manager (or Admin) deciding may not be the same user who sent it (403).
  // The @Roles guard already keeps plain Executives out before this ever runs; this additionally
  // stops a Manager from approving/rejecting their own send. Returns the leg's status alongside
  // the decision since approve() needs it for its own FULLY_QUOTED guard below.
  private async requireDecidable(
    queryId: string,
    legId: string,
    user: RequestUser,
  ): Promise<{ leg: { status: string }; decision: LegAwardDecision }> {
    const leg = await this.prisma.leg.findFirst({ where: { id: legId, queryId }, select: { status: true } });
    if (!leg) throw new NotFoundException("Leg not found");

    const decision = await this.prisma.legAwardDecision.findUnique({ where: { legId } });
    if (!decision) throw new NotFoundException("No award decision on this leg");
    if (decision.status !== AwardDecisionStatus.PENDING_APPROVAL) {
      throw new ConflictException("This leg is not pending approval");
    }
    if (decision.sentByUserId === user.userId) {
      throw new ForbiddenException("SELF_APPROVAL");
    }
    return { leg, decision };
  }

  async approve(queryId: string, legId: string, user: RequestUser): Promise<LegAwardDecision> {
    const { leg, decision } = await this.requireDecidable(queryId, legId, user);

    // The only registered "leg" edge for the APPROVE event is FULLY_QUOTED -> APPROVED
    // (award.module.ts). sendForApproval's A3 path can legally reach PENDING_APPROVAL from a
    // PARTIALLY_QUOTED leg (outstanding FFs' deadlines passed) — approving that leg would fire
    // the quote first (which commits), then hit this illegal leg transition (uncaught ->
    // IllegalTransitionError -> 500), stranding a half-approved state: quote APPROVED, leg still
    // PARTIALLY_QUOTED, decision still PENDING_APPROVAL. Guard BEFORE firing anything so nothing
    // half-commits. Completing a deadline-passed PARTIALLY_QUOTED leg (expiring the stragglers
    // -> FULLY_QUOTED, then approving) is SB5's expiry-sweep job — deliberately not done here; a
    // bare EXPIRE fire here would strand SB5's own ScheduledEvents for those quotes.
    if (leg.status !== LegStatus.FULLY_QUOTED) {
      throw new ConflictException(
        "This leg is not fully quoted; its outstanding RFQs must be closed out before approval",
      );
    }

    // sendForApproval only ever reaches PENDING_APPROVAL with shortlistedQuoteId set (it
    // guards on that itself) — re-narrow defensively since the column is nullable.
    const quoteId = decision.shortlistedQuoteId;
    if (!quoteId) throw new ConflictException("This leg has no shortlisted offer");

    // A8 — a concurrent re-quote/change-order may have moved the shortlisted quote off QUOTED
    // between send-for-approval and this decision; re-check freshness right before firing.
    const quote = await this.prisma.quote.findUnique({ where: { id: quoteId }, select: { status: true } });
    if (!quote || quote.status !== QuoteStatus.QUOTED) {
      throw new ConflictException("The shortlisted quote is no longer available for approval");
    }

    // Fire ORDER is load-bearing. fire() awaits emitAsync (status.service.ts), so
    // LegQuoteProjector.onQuoteStatusChanged runs synchronously inside the quote fire below.
    // Quote first: while the leg is still FULLY_QUOTED, the projector's
    // `leg.status !== FULLY_QUOTED` guard is false, so it correctly no-ops (the quote is now
    // APPROVED — a RESOLVED status — and all quotes resolved, but the leg hasn't moved yet).
    // Firing leg first would leave the projector seeing leg=APPROVED + all-resolved on the
    // subsequent quote fire and attempt an illegal QUOTE_FULL (APPROVED -> FULLY_QUOTED) edge
    // (caught+logged, no corruption, but wrong). Each fire owns its own transaction, so a
    // partial failure between the two is an accepted risk for this task.
    await this.status.fire("quote", quoteId, QuoteEvent.APPROVE, {
      queryId,
      actorId: user.userId,
      reason: null,
    });
    await this.status.fire("leg", legId, LegEvent.APPROVE, { queryId, actorId: user.userId });

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.legAwardDecision.update({
        where: { legId },
        data: {
          status: AwardDecisionStatus.APPROVED,
          decidedByUserId: user.userId,
          decidedAt: new Date(),
        },
      });
      await tx.awardDecisionEvent.create({
        data: {
          legId,
          queryId,
          type: "APPROVE",
          quoteId,
          variant: decision.shortlistedVariant,
          actorId: user.userId,
        },
      });
      return updated;
    });
  }

  async reject(
    queryId: string,
    legId: string,
    input: RejectInput,
    user: RequestUser,
  ): Promise<LegAwardDecision> {
    await this.requireDecidable(queryId, legId, user);

    // Single final write straight to DRAFT (design §9.5: "REJECTED -> back to DRAFT") rather
    // than two updates (REJECTED then DRAFT) — the "REJECTED" moment is captured as audit
    // intent by the REJECT event + rejectionReason, not as a persisted intermediate decision
    // status. Clearing sentByUserId re-enables the maker to shortlist/send again. The quote is
    // UNCHANGED — reject fires no status transition (design §8: reject is not a quote
    // transition; the quote stays QUOTED).
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.legAwardDecision.update({
        where: { legId },
        data: {
          status: AwardDecisionStatus.DRAFT,
          sentByUserId: null,
          rejectionReason: input.reason,
          decidedByUserId: user.userId,
          decidedAt: new Date(),
        },
      });
      await tx.awardDecisionEvent.create({
        data: {
          legId,
          queryId,
          type: "REJECT",
          reason: input.reason,
          actorId: user.userId,
        },
      });
      return updated;
    });
  }

  // The two TERMINAL endpoints (design §5.6/§8.3/§9, S5.4 Task 4). Both are QUERY-scoped (no
  // legId) — unlike every method above. `generateClientQuote` cannot reuse
  // `ComparisonService.getComparison` for pricing: comparison.service.ts's COMPARABLE_STATUSES
  // deliberately excludes APPROVED (its line-51 comment), and every winning quote IS APPROVED by
  // the time this runs (Task 3's approve() put it there) — getComparison would emit zero offers.
  // Instead each winner is priced directly off its own draftJson, mirroring
  // comparison.service.ts's buildLeg (lines ~147-190) but targeted at the single shortlisted
  // variant instead of every variantsForMode column.
  async generateClientQuote(queryId: string, user: RequestUser): Promise<Query> {
    const legs = await this.prisma.leg.findMany({ where: { queryId }, select: { id: true } });
    if (legs.length === 0) {
      throw new ConflictException("This query has no legs to generate a client quote for");
    }

    // A6 — every leg must have a decision AND that decision must be APPROVED with a shortlisted
    // winner still on it. A leg with no decision at all (never shortlisted) and a leg whose
    // decision exists but never reached APPROVED both fail the same way — one gate, one message.
    const decisions = await this.prisma.legAwardDecision.findMany({ where: { queryId } });
    const decisionByLeg = new Map(decisions.map((d) => [d.legId, d]));
    for (const leg of legs) {
      const decision = decisionByLeg.get(leg.id);
      if (!decision || decision.status !== AwardDecisionStatus.APPROVED || !decision.shortlistedQuoteId) {
        throw new ConflictException("every leg must be approved before generating the client quote");
      }
    }

    const rates = await this.fxRates.list();
    const ratesByCurrency = latestRateByCurrency(rates);

    const winners: QueryAwardSnapshotLeg[] = [];
    for (const leg of legs) {
      const decision = decisionByLeg.get(leg.id)!;
      const quote = await this.prisma.quote.findUniqueOrThrow({
        where: { id: decision.shortlistedQuoteId! },
        select: {
          id: true,
          freightForwarderId: true,
          draftJson: true,
          submittedAt: true,
          rfq: { select: { currency: true, quoteValidityUntil: true } },
        },
      });

      const draft = quote.draftJson as unknown as QuoteDraft;
      const totals = computeQuoteTotals(draft);
      const variantKey = decision.shortlistedVariant ?? AIR_VARIANT_KEY;
      const vt = totals.variants.find((t) => t.key === variantKey)!;
      const nativeTotal = vt.grandTotal;

      const currency = quote.rfq?.currency ?? null;
      const rate = currency ? (ratesByCurrency.get(currency) ?? null) : null;
      const usdTotal = currency ? toUsd(nativeTotal, currency, rate) : null;
      // A7 — USD passes through toUsd unconditionally; every other currency needs a rate on
      // file. A null here is the ONLY way a non-priceable winner can reach this point (A6
      // already proved the decision/quote/variant exist), so it's the sole A7 trigger.
      if (usdTotal == null) {
        throw new ConflictException(`no FX rate on file for ${currency ?? "this quote's currency"}`);
      }

      const transitDays =
        draft.transit?.guaranteedTransitDaysByVariant[
          transitKeyForVariant(draft.mode, decision.shortlistedVariant)
        ] ?? null;

      winners.push({
        legId: leg.id,
        winningQuoteId: quote.id,
        freightForwarderId: quote.freightForwarderId,
        variant: decision.shortlistedVariant,
        currency,
        unitsPerUsd: rate?.unitsPerUsd ?? null,
        usdTotal,
        nativeTotal,
        transitDays,
      });
    }

    const awardSnapshot: QueryAwardSnapshot = {
      generatedByUserId: user.userId,
      legs: winners,
      combinedUsd: winners.reduce((sum, w) => sum + w.usdTotal, 0),
    };

    // ONE transaction: freeze the snapshot, audit one GENERATE event per leg (the table's legId
    // is NOT-NULL with an FK — a single query-level/sentinel row is impossible), then recompute
    // the query rollup INSIDE the same tx so it reads the just-written awardSnapshot and
    // persists QUOTING_CLIENT atomically. Deliberately no `this.status.fire(...)` call — legs
    // stay APPROVED (leg AWARDED is reserved for post-client-Won, Stage 6); query status is a
    // projection, never fire()'d.
    return this.prisma.$transaction(async (tx) => {
      await tx.query.update({
        where: { id: queryId },
        data: { awardSnapshot: awardSnapshot as unknown as Prisma.InputJsonValue },
      });
      for (const leg of legs) {
        await tx.awardDecisionEvent.create({
          data: { legId: leg.id, queryId, type: "GENERATE", actorId: user.userId },
        });
      }
      await this.projector.recompute(queryId, tx);
      return tx.query.findUniqueOrThrow({ where: { id: queryId } });
    });
  }

  async reopenComparison(queryId: string, user: RequestUser): Promise<Query> {
    const query = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { awardSnapshot: true },
    });
    if (!query) throw new NotFoundException("Query not found");
    if (query.awardSnapshot == null) {
      throw new ConflictException("this query is not being quoted to the client");
    }

    const legs = await this.prisma.leg.findMany({ where: { queryId }, select: { id: true } });

    // Leg/decision APPROVED states are LEFT INTACT — reopening the client quote doesn't
    // un-approve legs; a later per-leg change/negotiation reverses an approval (S5.5).
    return this.prisma.$transaction(async (tx) => {
      await tx.query.update({
        where: { id: queryId },
        // Prisma.DbNull (a nullable Json column -> SQL NULL, not the JSON null literal —
        // JsonNull would read back as a truthy object, defeating the projector's `!!` check and
        // reopenComparison's own `== null` guard above) — same convention as
        // rfq.service.ts/rfq-schedule.listener.ts's draftJson clears.
        data: { awardSnapshot: Prisma.DbNull },
      });
      for (const leg of legs) {
        await tx.awardDecisionEvent.create({
          data: { legId: leg.id, queryId, type: "REOPEN", actorId: user.userId },
        });
      }
      await this.projector.recompute(queryId, tx);
      return tx.query.findUniqueOrThrow({ where: { id: queryId } });
    });
  }
}
