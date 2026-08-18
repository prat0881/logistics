import { describe, expect, it } from "vitest";
import { buildQuotationCostLines } from "./quotation-charges";
import type { QuoteDraft } from "./quote";

const draft = (over: Partial<QuoteDraft> = {}): QuoteDraft => ({
  charges: [
    { zone: "ORIGIN", presetKey: null, label: "Terminal handling", amount: 820, rateVariant: null },
    { zone: "DESTINATION", presetKey: null, label: "Import clearance", amount: 460, rateVariant: null },
    { zone: null, presetKey: null, label: "Ad-hoc surcharge", amount: 100, rateVariant: null },
  ],
  trucking: [
    { legEndpointPointId: "p1", truckingType: "PICKUP", basis: "PER_TRIP", amount: 2600, rateVariant: "DEDICATED", tonnage: null },
    { legEndpointPointId: "p2", truckingType: "PICKUP", basis: "PER_TRIP", amount: 999, rateVariant: "GROUPAGE", tonnage: null },
  ],
  seaRates: [], warehouse: [{ warehousePointId: "w1", position: "PRE", label: "Shanghai Bonded WH", amount: 400 }],
  transit: null, dgSurchargeNote: null, termsConditions: null,
  ...over,
} as QuoteDraft);

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
    const d = draft({ warehouse: [{ warehousePointId: "w1", position: "PRE", label: "WH", amount: null }] } as Partial<QuoteDraft>);
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
});
