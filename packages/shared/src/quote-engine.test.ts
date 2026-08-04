import { describe, it, expect } from "vitest";
import { computeChargeableWeight, computeQuoteTotals, validateQuote, classifyWarehousePositions } from "./quote-engine";
import type { QuoteDraft } from "./quote";
import { AIR_CHARGE_PRESETS } from "./quote";
import type { ResolvedChargeLine } from "./charge-config";

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

describe("configured (zone=null) charges", () => {
  it("sums null-zone Road charges into configuredSubtotal + grandTotal", () => {
    const road: QuoteDraft = { ...base, mode: "ROAD",
      charges: [{ zone: null, definitionKey: "ROAD_STD_INSURANCE", presetKey: null, label: "Insurance", amount: 120 }],
      cargo: [{ cargoItemId: "c1", grossWtT: 1, cbm: 1, isDangerous: false, freightDensity: 333 }],
      trucking: [{ legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: 300 }] };
    const t = computeQuoteTotals(road);
    expect(t.configuredSubtotal).toBe(120);
    expect(t.grandTotal).toBe(420);
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

const deadline = "2026-08-10T00:00:00.000Z";
const now = "2026-08-01T00:00:00.000Z";
function validAir(): QuoteDraft {
  return {
    legId: "l1", mode: "AIR", currency: "USD", quoteValidityUntil: "2026-08-20T00:00:00.000Z",
    cargo: [{ cargoItemId: "c1", grossWtT: 1, cbm: 2, isDangerous: false, freightDensity: 167 }],
    // definitionKey mirrors presetKey here so this fixture doubles as a frozen mandatory-set draft (Task 2/4).
    charges: AIR_CHARGE_PRESETS.map((p) => ({ zone: p.zone, definitionKey: p.presetKey, presetKey: p.presetKey, label: p.label, amount: 10 })),
    trucking: [], warehouse: [],
    transit: { departureDate: "2026-08-12T00:00:00.000Z", arrivalDate: "2026-08-14T00:00:00.000Z" },
    dgSurchargeNote: null, termsConditions: null,
  };
}

// The frozen mandatory set standing in for validAir()'s Air presets (post-Task-4, Q1 is driven by this, not by
// AIR_CHARGE_PRESETS directly).
const mandatoryAirLines: ResolvedChargeLine[] = AIR_CHARGE_PRESETS.map(
  (p): ResolvedChargeLine => ({ definitionKey: p.presetKey, role: "CORE", inputType: "PLAIN", zone: p.zone, label: p.label }),
);

describe("validateQuote (§10.4 Q1–Q8)", () => {
  it("passes a complete Air quote", () => {
    expect(validateQuote(validAir(), deadline, now, mandatoryAirLines)).toEqual([]);
  });
  it("Q1: flags an unpriced mandatory Air line", () => {
    const d = validAir(); d.charges = d.charges.filter((c) => c.presetKey !== "AIR_MAIN_FREIGHT");
    expect(validateQuote(d, deadline, now, mandatoryAirLines).some((f) => f.rule === "Q1")).toBe(true);
  });
  it("Q2: flags a cargo row missing density", () => {
    const d = validAir(); d.cargo[0].freightDensity = null;
    const f = validateQuote(d, deadline, now).find((x) => x.rule === "Q2");
    expect(f?.scope).toEqual({ type: "cargo", id: "c1" });
  });
  it("Q3: validity before the deadline", () => {
    const d = validAir(); d.quoteValidityUntil = "2026-08-05T00:00:00.000Z";
    expect(validateQuote(d, deadline, now).some((f) => f.rule === "Q3")).toBe(true);
  });
  it("Q4/Q5/Q6/Q7: currency, DG note, transit dates, past-deadline", () => {
    const d = validAir(); d.currency = null; d.cargo[0].isDangerous = true; d.transit = null;
    const rules = validateQuote(d, deadline, "2026-08-11T00:00:00.000Z").map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["Q4", "Q5", "Q6", "Q7"]));
  });
  it("Q8: flags an unpriced warehouse line", () => {
    const d = validAir();
    d.warehouse = [{ warehousePointId: "w1", position: "ORIGIN", label: "Warehousing (In/Out)", amount: null }];
    expect(validateQuote(d, deadline, now).some((f) => f.rule === "Q8")).toBe(true);
  });
  it("Q1 (Road): flags an unpriced trucking block", () => {
    const d = validAir(); d.mode = "ROAD"; d.charges = [];
    d.trucking = [{ legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "FIXED", amount: null }];
    expect(validateQuote(d, deadline, now).some((f) => f.rule === "Q1")).toBe(true);
  });
  it("Q3: flags a missing (absent) validity", () => {
    const d = validAir(); d.quoteValidityUntil = null;
    const f = validateQuote(d, deadline, now).find((x) => x.rule === "Q3");
    expect(f?.scope).toEqual({ type: "field", id: "quoteValidityUntil" });
  });
  it("Q4: currency absent fires alone", () => {
    const d = validAir(); d.currency = null;
    expect(validateQuote(d, deadline, now).map((f) => f.rule)).toEqual(["Q4"]);
  });
  it("Q5: DG cargo without a note fires alone", () => {
    const d = validAir(); d.cargo[0].isDangerous = true;
    expect(validateQuote(d, deadline, now).map((f) => f.rule)).toEqual(["Q5"]);
  });
  it("Q6: a missing arrival date fires alone", () => {
    const d = validAir(); d.transit = { departureDate: "2026-08-12T00:00:00.000Z", arrivalDate: null };
    expect(validateQuote(d, deadline, now).map((f) => f.rule)).toEqual(["Q6"]);
  });
  it("Q7: past the deadline fires alone", () => {
    expect(validateQuote(validAir(), deadline, "2026-08-11T00:00:00.000Z").map((f) => f.rule)).toEqual(["Q7"]);
  });
});

describe("Q1 from the frozen mandatory set", () => {
  const mandatory: ResolvedChargeLine[] = [
    { definitionKey: "AIR_ORIGIN_THC", role: "CORE", inputType: "PLAIN", zone: "ORIGIN", label: "Origin THC" },
    { definitionKey: "AIR_DEST_THC", role: "STANDARD", inputType: "PLAIN", zone: "DESTINATION", label: "Dest THC" },
  ];
  const deadline = "2099-01-01T00:00:00.000Z";
  it("blocks when a mandatory configured line is unpriced", () => {
    const draft: QuoteDraft = { ...base,
      charges: [{ zone: "ORIGIN", definitionKey: "AIR_ORIGIN_THC", presetKey: null, label: "Origin THC", amount: 100 }] };
    const f = validateQuote(draft, deadline, "2020-01-01T00:00:00.000Z", mandatory);
    expect(f.some((x) => x.rule === "Q1" && x.message.includes("Dest THC"))).toBe(true);
  });
  it("passes when all mandatory lines are priced (0 allowed)", () => {
    const draft: QuoteDraft = { ...base,
      charges: [
        { zone: "ORIGIN", definitionKey: "AIR_ORIGIN_THC", presetKey: null, label: "Origin THC", amount: 0 },
        { zone: "DESTINATION", definitionKey: "AIR_DEST_THC", presetKey: null, label: "Dest THC", amount: 250 },
      ] };
    const f = validateQuote(draft, deadline, "2020-01-01T00:00:00.000Z", mandatory);
    expect(f.some((x) => x.rule === "Q1")).toBe(false);
  });
});

describe("classifyWarehousePositions (§6.4)", () => {
  it("labels warehouses before/after the main air carriage", () => {
    // WH(w1) → OriginAirport(a1) --AIR--> DestAirport(a2) → WH(w2)
    const legs = [
      { originPointId: "w1", destinationPointId: "a1", mode: "ROAD" as const },
      { originPointId: "a1", destinationPointId: "a2", mode: "AIR" as const },
      { originPointId: "a2", destinationPointId: "w2", mode: "ROAD" as const },
    ];
    expect(classifyWarehousePositions(legs, ["w1", "w2"])).toEqual({ w1: "ORIGIN", w2: "DESTINATION" });
  });
  it("Road-only: splits warehouses by the chain midpoint", () => {
    const legs = [
      { originPointId: "w1", destinationPointId: "m", mode: "ROAD" as const },
      { originPointId: "m", destinationPointId: "w2", mode: "ROAD" as const },
    ];
    expect(classifyWarehousePositions(legs, ["w1", "w2"])).toEqual({ w1: "ORIGIN", w2: "DESTINATION" });
  });
});
