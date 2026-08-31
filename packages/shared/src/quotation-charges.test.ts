import { describe, expect, it } from "vitest";
import { buildQuotationCostLines } from "./quotation-charges";
import type { QuoteDraft } from "./quote";

// Final review, deferred minor T1 M1 — this fixture used to carry `truckingType: "PICKUP"` and
// `basis: "PER_TRIP"`, NEITHER of which exists (`TruckingType = DEDICATED|GROUPAGE`,
// `TruckingBasis = PER_TRUCK|PER_CBM|PER_TON|FIXED`). It only compiled because of an
// `as QuoteDraft` cast that was suppressing a real type error, so the fixture could drift
// arbitrarily far from the shape production code actually receives. Real values now, and the cast
// is GONE — every field of `QuoteDraft` is spelled out so tsc checks this fixture for us.
const draft = (over: Partial<QuoteDraft> = {}): QuoteDraft => ({
  legId: "leg-1",
  mode: "ROAD",
  currency: "AED",
  quoteValidityUntil: null,
  chargedWeightKg: 500,
  notes: null,
  cargo: [],
  charges: [
    { zone: "ORIGIN", presetKey: null, label: "Terminal handling", amount: 820, rateVariant: null },
    { zone: "DESTINATION", presetKey: null, label: "Import clearance", amount: 460, rateVariant: null },
    { zone: null, presetKey: null, label: "Ad-hoc surcharge", amount: 100, rateVariant: null },
  ],
  trucking: [
    { legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: 2600, rateVariant: "DEDICATED", tonnage: null },
    { legEndpointPointId: "p2", truckingType: "GROUPAGE", basis: "PER_CBM", amount: 999, rateVariant: "GROUPAGE", tonnage: null },
  ],
  seaRates: [],
  warehouse: [{ warehousePointId: "w1", position: "PRE", label: "Shanghai Bonded WH", amount: 400 }],
  transit: null,
  dgSurchargeNote: null,
  termsConditions: null,
  ...over,
});

describe("buildQuotationCostLines", () => {
  it("groups by journey stage in a fixed order and omits empty groups", () => {
    const g = buildQuotationCostLines(draft(), "DEDICATED", "AED", 3.6725);
    expect(g.map((x) => x.group)).toEqual(["ORIGIN", "FREIGHT", "DESTINATION", "WAREHOUSE"]);
  });

  it("includes only the winning variant's freight rows", () => {
    const g = buildQuotationCostLines(draft(), "DEDICATED", "AED", 3.6725);
    const freight = g.find((x) => x.group === "FREIGHT")!;
    expect(freight.lines.map((l) => l.costNative)).toEqual([100, 2600]);
    expect(freight.lines.some((l) => l.costNative === 999)).toBe(false);
  });

  it("converts each line to USD with the supplied rate and sums the group", () => {
    const g = buildQuotationCostLines(draft(), "DEDICATED", "AED", 3.6725);
    const origin = g.find((x) => x.group === "ORIGIN")!;
    expect(origin.lines[0].costUsd).toBe(223.28);
    expect(origin.costUsd).toBe(223.28);
  });

  it("treats a null amount as zero rather than dropping the line", () => {
    const d = draft({ warehouse: [{ warehousePointId: "w1", position: "PRE", label: "WH", amount: null }] });
    const g = buildQuotationCostLines(d, "DEDICATED", "AED", 3.6725);
    expect(g.find((x) => x.group === "WAREHOUSE")!.lines[0].costUsd).toBe(0);
  });

  it("passes USD amounts through unconverted", () => {
    const g = buildQuotationCostLines(draft(), "DEDICATED", "USD", null);
    expect(g.find((x) => x.group === "ORIGIN")!.lines[0].costUsd).toBe(820);
  });

  it("gives every line a stable id unique within the leg", () => {
    const g = buildQuotationCostLines(draft(), "DEDICATED", "AED", 3.6725);
    const ids = g.flatMap((x) => x.lines.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  // 🔴 Final review CRITICAL #1. A HEAVY_WEIGHT_CALC charge carries `amount: null` BY
  // CONSTRUCTION — the real figure comes from its three calc inputs, folded by
  // `effectiveChargeAmount` (the same fold `computeQuoteTotals` used to produce
  // `awardSnapshot.usdTotal`). Reading `charge.amount` raw priced the whole surcharge at $0.00,
  // putting the quotation's cost BELOW the awarded cost and marking the client's price up from
  // the wrong base. max(0, 1200 − 500) × 4 = 2800 native.
  it("prices a HEAVY_WEIGHT_CALC line from its calc inputs, not from its (always null) amount", () => {
    const d = draft({
      charges: [
        {
          zone: "ORIGIN",
          presetKey: "HEAVY_WEIGHT_CALC",
          label: "Heavy weight surcharge",
          amount: null,
          rateVariant: null,
          pieceWeightKg: 1200,
          airlineLimitKg: 500,
          ratePerExcessKg: 4,
        },
      ],
    });

    const line = buildQuotationCostLines(d, "DEDICATED", "USD", null).find((x) => x.group === "ORIGIN")!
      .lines[0];
    expect(line.costNative).toBe(2800);
    expect(line.costUsd).toBe(2800);
  });

  it("converts a HEAVY_WEIGHT_CALC line's derived amount to USD like any other line", () => {
    const d = draft({
      charges: [
        {
          zone: null,
          presetKey: "HEAVY_WEIGHT_CALC",
          label: "Heavy weight surcharge",
          amount: null,
          rateVariant: null,
          pieceWeightKg: 800,
          airlineLimitKg: 500,
          ratePerExcessKg: 10,
        },
      ],
      trucking: [],
    });

    // max(0, 800 − 500) × 10 = 3000 AED / 3.6725 = 816.88 USD
    const freight = buildQuotationCostLines(d, "DEDICATED", "AED", 3.6725).find((x) => x.group === "FREIGHT")!;
    expect(freight.lines[0].costUsd).toBe(816.88);
    expect(freight.costUsd).toBe(816.88);
  });

  // Final review MINOR #10 — a non-USD leg with no usable rate used to price every line at `0`.
  // A silent $0 on a money path is worse than a loud failure.
  it("throws rather than pricing a non-USD leg at zero when no usable FX rate is supplied", () => {
    expect(() => buildQuotationCostLines(draft(), "DEDICATED", "AED", null)).toThrow(/FX rate/i);
    expect(() => buildQuotationCostLines(draft(), "DEDICATED", "AED", 0)).toThrow(/FX rate/i);
  });
});
