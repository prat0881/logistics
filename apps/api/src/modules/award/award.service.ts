import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { AwardDecisionStatus, type LegAwardDecision } from "@prisma/client";
import {
  LegStatus,
  QuoteStatus,
  type SendForApprovalInput,
  type ShortlistInput,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import type { RequestUser } from "../auth/types";
import { ComparisonService } from "../comparison/comparison.service";

// Quote statuses that still might yield a NEW comparable price if we wait longer — the leg
// hasn't heard back (RFQ_SENT), is mid-negotiation (REQUOTED), or needs re-distribution
// (INVALID). Mirrors leg-quote.projector.ts's RESOLVED set (inverted) — kept as a small local
// literal rather than importing that module's internal constant across a module boundary.
const OUTSTANDING_QUOTE_STATUSES: readonly QuoteStatus[] = [
  QuoteStatus.RFQ_SENT,
  QuoteStatus.REQUOTED,
  QuoteStatus.INVALID,
];

// S5.4 Task 2 — the MAKER half of the maker-checker award workflow (design §9 steps 1+3;
// validation catalogue §13 A1/A2/A3/A9). The checker half (approve/reject) is Task 3 and,
// unlike this service, actually fires quote/leg status transitions via StatusService — a
// shortlist/send-for-approval is only ever a write to LegAwardDecision + an audit event.
@Injectable()
export class AwardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
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
}
