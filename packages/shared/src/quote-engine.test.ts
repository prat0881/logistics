import { describe, it, expect } from "vitest";
import { computeChargeableWeight, computeQuoteTotals } from "./quote-engine";
import type { QuoteDraft } from "./quote";

const base: QuoteDraft = {
  legId: "l1", mode: "AIR", currency: "USD", quoteValidityUntil: null,
  cargo: [{ cargoItemId: "c1", grossWtT: 0.1, cbm: 5, isDangerous: false, freightDensity: 167 }],
  charges: [
    { zone: "ORIGIN", presetKey: "AIR_ORIGIN_THC", label: "Origin THC", amount: 100 },
    { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_FREIGHT", label: "Air Freight", amount: 500 },
    { zone: "DESTINATION", presetKey: "AIR_DEST_THC", label: "Dest THC", amount: 50 },
  ],
  trucking: [], warehouse: [], transit: null, dgSurchargeNote: null, termsConditions: null,
};

describe("computeQuoteTotals", () => {
  it("sums zone subtotals, total chargeable weight, and grand total (Air)", () => {
    const t = computeQuoteTotals(base);
    expect(t.zoneSubtotals).toEqual({ origin: 100, mainFreight: 500, destination: 50 });
    expect(t.totalChargeableWeightT).toBeCloseTo(0.835, 6); // 5×167/1000
    expect(t.grandTotal).toBe(650);
  });
  it("adds trucking + warehouse into the grand total (Road-only) and treats null amounts as 0", () => {
    const road: QuoteDraft = { ...base, mode: "ROAD", charges: [],
      cargo: [{ cargoItemId: "c1", grossWtT: 1, cbm: 1, isDangerous: false, freightDensity: null }],
      trucking: [{ legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: 300 }],
      warehouse: [{ warehousePointId: "w1", position: "ORIGIN", label: "Warehousing (In/Out)", amount: null }] };
    const t = computeQuoteTotals(road);
    expect(t.truckingSubtotal).toBe(300);
    expect(t.warehouseSubtotal).toBe(0);       // null amount → 0
    expect(t.totalChargeableWeightT).toBe(0);  // null density → 0 (not yet priced)
    expect(t.grandTotal).toBe(300);
  });
});

describe("computeChargeableWeight", () => {
  it("returns the gross weight when it exceeds the volumetric weight", () => {
    // 2 T gross, 1 m³ × 167 kg/CBM = 0.167 T volumetric ⇒ gross wins
    expect(computeChargeableWeight(2, 1, 167)).toBe(2);
  });
  it("returns the volumetric weight when it exceeds gross (Air 167)", () => {
    // 0.1 T gross, 5 m³ × 167 / 1000 = 0.835 T volumetric ⇒ volumetric wins
    expect(computeChargeableWeight(0.1, 5, 167)).toBeCloseTo(0.835, 6);
  });
  it("uses the mode density (Sea 1000 kg/CBM)", () => {
    expect(computeChargeableWeight(0.5, 2, 1000)).toBe(2); // 2×1000/1000 = 2 T
  });
});
