import { describe, expect, it } from "vitest";
import { buildComparisonRowModel, METRICS, offerKey } from "./comparisonRowModel";
import type { LegComparisonDto, OfferDto } from "@svyft/shared";

const offer = (o: Partial<OfferDto>): OfferDto => ({
  quoteId: "q1", freightForwarderId: "ff1", freightForwarderName: "Bridge",
  variant: "DEDICATED", variantLabel: "Dedicated", priced: true,
  nativeTotal: 6700, currency: "AED", unitsPerUsd: 3.6725, usdTotal: 1824.37,
  transitDays: 3, chargeableWeightKg: 100, validUntil: "2026-09-16T00:00:00.000Z",
  quoteStatus: "QUOTED", charges: [], ...o,
});

const leg = (offers: OfferDto[], recommendation: LegComparisonDto["recommendation"] = null) =>
  ({ legId: "l1", legCode: "L1", mode: "ROAD", origin: "A", destination: "B",
     offers, pendingForwarders: [], awaitingReQuote: false,
     recommendation, decision: null, timeline: [] }) as LegComparisonDto;

describe("buildComparisonRowModel", () => {
  it("groups a forwarder's variants under one group", () => {
    const m = buildComparisonRowModel(
      leg([offer({}), offer({ variant: "GROUPAGE", variantLabel: "Groupage" })]), false);
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0].freightForwarderName).toBe("Bridge");
    expect(m.groups[0].cells).toHaveLength(2);
    expect(m.cells).toHaveLength(2);
  });

  it("marks the recommended cell by (quoteId, variant)", () => {
    const m = buildComparisonRowModel(
      leg([offer({}), offer({ variant: "GROUPAGE", variantLabel: "Groupage" })]),
      false);
    expect(m.recommendedKey).toBeNull();

    const withRec = buildComparisonRowModel(
      leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "fastest" }), false);
    expect(withRec.recommendedKey).toBe(offerKey("q1", "DEDICATED"));
    expect(withRec.cells[0].recommended).toBe(true);
  });

  it("suppresses the recommendation entirely when locked", () => {
    const m = buildComparisonRowModel(
      leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "fastest" }), true);
    expect(m.recommendedKey).toBeNull();
    expect(m.cells[0].recommended).toBe(false);
  });

  // ── S5.9 T9 — buildRecommendation (comparison.service.ts) ranks only QUOTED offers, so sending
  // an offer for approval drops IT OUT of the ranking and `leg.recommendation` can shift to a
  // different forwarder on the very next fetch: the `★` would then point at an offer the leg did
  // not actually select, exactly while a checker is reviewing. Suppress the same way `locked`
  // already does post-generate, one lifecycle stage earlier — once the decision leaves DRAFT.
  describe("suppresses the recommendation once the leg's decision has left DRAFT", () => {
    const rec = { quoteId: "q1", variant: "DEDICATED" as const, reason: "fastest" };
    const decision = (
      status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED",
    ): NonNullable<LegComparisonDto["decision"]> => ({
      legId: "l1",
      status,
      shortlistedQuoteId: "q1",
      shortlistedVariant: "DEDICATED",
      recommendedQuoteId: "q1",
      recommendedVariant: "DEDICATED",
      overrideReason: null,
      rejectionReason: null,
      sentByUserId: null,
      sentForApprovalAt: null,
      decidedByUserId: null,
      decidedAt: null,
    });

    it("keeps the recommendation while the decision is still DRAFT", () => {
      const m = buildComparisonRowModel({ ...leg([offer({})], rec), decision: decision("DRAFT") }, false);
      expect(m.recommendedKey).toBe(offerKey("q1", "DEDICATED"));
      expect(m.cells[0].recommended).toBe(true);
    });

    it("keeps the recommendation when nothing has been shortlisted yet (decision is null)", () => {
      const m = buildComparisonRowModel({ ...leg([offer({})], rec), decision: null }, false);
      expect(m.recommendedKey).toBe(offerKey("q1", "DEDICATED"));
    });

    it("suppresses it once PENDING_APPROVAL", () => {
      const m = buildComparisonRowModel(
        { ...leg([offer({})], rec), decision: decision("PENDING_APPROVAL") },
        false,
      );
      expect(m.recommendedKey).toBeNull();
      expect(m.cells[0].recommended).toBe(false);
    });

    it("suppresses it once APPROVED", () => {
      const m = buildComparisonRowModel({ ...leg([offer({})], rec), decision: decision("APPROVED") }, false);
      expect(m.recommendedKey).toBeNull();
      expect(m.cells[0].recommended).toBe(false);
    });
  });

  it("renders the conversion rate metric, and an em-dash when absent", () => {
    const rate = METRICS.find((x) => x.id === "rate")!;
    const m = buildComparisonRowModel(leg([offer({}), offer({ quoteId: "q2", unitsPerUsd: null, variant: "GROUPAGE" })]), false);
    expect(rate.render(m.cells[0])).toBe("3.67250");
    expect(rate.render(m.cells[1])).toBe("—");
  });

  it("never renders a money figure for an unpriced offer", () => {
    const usd = METRICS.find((x) => x.id === "usdTotal")!;
    const m = buildComparisonRowModel(leg([offer({ priced: false, usdTotal: null, nativeTotal: 0 })]), false);
    expect(usd.render(m.cells[0])).toBe("—");
    expect(usd.render(m.cells[0])).not.toContain("$0");
  });

  // ── S5.9 T8, product item 1 — the product owner's exact column order. Both grid orientations
  // read this one array (columns view's row labels, rows view's column headers), so pinning the
  // order here is what keeps them from drifting apart.
  it("orders the metrics as the product owner specified", () => {
    expect(METRICS.map((m) => m.label)).toEqual([
      "Total (native)",
      "Rate (per USD)",
      "Total (USD)",
      "Transit",
      "Valid until",
    ]);
  });
});
