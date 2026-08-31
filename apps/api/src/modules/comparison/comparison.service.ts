import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, LegAwardDecision, AwardDecisionEvent } from "@prisma/client";
import {
  QuoteStatus,
  computeQuoteTotals,
  variantsForMode,
  rateVariantLabel,
  AIR_VARIANT_KEY,
  transitKeyForVariant,
  recommendOffer,
  toUsd,
  latestRateByCurrency,
  orderLegsByRoute,
  type QuoteDraft,
  type ComparisonDto,
  type LegComparisonDto,
  type OfferDto,
  type OfferChargeLineDto,
  type PendingForwarderDto,
  type RecommendationDto,
  type RecommendOffer,
  type FxRateDto,
  type Priority,
  type AwardDecisionDto,
  type AwardDecisionEventDto,
  type QuoteVariantTotal,
  type QuoteTotals,
  type QueryAwardSnapshot,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { FxRatesService } from "../fx-rates/fx-rates.service";

const LEG_SELECT = {
  id: true,
  legCode: true,
  mode: true,
  // originPointId/destinationPointId (S5.9.3 Task 2 follow-up, P4) — the scalar FKs, needed
  // alongside the originPoint/destinationPoint relation selects below (display names) so
  // getComparison can route-order `awardSnapshot.legs` using the SAME shared `orderLegsByRoute`
  // topology sorter award.service.ts/quotation.service.ts already use, instead of a third,
  // subtly-different implementation.
  originPointId: true,
  destinationPointId: true,
  originPoint: { select: { name: true, city: true, country: true } },
  destinationPoint: { select: { name: true, city: true, country: true } },
} satisfies Prisma.LegSelect;
type LegRow = Prisma.LegGetPayload<{ select: typeof LEG_SELECT }>;

const QUOTE_SELECT = {
  id: true,
  legId: true,
  freightForwarderId: true,
  status: true,
  // S5.9.6 (register A6) — the OFFER, written by `FfPortalService.submit` alone. NOT `draftJson`:
  // that column is the forwarder's scratchpad, which `saveDraft` overwrites verbatim at any
  // writable status, so a half-typed edit on a reopened (REQUOTED) portal used to arrive here as
  // a ranked, approvable price nobody had offered.
  submittedJson: true,
  submittedAt: true,
  rfq: { select: { currency: true, quoteValidityUntil: true } },
} satisfies Prisma.QuoteSelect;
type QuoteRow = Prisma.QuoteGetPayload<{ select: typeof QUOTE_SELECT }>;

// S5.6: the maker-checker read model (decision + its audit timeline) — populated by the
// AwardService (S5.4/S5.5), read-only here. No `select` narrowing needed: both rows are small and
// every scalar column is used in the DTO mapping below (`findMany` without `select`/`include`
// already excludes the `leg`/`query` relations, so nothing extra comes along for the ride).
// Same "import the full model type directly" convention award.service.ts already uses.
type LegAwardDecisionRow = LegAwardDecision;
type AwardDecisionEventRow = AwardDecisionEvent;

// A quote is "comparable" (produces `OfferDto` rows, design §7/§11) once it has been submitted
// and carries a priceable draft. QUOTED is the normal, rankable case. REQUOTED is the DURABLE
// "awaiting a revised quote" state (a change-order re-ask): the FF's EARLIER price stays visible
// here but is excluded from RANKING — see buildRecommendation's filter and `awaitingReQuote`.
// PENDING_APPROVAL (S5.9 §4.4) is a QUOTED offer under review, not a different price.
// APPROVED and EXPIRED are S5.9.5 (design D8/D4):
//   APPROVED — the winning offer must not vanish from the grid the moment a checker approves it.
//     This is the same defect this list already fixed once for PENDING_APPROVAL.
//   EXPIRED  — a quote expiring out of REQUOTED has already submitted a price once, so an EXPIRED
//     quote can carry a real, submitted price. Admitting EXPIRED here is SELF-LIMITING:
//     `buildLeg` below skips any quote with no `submittedJson`, so an ordinary forwarder who never
//     submitted still produces no offer. Only one holding a real price does. (S5.9.6, register A6:
//     that gate used to be `draftJson`, which also admitted a never-submitted scratchpad.)
const COMPARABLE_STATUSES: readonly QuoteStatus[] = [
  QuoteStatus.QUOTED,
  QuoteStatus.REQUOTED,
  QuoteStatus.PENDING_APPROVAL,
  QuoteStatus.APPROVED,
  QuoteStatus.EXPIRED,
];
// FFs with NO comparable price at all — surfaced as "awaiting" in `pendingForwarders`. REQUOTED is
// deliberately NOT here (it always has an offer). EXPIRED IS in BOTH lists after S5.9.5, which is
// why `pendingForwarders` below subtracts the quotes that actually produced an offer rather than
// filtering on status alone — without that subtraction the same forwarder renders twice, once as a
// priced cell and once as a "Not quoted" cell.
const PENDING_STATUSES: readonly QuoteStatus[] = [
  QuoteStatus.RFQ_SENT,
  QuoteStatus.EXPIRED,
  QuoteStatus.INVALID,
  QuoteStatus.CLOSED,
];

const PRIORITY_LABEL: Record<Priority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

// Same convention as the Query List grid (queries.service.ts's inline `label`): city/country
// first, falling back to the point's own name. No single shared helper exists for this yet
// (rfq-notifications.service.ts uses the opposite, name-first precedence for its email tokens) —
// this mirrors the list-view convention since a comparison leg row is also a list/grid view.
function pointLabel(
  p: { name: string | null; city: string | null; country: string | null } | null,
): string {
  if (!p) return "";
  return [p.city, p.country].filter(Boolean).join(", ") || p.name || "";
}

// Prisma's generated enum (`AwardDecisionStatus`) is a const-object-derived string union carrying
// the exact same 4 literals as `AwardDecisionDto["status"]` — same precedent as `quoteStatus: q.status`
// below (Prisma `QuoteStatus` -> shared `QuoteStatus`), no cast needed.
function toAwardDecisionDto(d: LegAwardDecisionRow): AwardDecisionDto {
  return {
    legId: d.legId,
    status: d.status,
    shortlistedQuoteId: d.shortlistedQuoteId,
    shortlistedVariant: d.shortlistedVariant,
    recommendedQuoteId: d.recommendedQuoteId,
    recommendedVariant: d.recommendedVariant,
    overrideReason: d.overrideReason,
    rejectionReason: d.rejectionReason,
    sentByUserId: d.sentByUserId,
    sentForApprovalAt: d.sentForApprovalAt ? d.sentForApprovalAt.toISOString() : null,
    decidedByUserId: d.decidedByUserId,
    decidedAt: d.decidedAt ? d.decidedAt.toISOString() : null,
  };
}

function toAwardDecisionEventDto(e: AwardDecisionEventRow): AwardDecisionEventDto {
  return {
    id: e.id,
    legId: e.legId,
    type: e.type,
    quoteId: e.quoteId,
    variant: e.variant,
    reason: e.reason,
    actorId: e.actorId,
    at: e.at.toISOString(),
  };
}

@Injectable()
export class ComparisonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fxRates: FxRatesService,
  ) {}

  async getComparison(queryId: string): Promise<ComparisonDto> {
    const query = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { id: true, priority: true, awardSnapshot: true },
    });
    if (!query) throw new NotFoundException("Query not found");

    const [legs, quotes, rates, decisions, events] = await Promise.all([
      this.prisma.leg.findMany({ where: { queryId }, orderBy: { legCode: "asc" }, select: LEG_SELECT }),
      this.prisma.quote.findMany({
        where: { queryId },
        orderBy: [{ legId: "asc" }, { freightForwarderId: "asc" }],
        select: QUOTE_SELECT,
      }),
      this.fxRates.list(),
      this.prisma.legAwardDecision.findMany({ where: { queryId } }),
      this.prisma.awardDecisionEvent.findMany({ where: { queryId }, orderBy: { at: "asc" } }),
    ]);

    const ffIds = [...new Set(quotes.map((q) => q.freightForwarderId))];
    const ffs = ffIds.length
      ? await this.prisma.freightForwarder.findMany({
          where: { id: { in: ffIds } },
          select: { id: true, companyName: true },
        })
      : [];
    const ffNameById = new Map(ffs.map((f) => [f.id, f.companyName]));

    const ratesByCurrency = latestRateByCurrency(rates);
    // Display-only "as of" stamp: the latest effectiveFrom across every rate on file. Computed
    // via reduce (not "rates[0]") so this doesn't silently depend on FxRatesService.list()'s own
    // sort order staying descending.
    const fxAsOf = rates.reduce<string | null>(
      (max, r) => (max == null || r.effectiveFrom > max ? r.effectiveFrom : max),
      null,
    );

    const quotesByLeg = new Map<string, QuoteRow[]>();
    for (const q of quotes) {
      const arr = quotesByLeg.get(q.legId) ?? [];
      arr.push(q);
      quotesByLeg.set(q.legId, arr);
    }

    // At most one LegAwardDecision per leg (`@unique` on `legId`) — a plain by-legId map. Events
    // are append-only and many-per-leg, grouped in the `orderBy: { at: "asc" }` order queried above
    // so each leg's `timeline` is already chronological with no further sort needed.
    const decisionByLeg = new Map(decisions.map((d) => [d.legId, toAwardDecisionDto(d)]));
    const eventsByLeg = new Map<string, AwardDecisionEventDto[]>();
    for (const e of events) {
      const arr = eventsByLeg.get(e.legId) ?? [];
      arr.push(toAwardDecisionEventDto(e));
      eventsByLeg.set(e.legId, arr);
    }

    // 🔴 S5.9.3 final review — P4 was applied to `awardSnapshot.legs` below but NOT to this list,
    // so ONE screen showed two different leg sequences: the Compare Quotes accordion in `legCode`
    // order and the frozen-award panel on the same page in route order. Same canonical
    // `orderLegsByRoute` as `quotation.service.ts#toDto` and as the snapshot ordering below — no
    // third copy of the rule — and the same deterministic tiebreak, which here costs nothing extra:
    // the `legs` query above is already `orderBy: { legCode: "asc" }`, which is exactly the
    // pre-sort `orderLegsByRoute`'s disconnected-route fallback needs to be reproducible.
    // READ-ONLY, like the snapshot reorder: nothing is rewritten, so this heals on every read.
    const routeOrderedLegs = orderLegsByRoute(
      legs,
      (l) => l.originPointId,
      (l) => l.destinationPointId,
    );

    const legDtos: LegComparisonDto[] = routeOrderedLegs.map((leg) =>
      this.buildLeg(
        leg,
        quotesByLeg.get(leg.id) ?? [],
        ffNameById,
        ratesByCurrency,
        query.priority,
        decisionByLeg.get(leg.id) ?? null,
        eventsByLeg.get(leg.id) ?? [],
      ),
    );

    // Same "import the frozen JSON verbatim, no runtime re-validation" convention
    // award.service.ts's own generateClientQuote/reopenComparison already use for this column
    // (it's written once, by that same service, as `awardSnapshot as unknown as
    // Prisma.InputJsonValue` — read back the same way here rather than inventing a Zod schema for
    // a shape nothing else in the codebase parses defensively either).
    const awardSnapshot = query.awardSnapshot as unknown as QueryAwardSnapshot | null;

    // S5.9.3 Task 2 follow-up (P4, review Important) — `QuotingClientPanel` (Compare Quotes)
    // renders `awardSnapshot.legs` straight through with no reorder of its own, so a
    // pre-existing QUOTING_CLIENT query kept showing the pre-fix approval-order sequence there
    // until it was regenerated. Same render-time fix as `quotation.service.ts#toDto`, same
    // canonical `orderLegsByRoute` (no third copy of the ordering rule), same deterministic
    // leg-code tiebreak for a disconnected/ambiguous route: pre-sort by the winning leg's own
    // `legCode` (resolved via `legById`, built from the SAME `legs` query above — no extra round
    // trip) before handing it to the topology sorter. READ-ONLY: this reorders the in-memory DTO
    // returned to the caller; `query.awardSnapshot` itself is never rewritten, so an
    // already-frozen snapshot heals on every read without a migration, exactly like the
    // quotation path.
    const legById = new Map(legs.map((l) => [l.id, l]));
    const orderedAwardSnapshot: QueryAwardSnapshot | null = awardSnapshot
      ? {
          ...awardSnapshot,
          legs: orderLegsByRoute(
            [...awardSnapshot.legs].sort((a, b) =>
              (legById.get(a.legId)?.legCode ?? "").localeCompare(legById.get(b.legId)?.legCode ?? ""),
            ),
            (l) => legById.get(l.legId)?.originPointId ?? null,
            (l) => legById.get(l.legId)?.destinationPointId ?? null,
          ),
        }
      : null;

    // Review round 1 fix — reuse the SAME status-unfiltered `ffNameById` map built above (from
    // every quote on this query, `APPROVED` winners included) rather than a second query. This is
    // the one place a snapshot's `freightForwarderId` can be named without depending on that
    // forwarder happening to also appear in some OTHER leg's (COMPARABLE_STATUSES-filtered)
    // offers/pendingForwarders — see the `forwarderNames` doc comment on `ComparisonDto`.
    const forwarderNames = Object.fromEntries(ffNameById);

    return {
      queryId: query.id,
      priority: query.priority,
      fxAsOf,
      legs: legDtos,
      awardSnapshot: orderedAwardSnapshot,
      forwarderNames,
    };
  }

  private buildLeg(
    leg: LegRow,
    legQuotes: QuoteRow[],
    ffNameById: Map<string, string>,
    ratesByCurrency: Map<string, FxRateDto>,
    priority: Priority,
    decision: AwardDecisionDto | null,
    timeline: AwardDecisionEventDto[],
  ): LegComparisonDto {
    const offers: OfferDto[] = [];
    const submittedAtByQuote = new Map<string, string>();

    for (const q of legQuotes) {
      if (!COMPARABLE_STATUSES.includes(q.status)) continue;
      // S5.9.6 (A6) — the gate AND the priced value are both `submittedJson`, which is written
      // only by `FfPortalService.submit`. That is what makes "this quote produces an offer" mean
      // "this forwarder submitted this price", rather than "this forwarder has something saved".
      const submittedJson = q.submittedJson;
      if (!submittedJson) continue;
      const draft = submittedJson as unknown as QuoteDraft;

      const totals = computeQuoteTotals(draft);
      // The quote's OWN Rfq currency is the source of truth (upserted at FF-submit time) — not
      // draft.currency, which the read-first files call out as a separate, dedicated load.
      const currency = q.rfq?.currency ?? null;
      const rate = currency ? (ratesByCurrency.get(currency) ?? null) : null;
      submittedAtByQuote.set(
        q.id,
        q.submittedAt ? q.submittedAt.toISOString() : new Date(0).toISOString(),
      );

      for (const v of variantsForMode(draft.mode)) {
        const vt = totals.variants.find((t) => t.key === (v ?? AIR_VARIANT_KEY))!;
        const nativeTotal = vt.grandTotal;
        // Road/Sea: priced purely by their OWN freight rate. Air (or an unresolved mode): priced
        // if any common charge is on it — mirrors quote-engine.ts's isVariantPriced, kept local
        // here since it's read-only presentation, not an engine/submit-gating concern.
        const priced =
          vt.rateAmount != null ||
          (draft.mode !== "ROAD" && draft.mode !== "SEA" && totals.additionalChargeSum > 0);

        offers.push({
          quoteId: q.id,
          freightForwarderId: q.freightForwarderId,
          freightForwarderName: ffNameById.get(q.freightForwarderId) ?? "",
          variant: v,
          variantLabel: v ? rateVariantLabel(v) : "—",
          priced,
          nativeTotal,
          currency: currency ?? "",
          unitsPerUsd: rate?.unitsPerUsd ?? null,
          usdTotal: currency ? toUsd(nativeTotal, currency, rate) : null,
          transitDays:
            draft.transit?.guaranteedTransitDaysByVariant[transitKeyForVariant(draft.mode, v)] ??
            null,
          chargeableWeightKg: totals.chargeableWeightKg,
          validUntil: q.rfq?.quoteValidityUntil ? q.rfq.quoteValidityUntil.toISOString() : null,
          quoteStatus: q.status,
          charges: this.buildCharges(vt, totals, currency, rate),
        });
      }
    }

    // S5.9.5 — a quote id lands here only if it actually emitted at least one OfferDto above.
    // `offers` is (FF × variant), so one quote can contribute several entries; a Set collapses them.
    const offeredQuoteIds = new Set(offers.map((o) => o.quoteId));
    const pendingForwarders: PendingForwarderDto[] = legQuotes
      .filter((q) => PENDING_STATUSES.includes(q.status) && !offeredQuoteIds.has(q.id))
      .map((q) => ({
        freightForwarderId: q.freightForwarderId,
        freightForwarderName: ffNameById.get(q.freightForwarderId) ?? "",
        // S5.9.5 final review (MINOR) — the quote id an EXPIRED pending forwarder can be
        // re-asked through; see `PendingForwarderDto.quoteId` for why it is carried for all of
        // them, not just the expired ones.
        quoteId: q.id,
        quoteStatus: q.status,
      }));

    return {
      legId: leg.id,
      legCode: leg.legCode,
      mode: leg.mode,
      origin: pointLabel(leg.originPoint),
      destination: pointLabel(leg.destinationPoint),
      offers,
      pendingForwarders,
      awaitingReQuote: offers.some((o) => o.quoteStatus === QuoteStatus.REQUOTED),
      recommendation: this.buildRecommendation(offers, submittedAtByQuote, priority),
      decision,
      timeline,
    };
  }

  // Itemised per-offer breakdown (S5.6 §11/§12 click-FF-to-expand), derived from the SAME
  // computeQuoteTotals(draft) output the offer's own nativeTotal already uses — NOT a hand-rolled
  // re-parse of draft.charges/draft.warehouse. computeQuoteTotals only exposes totals grouped this
  // coarsely (one freight rate per variant + one common additional-charges sum + one common
  // warehouse sum — no origin/destination zone split), so that's the granularity emitted here;
  // Σ nativeAmount always reconciles to vt.grandTotal (= the offer's nativeTotal) by construction.
  private buildCharges(
    vt: QuoteVariantTotal,
    totals: QuoteTotals,
    currency: string | null,
    rate: FxRateDto | null,
  ): OfferChargeLineDto[] {
    const line = (group: string, label: string, nativeAmount: number): OfferChargeLineDto => ({
      group,
      label,
      nativeAmount,
      usdAmount: currency ? toUsd(nativeAmount, currency, rate) : null,
    });
    const lines: OfferChargeLineDto[] = [];
    // Road/Sea: this variant's own freight-rate cell. Air has none (variantRate is always null for
    // Air — its freight is folded into additionalChargeSum instead, see quote-engine.ts) so no
    // "freight" line is emitted there; that amount still surfaces below, inside "Additional Charges".
    if (vt.rateAmount != null) lines.push(line("freight", "Freight", vt.rateAmount));
    lines.push(line("additional", "Additional Charges", totals.additionalChargeSum));
    lines.push(line("warehouse", "Warehousing", totals.warehouseSum));
    return lines;
  }

  private buildRecommendation(
    offers: OfferDto[],
    submittedAtByQuote: Map<string, string>,
    priority: Priority,
  ): RecommendationDto | null {
    const candidates: RecommendOffer[] = offers
      // REQUOTED offers stay visible but are excluded from ranking: we have asked the forwarder to
      // replace this price and are still waiting, so recommending it now would be premature (design
      // §10.1). EXPIRED is admitted (S5.9.5 D4) for the mirror-image reason — the waiting is OVER and
      // the forwarder did not answer, so this IS their final price and it should be ranked.
      //
      // Consequence, accepted in the design and not a bug: the `★` can leave a forwarder when you
      // negotiate and return if they go silent. It only oscillates before a decision exists — once a
      // leg is sent for approval the mark reads the decision's frozen snapshot, not this function.
      //
      // APPROVED is still NOT ranked. An approved leg's recommendation is a matter of record, read
      // from the decision snapshot by the frontend row model, not re-derived live.
      .filter(
        (o) =>
          o.priced &&
          (o.quoteStatus === QuoteStatus.QUOTED || o.quoteStatus === QuoteStatus.EXPIRED),
      )
      .map((o) => ({
        quoteId: o.quoteId,
        variant: o.variant,
        usdTotal: o.usdTotal,
        transitDays: o.transitDays,
        submittedAt: submittedAtByQuote.get(o.quoteId) ?? new Date(0).toISOString(),
      }));

    const rec = recommendOffer({ priority, offers: candidates });
    if (!rec) return null;

    const winner = candidates.find((o) => o.quoteId === rec.quoteId && o.variant === rec.variant)!;
    // Same eligibility recommendOffer itself ranks over (excludes anything missing usdTotal/
    // transitDays) — reused here so "was it a tie" reflects the actual ranking pool.
    const rankable = candidates.filter((o) => o.usdTotal != null && o.transitDays != null);
    const speedFirst = priority === "HIGH" || priority === "URGENT";
    const tie = speedFirst
      ? rankable.filter((o) => o.transitDays === winner.transitDays).length > 1
      : rankable.filter((o) => o.usdTotal === winner.usdTotal).length > 1;
    const label = PRIORITY_LABEL[priority];

    const reason = speedFirst
      ? `${label} priority → fastest transit (${winner.transitDays} days)${tie ? "; price broke the tie" : ""}.`
      : `${label} priority → lowest price ($${winner.usdTotal} USD)${tie ? "; transit broke the tie" : ""}.`;

    return { quoteId: rec.quoteId, variant: rec.variant, reason };
  }
}
