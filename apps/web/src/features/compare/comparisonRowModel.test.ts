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
});
