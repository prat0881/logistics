import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
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
  type QuoteDraft,
  type ComparisonDto,
  type LegComparisonDto,
  type OfferDto,
  type PendingForwarderDto,
  type RecommendationDto,
  type RecommendOffer,
  type FxRateDto,
  type Priority,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { FxRatesService } from "../fx-rates/fx-rates.service";

const LEG_SELECT = {
  id: true,
  legCode: true,
  mode: true,
  originPoint: { select: { name: true, city: true, country: true } },
  destinationPoint: { select: { name: true, city: true, country: true } },
} satisfies Prisma.LegSelect;
type LegRow = Prisma.LegGetPayload<{ select: typeof LEG_SELECT }>;

const QUOTE_SELECT = {
  id: true,
  legId: true,
  freightForwarderId: true,
  status: true,
  draftJson: true,
  submittedAt: true,
  rfq: { select: { currency: true, quoteValidityUntil: true } },
} satisfies Prisma.QuoteSelect;
type QuoteRow = Prisma.QuoteGetPayload<{ select: typeof QUOTE_SELECT }>;

// A quote is "comparable" (produces `OfferDto` rows, design §7/§11) once it has been submitted
// and carries a priceable draft — QUOTED is the normal case; REQUOTED (a change-order re-ask;
// not yet wired to any transition as of S5.2) keeps its LAST submitted bid comparable until a
// fresh one lands.
const COMPARABLE_STATUSES: readonly QuoteStatus[] = [QuoteStatus.QUOTED, QuoteStatus.REQUOTED];
// FFs with no CURRENT comparable submission — surfaced as "awaiting" (pendingForwarders) rather
// than in `offers`. Note REQUOTED can legitimately land in BOTH lists: a quote that still carries
// a stale-but-usable draft shows as an offer (the last-known bid) while also flagging here that a
// fresh submission is awaited; SELECT (not yet sent) and APPROVED (already awarded) appear in
// neither list.
const PENDING_STATUSES: readonly QuoteStatus[] = [
  QuoteStatus.RFQ_SENT,
  QuoteStatus.REQUOTED,
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

@Injectable()
export class ComparisonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fxRates: FxRatesService,
  ) {}

  async getComparison(queryId: string): Promise<ComparisonDto> {
    const query = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { id: true, priority: true },
    });
    if (!query) throw new NotFoundException("Query not found");

    const [legs, quotes, rates] = await Promise.all([
      this.prisma.leg.findMany({ where: { queryId }, orderBy: { legCode: "asc" }, select: LEG_SELECT }),
      this.prisma.quote.findMany({
        where: { queryId },
        orderBy: [{ legId: "asc" }, { freightForwarderId: "asc" }],
        select: QUOTE_SELECT,
      }),
      this.fxRates.list(),
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

    const legDtos: LegComparisonDto[] = legs.map((leg) =>
      this.buildLeg(leg, quotesByLeg.get(leg.id) ?? [], ffNameById, ratesByCurrency, query.priority),
    );

    return { queryId: query.id, priority: query.priority, fxAsOf, legs: legDtos };
  }

  private buildLeg(
    leg: LegRow,
    legQuotes: QuoteRow[],
    ffNameById: Map<string, string>,
    ratesByCurrency: Map<string, FxRateDto>,
    priority: Priority,
  ): LegComparisonDto {
    const offers: OfferDto[] = [];
    const submittedAtByQuote = new Map<string, string>();

    for (const q of legQuotes) {
      if (!COMPARABLE_STATUSES.includes(q.status)) continue;
      const draftJson = q.draftJson;
      if (!draftJson) continue;
      const draft = draftJson as unknown as QuoteDraft;

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
        });
      }
    }

    const pendingForwarders: PendingForwarderDto[] = legQuotes
      .filter((q) => PENDING_STATUSES.includes(q.status))
      .map((q) => ({
        freightForwarderId: q.freightForwarderId,
        freightForwarderName: ffNameById.get(q.freightForwarderId) ?? "",
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
      recommendation: this.buildRecommendation(offers, submittedAtByQuote, priority),
    };
  }

  private buildRecommendation(
    offers: OfferDto[],
    submittedAtByQuote: Map<string, string>,
    priority: Priority,
  ): RecommendationDto | null {
    const candidates: RecommendOffer[] = offers
      .filter((o) => o.priced)
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
