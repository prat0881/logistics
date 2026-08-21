import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AwardDecisionStatus, Prisma, type LegAwardDecision, type Query } from "@prisma/client";
import { z } from "zod";
import {
  AIR_VARIANT_KEY,
  LegEvent,
  LegStatus,
  QuoteEvent,
  QuoteStatus,
  computeQuoteTotals,
  latestRateByCurrency,
  rollupLegTarget,
  toUsd,
  transitKeyForVariant,
  type QueryAwardSnapshot,
  type QueryAwardSnapshotLeg,
  type QuoteDraft,
  type RecommendationDto,
  type RejectInput,
  type SendForApprovalInput,
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

// S5.9 Task 4 review round — IMPORTANT 2. lockLeg's raw SQL casts both ids to `::uuid` directly
// against Postgres, unlike a typed Prisma call, which validates the shape client-side first —
// see lockLeg's own doc for why that matters. Same `.uuid()` check `@svyft/shared`'s schemas use
// for every other UUID-shaped field (award.ts's `quoteId`, etc.), applied here to a path param
// instead of a body field.
const UUID_SCHEMA = z.string().uuid();

// S5.4 — the maker-checker award workflow (design §9). approve/reject (Task 3, steps 2+4,
// Manager+ + four-eyes) are the checker half. sendForApproval (Task 2, steps 1+3, validation
// catalogue §13 A1/A2/A3/A9/B2) is the maker half.
//
// CORRECTED (S5.9 Task 3 review round 2, IMPORTANT 3) — this comment used to claim
// sendForApproval "is only ever a write to LegAwardDecision + an audit event" and that,
// "unlike the maker method", only approve/reject "actually fire quote/leg status transitions".
// Both clauses went false the moment S5.9 Task 3 gave sendForApproval its own post-commit
// `status.fire` calls (see below, and the class-level note on that method) — it now fires both
// transitions itself, before approve() ever runs. What still distinguishes the two halves is WHO
// may call them and WHEN in the workflow (auth-only + before a decision exists, vs Manager+
// four-eyes + only once PENDING_APPROVAL), not whether either one touches status.
//
// S5.9 Task 3 (register B2/B3) — selecting an offer and sending it for approval used to be two
// separate calls (PUT .../shortlist then POST .../send-for-approval): the second call re-read
// whatever `legAwardDecision.shortlistedQuoteId` the first had last persisted, so a concurrent
// change between the two could submit a forwarder nobody on screen chose — 200 OK, no error
// anywhere. They are now ONE call, `sendForApproval`, that NAMES the offer it acts on and does
// the selection + guard checks + status write in a single transaction. `PUT .../shortlist` and
// the public `shortlist` method are retired; `persistSelection` below is what remains of it, now
// private and reachable only from inside this one transaction.
@Injectable()
export class AwardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
    private readonly status: StatusService,
    private readonly projector: QueryStatusProjector,
    private readonly fxRates: FxRatesService,
  ) {}

  // S5.9 Task 3 (register B3) — the ONE remaining write for a leg's shortlisted offer. Only
  // caller is sendForApproval's own transaction below, hence private + a `tx` parameter instead
  // of `this.prisma`. The A1 offer-validity check and the D3 recommendation snapshot are NOT
  // done here any more: they're reads through ComparisonService.getComparison, which talks to
  // `this.prisma` directly and has no way to see inside an open `tx` (Prisma transaction clients
  // are not composable that way), so sendForApproval computes them itself BEFORE opening the
  // transaction and hands the validated `input` plus the snapshotted `rec` in here. This method's
  // job is only the upsert — no audit event (sendForApproval writes the single SEND_FOR_APPROVAL
  // event that now covers what used to be two events, SHORTLIST + SEND_FOR_APPROVAL).
  private async persistSelection(
    tx: Prisma.TransactionClient,
    queryId: string,
    legId: string,
    input: SendForApprovalInput,
    rec: RecommendationDto | null,
  ): Promise<LegAwardDecision> {
    return tx.legAwardDecision.upsert({
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
  }

  // S5.9 Task 4 — the SAME mutual-exclusion lock sendForApproval originally inlined (Task 3,
  // review round 2, CRITICAL 1 / register B3), extracted so every entry point that can race
  // another on the same leg (send-for-approval, approve, reject) takes it identically: same
  // row, same order (Leg first, nothing else locked before or after it in the same call), same
  // raw SQL. `SELECT ... FOR UPDATE` on the leg's own row (always extant by the time any of
  // these three can run) turns the caller's whole guard-then-write sequence into that leg's
  // critical section — a second concurrent call on the same leg blocks HERE, before it reads
  // anything its own guards depend on, until this transaction commits or rolls back. Prisma has
  // no typed API for row locks, hence raw SQL — parameterized via the tagged template, never
  // string-interpolated.
  private async lockLeg(
    tx: Prisma.TransactionClient,
    queryId: string,
    legId: string,
  ): Promise<void> {
    // S5.9 Task 4 review round — IMPORTANT 2. A typed Prisma call (what `requireDecidable` used
    // to do, and what `sendForApproval` still does first via `ComparisonService.getComparison`)
    // validates a `@db.Uuid` argument client-side and a malformed one surfaces as a Prisma error
    // code `PrismaExceptionFilter` maps to 400. This raw query bypasses that entirely: a
    // malformed `legId`/`queryId` reaches Postgres itself, which rejects the `::uuid` cast with
    // its own `22P02`, wrapped by `$queryRaw` in a Prisma error code the filter does NOT map —
    // falling through to a bare 500. `approve`/`reject` call this as their very first operation
    // (no prior typed read to catch it), so validate the shape ourselves first and 400
    // identically to what a typed Prisma call would have done.
    if (!UUID_SCHEMA.safeParse(legId).success || !UUID_SCHEMA.safeParse(queryId).success) {
      throw new BadRequestException("Invalid identifier");
    }
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Leg" WHERE "id" = ${legId}::uuid AND "queryId" = ${queryId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundException("Leg not found");
  }

  // The leg status the quotes currently justify. Delegates to the ONE pure rule in @svyft/shared
  // that LegQuoteProjector also uses, so approve/reject and the rollup can never disagree (D4).
  // Takes `tx`, not `this.prisma`: approve()/reject() call this from inside the same transaction
  // that holds lockLeg's row lock, so the read is against that transaction's own consistent
  // snapshot rather than a second, unlocked connection.
  private async legRollupTarget(
    tx: Prisma.TransactionClient,
    legId: string,
  ): Promise<LegStatus | null> {
    const quotes = await tx.quote.findMany({
      where: { legId, status: { not: QuoteStatus.SELECT } },
      select: { status: true },
    });
    return rollupLegTarget(quotes.map((q) => q.status));
  }

  // S5.9 Task 3 (register B2/B3) — selecting an offer and sending it for approval are now ONE
  // call that NAMES the offer it acts on, in ONE transaction. The old two-call shape (PUT
  // .../shortlist, then POST .../send-for-approval) let a concurrent shortlist change the
  // persisted `shortlistedQuoteId` between the two calls; this call never re-reads a
  // separately-persisted selection, so that window doesn't exist any more.
  //
  // Read/transaction boundary: A1 (offer validity) and D3 (recommendation snapshot) are reads
  // through ComparisonService.getComparison, which queries `this.prisma` directly — it cannot
  // run inside `$transaction` and see `tx`. They run first, before the transaction opens. Every
  // other step — the leg lock + load, the B2/A1-refresh/A3/A2/A9 guards, persistSelection's
  // write, the decision's update to PENDING_APPROVAL, and the AwardDecisionEvent — runs inside
  // the ONE transaction below.
  //
  // CORRECTED (S5.9 Task 3 review round 2, CRITICAL 1) — this comment used to say the in-tx
  // guards are "atomic with the write itself" and stop there. That is true for ROLLBACK (a guard
  // failing after persistSelection's write correctly undoes it) but says nothing about MUTUAL
  // EXCLUSION between two concurrent callers, which is what B2 actually needs and did not have:
  // under READ COMMITTED, the B2 read below (`tx.legAwardDecision.findUnique`) took no lock, so
  // two simultaneous sends on the same leg could both read "no decision yet" before either had
  // written anything, both pass every guard, and both commit — the SECOND to commit silently
  // overwrites the FIRST's persisted selection while the FIRST's already-returned response still
  // claims success naming its own, now-stale offer. Reproduced empirically (two concurrent sends,
  // different quoteIds, one leg): 200/200, decision landed on the second caller's offer, BOTH
  // quotes fired into PENDING_APPROVAL because each request's post-commit fire uses its OWN
  // `input.quoteId`, independent of what actually persisted. That is register B3's bug verbatim,
  // just moved from "two sequential HTTP calls" to "two concurrent HTTP calls of the merged one".
  // Step 0 below closes it with a real mutual-exclusion lock, not just an ordering guarantee.
  async sendForApproval(
    queryId: string,
    legId: string,
    input: SendForApprovalInput,
    user: RequestUser,
  ): Promise<LegAwardDecision> {
    // A1 (offer validity) + D3 (recommendation snapshot) — see the boundary note above. `&&
    // o.priced` keeps a never-quoted, zero-freight variant placeholder (comparison.service.ts
    // emits one per `variantsForMode` slot unconditionally) from passing A1. NOTE (review round
    // 2, deferred minor): this pre-tx read is not re-validated against `rec` inside the
    // transaction — only the NAMED offer's own status is (step 2 below, CRITICAL 2). A `rec`
    // that goes stale between this read and commit is out of scope for this round.
    const comparison = await this.comparison.getComparison(queryId);
    const compLeg = comparison.legs.find((l) => l.legId === legId);
    if (!compLeg) throw new NotFoundException("Leg not found");
    const offer = compLeg.offers.find(
      (o) => o.quoteId === input.quoteId && o.variant === input.variant && o.priced,
    );
    if (!offer) {
      throw new BadRequestException("Selected quote/variant is not an offer on this leg");
    }
    const rec = compLeg.recommendation;

    const updated = await this.prisma.$transaction(async (tx) => {
      // 0. MUTUAL EXCLUSION (review round 2, CRITICAL 1 / register B3) — see lockLeg's own doc
      // (S5.9 Task 4 extracted it there so approve()/reject() take the identical lock). A second
      // concurrent `sendForApproval`/approve/reject on the same leg blocks HERE — before it reads
      // anything the guards depend on — until this transaction commits or rolls back, then
      // proceeds against state that actually reflects the outcome: if this call won, the second
      // call's B2 read (step 1) now sees PENDING_APPROVAL and 409s cleanly, with nothing of its
      // own ever written and no quote it fires into PENDING_APPROVAL.
      await this.lockLeg(tx, queryId, legId);

      // 1. Load the leg (scoped to queryId) with its non-SELECT quotes. `quotes.id` (added
      // review round 2, CRITICAL 2) is what step 2 below needs to find the NAMED quote among
      // them — the pre-tx `getComparison` read above proved it was a real, priced offer as of
      // BEFORE this transaction opened; it says nothing about whether it still is.
      const leg = await tx.leg.findFirst({
        where: { id: legId, queryId },
        select: {
          status: true,
          quotes: {
            where: { status: { not: QuoteStatus.SELECT } },
            select: { id: true, status: true, rfq: { select: { submissionDeadline: true } } },
          },
        },
      });
      if (!leg) throw new NotFoundException("Leg not found");

      // 2. A1 IN-TRANSACTION REFRESH (review round 2, CRITICAL 2) — the named quote must be
      // QUOTED right now, not merely "comparable" (COMPARABLE_STATUSES in comparison.service.ts
      // is QUOTED | REQUOTED | PENDING_APPROVAL — a REQUOTED offer is still visible/priced in
      // the grid, stale-flagged, and passes the pre-tx A1 check above). The quote machine
      // registers exactly ONE source for `send_for_approval`: QUOTED -> PENDING_APPROVAL.
      // Without this, naming a REQUOTED (or otherwise non-QUOTED) offer sails through every
      // guard below, commits persistSelection's write and the PENDING_APPROVAL decision update,
      // and only THEN throws `IllegalTransitionError` out of the post-commit quote fire — a
      // committed, wedged decision with nothing to undo it but reject() (B2 blocks a re-send,
      // approve()'s A8 blocks approval). This is independent of A9 below: A9 is about a
      // DIFFERENT, still-outstanding quote elsewhere on the leg (proceed past it, with reason);
      // naming the re-quoted offer itself is refused unconditionally, override or not — mirrors
      // approve()'s own A8 freshness re-check, just applied at send time instead of decide time.
      const namedQuote = leg.quotes.find((q) => q.id === input.quoteId);
      if (!namedQuote || namedQuote.status !== QuoteStatus.QUOTED) {
        throw new ConflictException(
          "The named offer is no longer QUOTED — refresh the comparison and pick again",
        );
      }

      // 3. B2 guard — a decision that has already moved past DRAFT (sent for approval, or
      // approved) must not be silently reset by a fresh send. Without this: send the winner ->
      // a different Manager approves (leg=APPROVED, quote=APPROVED, decision={APPROVED,
      // shortlist=winner}) -> send AGAIN with the LOSING (still-QUOTED) offer resets the
      // decision to PENDING_APPROVAL while the leg/quote stay APPROVED — an orphaned approval
      // with no way forward. Now genuinely exclusive against a concurrent sender too — see the
      // step-0 lock above.
      const existing = await tx.legAwardDecision.findUnique({ where: { legId } });
      if (
        existing &&
        (existing.status === AwardDecisionStatus.PENDING_APPROVAL ||
          existing.status === AwardDecisionStatus.APPROVED)
      ) {
        throw new ConflictException("This leg has already been sent for approval");
      }

      // 4. A3 (D10) — either the rollup already reached FULLY_QUOTED, or every still-outstanding
      // FF's RFQ window has closed (so waiting longer cannot produce a better offer).
      const fullyQuoted = leg.status === LegStatus.FULLY_QUOTED;
      const outstanding = leg.quotes.filter((q) => OUTSTANDING_QUOTE_STATUSES.includes(q.status));
      const deadlinePassed =
        outstanding.length > 0 &&
        outstanding.every(
          (q) => q.rfq != null && q.rfq.submissionDeadline.getTime() <= Date.now(),
        );
      if (!fullyQuoted && !deadlinePassed) {
        throw new BadRequestException(
          "This leg is not fully quoted yet and its RFQ deadline has not passed",
        );
      }

      // 5. Write the selection — the named offer + the recommendation snapshotted above.
      const decision = await this.persistSelection(tx, queryId, legId, input, rec);

      // 6. A2 — an override reason is required whenever the named offer deviates from the
      // recommendation snapshotted just now (including "there was no recommendation"). Computed
      // from the freshly-written decision, not a stale read — and because this runs inside the
      // transaction, throwing here rolls persistSelection's write back too.
      const matchesRecommendation =
        decision.shortlistedQuoteId === decision.recommendedQuoteId &&
        decision.shortlistedVariant === decision.recommendedVariant;
      if (!matchesRecommendation && !decision.overrideReason) {
        throw new BadRequestException(
          "An override reason is required when the shortlist differs from the recommendation",
        );
      }

      // 7. A9 — a re-quote in flight on this leg must be explicitly proceeded past.
      const hasInFlightRequote = leg.quotes.some((q) => q.status === QuoteStatus.REQUOTED);
      if (hasInFlightRequote && !(input.proceedWithoutWaiting === true && input.proceedReason)) {
        throw new BadRequestException(
          "This leg has an in-flight re-quote; confirm proceeding without waiting for it",
        );
      }

      // 8. Every guard passed — advance the decision and append the single audit event covering
      // this whole call (selection + send, formerly two events: SHORTLIST + SEND_FOR_APPROVAL).
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
          quoteId: input.quoteId,
          variant: input.variant,
          reason: input.proceedReason ?? decision.overrideReason ?? null,
          actorId: user.userId,
        },
      });
      return updated;
    });

    // After commit: fire the two transitions — quote first, then leg. `StatusService.fire` owns
    // its own transaction (it cannot participate in the one above), so this can only happen
    // once the decision write has actually landed. Quote first, leg second: LegQuoteProjector
    // (Task 2) skips legs already in PENDING_APPROVAL/APPROVED, and the leg is still
    // FULLY_QUOTED/PARTIALLY_QUOTED for the whole duration of the quote fire, so the rollup it
    // triggers sees a consistent picture regardless of order — unlike approve() below, ordering
    // here is not load-bearing, just kept consistent with it. Each fire owns its own
    // transaction, so a partial failure between the two (quote moves, leg fire then throws) is
    // an accepted risk, same as approve()/reject().
    await this.status.fire("quote", input.quoteId, QuoteEvent.SEND_FOR_APPROVAL, {
      queryId,
      actorId: user.userId,
      reason: null,
    });
    await this.status.fire("leg", legId, LegEvent.SEND_FOR_APPROVAL, {
      queryId,
      actorId: user.userId,
    });

    return updated;
  }

  // Shared preconditions for both checker actions: (1) the decision must exist (404); (2) it
  // must be PENDING_APPROVAL — you cannot decide something not sent for approval (409); (3)
  // four-eyes — the Manager (or Admin) deciding may not be the same user who sent it (403). The
  // @Roles guard already keeps plain Executives out before this ever runs; this additionally
  // stops a Manager from approving/rejecting their own send.
  //
  // S5.9 Task 4 — takes `tx`, not `this.prisma`: both callers now run this from inside the SAME
  // transaction that holds lockLeg's row lock on this leg (see approve()/reject() below), so the
  // decision read is against that transaction's own consistent snapshot rather than a second,
  // unlocked connection racing whichever of send/approve/reject currently holds the lock. The
  // leg-belongs-to-queryId 404 that used to live here is now lockLeg's job — its
  // `WHERE id = ... AND queryId = ...` raw query 404s identically (mirrors sendForApproval's own
  // scoping) and runs BEFORE this, so a mismatched queryId in the URL never reaches this method
  // at all. Only returns `decision` now (not the leg) — approve() used to read `leg.status` for
  // its own FULLY_QUOTED guard, but that guard moved onto the quotes (see legRollupTarget below).
  private async requireDecidable(
    tx: Prisma.TransactionClient,
    legId: string,
    user: RequestUser,
  ): Promise<{ decision: LegAwardDecision }> {
    const decision = await tx.legAwardDecision.findUnique({ where: { legId } });
    if (!decision) throw new NotFoundException("No award decision on this leg");
    if (decision.status !== AwardDecisionStatus.PENDING_APPROVAL) {
      throw new ConflictException("This leg is not pending approval");
    }
    if (decision.sentByUserId === user.userId) {
      throw new ForbiddenException("SELF_APPROVAL");
    }
    return { decision };
  }

  // S5.9 Task 4 — approve() used to guard on `leg.status !== FULLY_QUOTED`, straight off the
  // OLD machine (QUOTED/FULLY_QUOTED --approve--> APPROVED). After Task 3, the leg is always
  // PENDING_APPROVAL by the time anyone can approve (sendForApproval put it there), so that
  // guard would reject EVERY approval. What it actually meant — "no RFQ on this leg may still
  // be open" — is a property of the QUOTES, not the leg's own status, so it now asks
  // legRollupTarget directly (D4 — the same rule reject() below uses to pick its return target,
  // so the two can never disagree about what the quotes justify).
  //
  // Lock/transaction shape mirrors sendForApproval (S5.9 Task 3): lockLeg FIRST inside the
  // transaction, every guard and the decision write itself INSIDE it, commit, THEN fire the
  // quote/leg transitions. `StatusService.fire` opens its own transaction on a different pool
  // connection — firing from inside a transaction that still holds this leg's row lock would
  // have that inner transaction block on the outer one's own lock until Prisma's interactive-tx
  // timeout (P2028). Firing after commit also gives approve()/reject() the SAME mutual exclusion
  // sendForApproval has: a concurrent send/approve/reject on this leg blocks on lockLeg until
  // this transaction resolves, then sees the real outcome.
  async approve(queryId: string, legId: string, user: RequestUser): Promise<LegAwardDecision> {
    const { decision, quoteId } = await this.prisma.$transaction(async (tx) => {
      await this.lockLeg(tx, queryId, legId);
      const { decision } = await this.requireDecidable(tx, legId, user);

      if ((await this.legRollupTarget(tx, legId)) !== LegStatus.FULLY_QUOTED) {
        throw new ConflictException(
          "This leg is not fully quoted; its outstanding RFQs must be closed out before approval",
        );
      }

      // sendForApproval only ever reaches PENDING_APPROVAL with shortlistedQuoteId set (it
      // guards on that itself) — re-narrow defensively since the column is nullable.
      const quoteId = decision.shortlistedQuoteId;
      if (!quoteId) throw new ConflictException("This leg has no shortlisted offer");

      // A8 — moved from QUOTED to PENDING_APPROVAL: Task 3's send already advanced the
      // shortlisted quote there, so freshness now means "still PENDING_APPROVAL", not "still
      // QUOTED". A concurrent re-quote/change-order could still have knocked it off that status
      // between send and this decision; re-check right before writing anything.
      const quote = await tx.quote.findUnique({ where: { id: quoteId }, select: { status: true } });
      if (!quote || quote.status !== QuoteStatus.PENDING_APPROVAL) {
        throw new ConflictException("The shortlisted quote is no longer available for approval");
      }

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
      return { decision: updated, quoteId };
    });

    // Quote first, then leg — kept consistent with sendForApproval and the e2e call-order spy.
    // Ordering is no longer load-bearing for correctness the way it was pre-Task-2: the
    // projector now skips legs in PENDING_APPROVAL/APPROVED outright (its ROLLUP_FROZEN guard),
    // so neither order can trigger a spurious rollup attempt on the leg this fires against.
    await this.status.fire("quote", quoteId, QuoteEvent.APPROVE, {
      queryId,
      actorId: user.userId,
      reason: null,
    });
    await this.status.fire("leg", legId, LegEvent.APPROVE, { queryId, actorId: user.userId });

    return decision;
  }

  // S5.9 Task 4 — reject() used to fire no status transitions at all, leaving the quote and leg
  // wedged at PENDING_APPROVAL forever. It now returns both, choosing the leg's target via
  // legRollupTarget (D4) rather than a hard-coded FULLY_QUOTED: sendForApproval's A3 path can
  // legally reach PENDING_APPROVAL from a PARTIALLY_QUOTED leg (outstanding FFs' deadlines
  // passed, not every FF actually quoted) — rejecting that leg back to a hard-coded FULLY_QUOTED
  // would promote it into a state it never earned. Same lock/transaction shape as approve()
  // above: lockLeg + every guard + the target computation + the decision write all happen
  // INSIDE one transaction, commit, THEN fire — see approve()'s doc for why (deadlock avoidance
  // — StatusService.fire cannot run while this transaction still holds the leg's row lock).
  //
  // The target is computed from the quotes' statuses AS THEY STAND at guard time, i.e. BEFORE
  // the quote RETURN fire below reverts the shortlisted quote off PENDING_APPROVAL — not "after
  // the return" as it might seem more natural to compute. This is deliberately safe: the shared
  // rollup rule (status.ts) treats PENDING_APPROVAL and QUOTED identically as "resolved" for the
  // FULLY_QUOTED branch, and reject() only ever uses `target` to pick between RETURN_FULL (exact
  // match on FULLY_QUOTED) and RETURN_PARTIAL (everything else, including `null`) — so computing
  // pre- or post-return can never change which of those two edges fires. Computing it inside the
  // same locked transaction as the decision write (rather than as a separate pre-tx read, per
  // the brief's own illustrative ordering) is what lets the lock cover it.
  //
  // S5.9 Task 4 review round — IMPORTANT 3. reject() used to fire QuoteEvent.RETURN
  // unconditionally on `decision.shortlistedQuoteId`. `lockLeg` only locks the LEG row, not the
  // quote — a change-order can race in on the SAME leg (ChangeOrderStrategy takes no leg lock;
  // `award.module.ts` registers `PENDING_APPROVAL --invalidate--> INVALID`) and move the
  // shortlisted quote off PENDING_APPROVAL between this transaction's commit and the post-commit
  // fire below. Without a check, that fire throws `IllegalTransitionError` AFTER the decision
  // has already committed to DRAFT — the leg's own RETURN_FULL/RETURN_PARTIAL fire (sequenced
  // after) never runs, leaving a DRAFT decision on a leg still wedged at PENDING_APPROVAL that no
  // HTTP path recovers (approve/reject both 409 in requireDecidable; send-for-approval has no
  // edge from PENDING_APPROVAL). Mirrors A8 exactly: checked and refused (409) BEFORE any write,
  // not "skip the quote fire but still move the leg" — firing the leg's RETURN_FULL/
  // RETURN_PARTIAL from a `target` computed against the OLD quote statuses, while a concurrent
  // change-order's own INVALIDATE+REOPEN cascade for the SAME leg is independently in flight,
  // risks moving the leg to a status the change-order never intended (e.g. FULLY_QUOTED off a
  // now-invalid quote) and that the change-order's own queued REOPEN fire then can't find an
  // edge from — corrupting or aborting its cascade. A clean 409 here leaves the decision at
  // PENDING_APPROVAL, untouched; the change-order's own listener
  // (`award-change-order.listener.ts`) independently resets this exact decision to DRAFT and
  // reopens the leg moments later regardless, so nothing is lost by refusing. Not reachable on
  // the happy path (hardening, not a live bug) — mutation-proven in the e2e spec.
  async reject(
    queryId: string,
    legId: string,
    input: RejectInput,
    user: RequestUser,
  ): Promise<LegAwardDecision> {
    const { decision, target } = await this.prisma.$transaction(async (tx) => {
      await this.lockLeg(tx, queryId, legId);
      const { decision } = await this.requireDecidable(tx, legId, user);

      // IMPORTANT 3 (above) — same shape as approve()'s A8: refuse before any write if the
      // shortlisted quote has moved off PENDING_APPROVAL since it was sent.
      if (decision.shortlistedQuoteId) {
        const quote = await tx.quote.findUnique({
          where: { id: decision.shortlistedQuoteId },
          select: { status: true },
        });
        if (!quote || quote.status !== QuoteStatus.PENDING_APPROVAL) {
          throw new ConflictException(
            "The shortlisted quote is no longer available to reject — it may already have been resolved elsewhere",
          );
        }
      }

      const target = await this.legRollupTarget(tx, legId);

      // Single final write straight to DRAFT (design §9.5: "REJECTED -> back to DRAFT") rather
      // than two updates (REJECTED then DRAFT) — the "REJECTED" moment is captured as audit
      // intent by the REJECT event + rejectionReason, not as a persisted intermediate decision
      // status. Clearing sentByUserId re-enables the maker to send again.
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
      return { decision: updated, target };
    });

    // Quote first, then leg — same order as approve()/sendForApproval. The leg is still
    // PENDING_APPROVAL for the whole duration of the quote fire, so the projector's freeze
    // (Task 2) skips the rollup it would otherwise trigger off this quote's status change; the
    // leg's own RETURN_FULL/RETURN_PARTIAL fire right after is what actually moves it, using the
    // `target` already computed above.
    if (decision.shortlistedQuoteId) {
      await this.status.fire("quote", decision.shortlistedQuoteId, QuoteEvent.RETURN, {
        queryId,
        actorId: user.userId,
        reason: input.reason,
      });
    }

    await this.status.fire(
      "leg",
      legId,
      target === LegStatus.FULLY_QUOTED ? LegEvent.RETURN_FULL : LegEvent.RETURN_PARTIAL,
      { queryId, actorId: user.userId, reason: input.reason },
    );

    return decision;
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
    // MIN-3 (task-4 review) — 404 a nonexistent query explicitly (mirrors reopenComparison
    // below), so it stays distinct from a real, zero-leg query (a 409 next).
    const query = await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } });
    if (!query) throw new NotFoundException("Query not found");

    const legs = await this.prisma.leg.findMany({ where: { queryId }, select: { id: true } });
    if (legs.length === 0) {
      throw new ConflictException("This query has no legs to generate a client quote for");
    }

    // A6 — every leg must have a decision AND that decision must be APPROVED with a shortlisted
    // winner still on it. A leg with no decision at all (never shortlisted), a leg whose
    // decision exists but never reached APPROVED (e.g. still PENDING_APPROVAL), and one missing
    // a shortlistedQuoteId (structurally unreachable — approve() guarantees it — but the column
    // is nullable) all fail the same way — one gate, one message.
    const decisions = await this.prisma.legAwardDecision.findMany({ where: { queryId } });
    const decisionByLeg = new Map(decisions.map((d) => [d.legId, d]));
    for (const leg of legs) {
      const decision = decisionByLeg.get(leg.id);
      if (!decision || decision.status !== AwardDecisionStatus.APPROVED || !decision.shortlistedQuoteId) {
        throw new ConflictException("every leg must be approved before generating the client quote");
      }
    }

    // NO four-eyes gate here, deliberately (opus whole-branch review, task-4 Round 3 FIX #2 —
    // reverses a Round-2 fix that added one). Design §16 O4: "Generate = Manager+, NO extra
    // four-eyes" — per-leg four-eyes is already enforced at each leg's approve() via
    // requireDecidable below; generate is a query-wide rollup of decisions already vetted that
    // way, not a fresh decision that itself needs a second approver. `@Roles(ADMINISTRATOR,
    // MANAGER)` on the controller route is the only gate. reject()/approve() keep four-eyes —
    // unaffected by this.

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
          rfq: { select: { currency: true } },
        },
      });

      // Defensive (task-4 review MIN-1): the two lookups below are safe only by cross-request
      // invariant (a submitted, APPROVED quote always carries a draftJson with the shortlisted
      // variant's column priced). If that invariant is ever violated, fail clean (409) instead
      // of an unhandled TypeError (500) on a financial endpoint.
      if (!quote.draftJson) {
        throw new ConflictException("winning quote is not priceable");
      }
      const draft = quote.draftJson as unknown as QuoteDraft;
      const totals = computeQuoteTotals(draft);
      const variantKey = decision.shortlistedVariant ?? AIR_VARIANT_KEY;
      const vt = totals.variants.find((t) => t.key === variantKey);
      if (!vt) {
        throw new ConflictException("winning quote is not priceable");
      }
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
      // Re-round after summing already cents-rounded values (task-4 review IMP-2) — a Σ of
      // floats each individually rounded to 2dp can still land on a binary-float artifact (e.g.
      // 1000.10 + 500.25 + 233.33 === 1733.6799999999998), and this total is persisted verbatim
      // into the frozen, client-facing snapshot.
      combinedUsd: Math.round(winners.reduce((sum, w) => sum + w.usdTotal, 0) * 100) / 100,
    };

    // ONE transaction: freeze the snapshot, audit one GENERATE event per leg (the table's legId
    // is NOT-NULL with an FK — a single query-level/sentinel row is impossible; each carries its
    // own winner's quoteId/variant — task-4 review MIN-5 — mirroring how SHORTLIST/APPROVE
    // events record them), then recompute the query rollup INSIDE the same tx so it reads the
    // just-written awardSnapshot and persists QUOTING_CLIENT atomically. Deliberately no
    // `this.status.fire(...)` call — legs stay APPROVED (leg AWARDED is reserved for
    // post-client-Won, Stage 6); query status is a projection, never fire()'d.
    const winnerByLeg = new Map(winners.map((w) => [w.legId, w]));
    return this.prisma.$transaction(async (tx) => {
      await tx.query.update({
        where: { id: queryId },
        data: { awardSnapshot: awardSnapshot as unknown as Prisma.InputJsonValue },
      });
      for (const leg of legs) {
        const winner = winnerByLeg.get(leg.id)!;
        await tx.awardDecisionEvent.create({
          data: {
            legId: leg.id,
            queryId,
            type: "GENERATE",
            quoteId: winner.winningQuoteId,
            variant: winner.variant,
            actorId: user.userId,
          },
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
      // S5.8 Task 4 — the cost basis a quotation was priced from just disappeared above, so a
      // DRAFT can no longer be repriced (discard it) while an ISSUED version must survive only
      // as audit (supersede, never delete). Both before the projector recompute below so its
      // `issued > 0` count already reflects the supersede.
      await tx.quotation.updateMany({
        where: { queryId, status: "ISSUED" },
        data: { status: "SUPERSEDED" },
      });
      await tx.quotation.deleteMany({ where: { queryId, status: "DRAFT" } });
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
