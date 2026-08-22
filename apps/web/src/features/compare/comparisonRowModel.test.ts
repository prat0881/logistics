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

  // ── S5.9.1 R1 — the recommendation OF RECORD. S5.9 T9 suppressed the `★` entirely the moment a
  // leg's decision left DRAFT, reasoning that `buildRecommendation` (comparison.service.ts) ranks
  // only QUOTED offers, so sending an offer for approval drops IT OUT of the live ranking and
  // `leg.recommendation` can shift to a NAME A DIFFERENT forwarder on the very next fetch. That
  // reasoning was right but the fix was wrong: it left a checker reviewing a sent leg with no
  // recommendation on screen at all. `AwardDecisionDto` already snapshots `recommendedQuoteId`/
  // `recommendedVariant` at send time (award.ts:52-60) — stable, and exactly what the maker was
  // judged against — so this suite now proves the model reads THAT once a decision exists, instead
  // of suppressing. `decision()` fully populates every `AwardDecisionDto` field (not the brief's
  // abbreviated partials) so `pnpm run typecheck` stays honest about what a real decision row
  // looks like.
  describe("reads the recommendation of record (S5.9.1 R1)", () => {
    const decision = (
      overrides: Partial<NonNullable<LegComparisonDto["decision"]>> = {},
    ): NonNullable<LegComparisonDto["decision"]> => ({
      legId: "l1",
      status: "DRAFT",
      shortlistedQuoteId: null,
      shortlistedVariant: null,
      recommendedQuoteId: null,
      recommendedVariant: null,
      overrideReason: null,
      rejectionReason: null,
      sentByUserId: null,
      sentForApprovalAt: null,
      decidedByUserId: null,
      decidedAt: null,
      ...overrides,
    });

    it("marks the SNAPSHOTTED recommendation once a leg has been sent for approval", () => {
      // The live ranking has moved on — q1 left QUOTED when it was sent, so `leg.recommendation`
      // (the live value) now names q2. The mark must still point at q1: what the decision snapshot
      // says, not what the engine currently ranks.
      const m = buildComparisonRowModel(
        {
          ...leg(
            [offer({}), offer({ quoteId: "q2", variant: "GROUPAGE", variantLabel: "Groupage" })],
            { quoteId: "q2", variant: "GROUPAGE", reason: "cheapest now" },
          ),
          decision: decision({
            status: "PENDING_APPROVAL",
            recommendedQuoteId: "q1",
            recommendedVariant: "DEDICATED",
            shortlistedQuoteId: "q1",
            shortlistedVariant: "DEDICATED",
          }),
        },
        false,
      );
      expect(m.recommendedKey).toBe(offerKey("q1", "DEDICATED"));
      expect(m.cells.find((c) => c.key === offerKey("q2", "GROUPAGE"))!.recommended).toBe(false);
    });

    it("falls back to the live recommendation when no decision exists yet", () => {
      const m = buildComparisonRowModel(
        {
          ...leg(
            [offer({}), offer({ quoteId: "q2", variant: "GROUPAGE", variantLabel: "Groupage" })],
            { quoteId: "q2", variant: "GROUPAGE", reason: "cheapest" },
          ),
          decision: null,
        },
        false,
      );
      expect(m.recommendedKey).toBe(offerKey("q2", "GROUPAGE"));
    });

    it("prefers the snapshot even on a DRAFT decision, so a returned leg keeps the mark it was judged against", () => {
      // A rejected leg comes back as DRAFT carrying a rejectionReason (award.service.ts's
      // REJECTED -> DRAFT rule) — the snapshot must win here too, not just for PENDING_APPROVAL.
      const m = buildComparisonRowModel(
        {
          ...leg(
            [offer({}), offer({ quoteId: "q2", variant: "GROUPAGE", variantLabel: "Groupage" })],
            { quoteId: "q2", variant: "GROUPAGE", reason: "cheapest now" },
          ),
          decision: decision({
            status: "DRAFT",
            rejectionReason: "too slow",
            recommendedQuoteId: "q1",
            recommendedVariant: "DEDICATED",
          }),
        },
        false,
      );
      expect(m.recommendedKey).toBe(offerKey("q1", "DEDICATED"));
    });

    it("still suppresses the recommendation entirely once the award is locked", () => {
      const m = buildComparisonRowModel(
        {
          ...leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "cheapest" }),
          decision: decision({
            status: "APPROVED",
            recommendedQuoteId: "q1",
            recommendedVariant: "DEDICATED",
          }),
        },
        true,
      );
      expect(m.recommendedKey).toBeNull();
      expect(m.cells[0].recommended).toBe(false);
    });

    it("says nothing when a decision exists but snapshotted no recommendation", () => {
      // The maker shortlisted with NOTHING recommended on offer — falling back to the (unrelated)
      // live value here would invent a recommendation after the fact and misrepresent the record.
      const m = buildComparisonRowModel(
        {
          ...leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "cheapest" }),
          decision: decision({
            status: "PENDING_APPROVAL",
            recommendedQuoteId: null,
            recommendedVariant: null,
          }),
        },
        false,
      );
      expect(m.recommendedKey).toBeNull();
      expect(m.cells[0].recommended).toBe(false);
    });
  });

  // ── S5.9.1 R1, Step 4 — the `★` mark's accessible name. `leg.recommendation.reason` is the LIVE
  // reason and, once a decision snapshot is in play, may describe a different offer entirely (the
  // whole point of the describe block above). `recommendedReason` is resolved in lock-step with
  // `recommendedKey` so a consumer never has to re-derive which source is in play.
  describe("recommendedReason — the mark's accessible-name text", () => {
    it("is the live recommendation's reason before any decision exists", () => {
      const m = buildComparisonRowModel(
        leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "fastest transit" }),
        false,
      );
      expect(m.recommendedReason).toBe("fastest transit");
    });

    it("falls back to a generic on-record sentence once a decision snapshot is in play, rather than reusing a reason that may no longer describe it", () => {
      const m = buildComparisonRowModel(
        {
          ...leg(
            [offer({}), offer({ quoteId: "q2", variant: "GROUPAGE", variantLabel: "Groupage" })],
            { quoteId: "q2", variant: "GROUPAGE", reason: "cheapest now" },
          ),
          decision: {
            legId: "l1",
            status: "PENDING_APPROVAL",
            shortlistedQuoteId: "q1",
            shortlistedVariant: "DEDICATED",
            recommendedQuoteId: "q1",
            recommendedVariant: "DEDICATED",
            overrideReason: null,
            rejectionReason: null,
            sentByUserId: "u1",
            sentForApprovalAt: "2026-08-14T09:00:00.000Z",
            decidedByUserId: null,
            decidedAt: null,
          },
        },
        false,
      );
      expect(m.recommendedReason).not.toBe("cheapest now");
      expect(m.recommendedReason).toMatch(/recommend/i);
    });

    it("is null when there is no recommendation to explain", () => {
      const m = buildComparisonRowModel(leg([offer({})]), false);
      expect(m.recommendedKey).toBeNull();
      expect(m.recommendedReason).toBeNull();
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
