import { describe, it, expect } from "vitest";
import { computeQuoteTotals, computeHeavyWeightAmount, validateQuote, classifyWarehousePositions } from "./quote-engine";
import type { QuoteDraft } from "./quote";
import { AIR_CHARGE_PRESETS } from "./quote";
import type { ResolvedChargeLine } from "./charge-config";

// ── computeQuoteTotals / computeHeavyWeightAmount (Task 6) ──

const base = (over: Partial<QuoteDraft>): QuoteDraft => ({
  legId: "l", mode: "ROAD", currency: "USD", quoteValidityUntil: null,
  cargo: [{ packageId: "p", grossWtKg: 100, cbm: 1, chargedWeightKg: 250 }],
  charges: [{ zone: null, presetKey: null, label: "Tail lift", amount: 50 }],
  trucking: [], seaRates: [], warehouse: [{ warehousePointId: "w", position: "ORIGIN", label: "WH", amount: 30 }],
  transit: null, dgSurchargeNote: null, termsConditions: null, ...over,
});

describe("computeQuoteTotals", () => {
  it("computes one grand total per Road rate variant over a shared subtotal", () => {
    const t = computeQuoteTotals(base({ trucking: [
      { legEndpointPointId: "e", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: 500, rateVariant: "DEDICATED", tonnage: "T_5" },
      { legEndpointPointId: "e", truckingType: "GROUPAGE", basis: "PER_CBM", amount: 200, rateVariant: "GROUPAGE", tonnage: null },
    ] }));
    expect(t.sharedSubtotal).toBe(80); // 50 + 30
    expect(t.chargeableWeightKg).toBe(250);
    expect(t.variants).toEqual([
      { key: "DEDICATED", rateAmount: 500, grandTotal: 580 },
      { key: "GROUPAGE", rateAmount: 200, grandTotal: 280 },
    ]);
  });

  it("Air is a single AIR variant equal to the shared subtotal", () => {
    const t = computeQuoteTotals(base({ mode: "AIR", charges: [{ zone: "MAIN_FREIGHT", presetKey: null, label: "Air Freight", amount: 900 }] }));
    expect(t.variants).toEqual([{ key: "AIR", rateAmount: null, grandTotal: 930 }]); // 900 + 30 (default warehouse)
  });

  it("Sea produces one variant per sea rate (FCL/LCL), preserving an unfilled rate as null", () => {
    const t = computeQuoteTotals(base({
      mode: "SEA",
      seaRates: [
        { rateVariant: "FCL", containerSize: "TWENTY", amount: 700 },
        { rateVariant: "LCL", containerSize: null, amount: null },
      ],
    }));
    // sharedSubtotal = 50 (default charge) + 30 (default warehouse) = 80
    expect(t.sharedSubtotal).toBe(80);
    expect(t.variants).toEqual([
      { key: "FCL", rateAmount: 700, grandTotal: 780 },
      { key: "LCL", rateAmount: null, grandTotal: 80 },
    ]);
  });

  it("sums chargedWeightKg across cargo rows, treating a missing value as 0", () => {
    const t = computeQuoteTotals(base({
      cargo: [
        { packageId: "p1", grossWtKg: 50, cbm: 0.5, chargedWeightKg: 100 },
        { packageId: "p2", grossWtKg: 20, cbm: 0.2, chargedWeightKg: null },
      ],
    }));
    expect(t.chargeableWeightKg).toBe(100);
  });

  it("treats a null trucking amount as a 0 contribution to its variant's rate sum", () => {
    const t = computeQuoteTotals(base({
      charges: [], warehouse: [],
      trucking: [{ legEndpointPointId: "e", truckingType: "DEDICATED", basis: "FIXED", amount: null, rateVariant: "DEDICATED", tonnage: null }],
    }));
    expect(t.sharedSubtotal).toBe(0);
    expect(t.variants).toEqual([{ key: "DEDICATED", rateAmount: 0, grandTotal: 0 }]);
  });
});

describe("computeHeavyWeightAmount", () => {
  it("computes the Heavy-Weight excess amount", () => {
    expect(computeHeavyWeightAmount(1200, 1000, 2)).toBe(400);
    expect(computeHeavyWeightAmount(800, 1000, 2)).toBe(0);
  });
});

// ── validateQuote v2 submit-gate (Task 7) ──

const deadline = "2026-08-10T00:00:00.000Z";
const now = "2026-08-01T00:00:00.000Z";

function airOkDraft(): QuoteDraft {
  return {
    legId: "l1", mode: "AIR", currency: "USD", quoteValidityUntil: "2026-08-20T00:00:00.000Z",
    cargo: [{ packageId: "c1", grossWtKg: 1000, cbm: 2, chargedWeightKg: 1000 }],
    charges: AIR_CHARGE_PRESETS.map((p) => ({ zone: p.zone, definitionKey: p.presetKey, presetKey: p.presetKey, label: p.label, amount: 10 })),
    trucking: [], seaRates: [], warehouse: [],
    transit: { departureDate: "2026-08-12T00:00:00.000Z", arrivalDate: "2026-08-14T00:00:00.000Z", guaranteedTransitDays: 5 },
    dgSurchargeNote: null, termsConditions: null,
  };
}
const airActiveLines: ResolvedChargeLine[] = AIR_CHARGE_PRESETS.map(
  (p): ResolvedChargeLine => ({ definitionKey: p.presetKey, role: "CORE", inputType: "PLAIN", zone: p.zone, label: p.label }),
);

function roadOkDraft(): QuoteDraft {
  return {
    legId: "l1", mode: "ROAD", currency: "USD", quoteValidityUntil: "2026-08-20T00:00:00.000Z",
    cargo: [{ packageId: "c1", grossWtKg: 1000, cbm: 2, chargedWeightKg: 1000 }],
    charges: [],
    trucking: [{ legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: 500, rateVariant: "DEDICATED", tonnage: "T_5" }],
    seaRates: [], warehouse: [{ warehousePointId: "w1", position: "ORIGIN", label: "Warehousing (In/Out)", amount: 100 }],
    transit: { departureDate: null, arrivalDate: null, guaranteedTransitDays: 3, plannedPickupDate: "2026-08-11T00:00:00.000Z" },
    dgSurchargeNote: null, termsConditions: null,
  };
}

describe("validateQuote — happy paths", () => {
  it("passes a fully-priced single-variant Air quote", () => {
    expect(validateQuote(airOkDraft(), deadline, now, airActiveLines)).toHaveLength(0);
  });
  it("passes a fully-priced Road quote with only one of the two rates filled", () => {
    expect(validateQuote(roadOkDraft(), deadline, now, [])).toHaveLength(0);
  });
});

describe("validateQuote — Q_RATE (dual-rate: at least one of the two rates)", () => {
  it("blocks a Road leg with no trucking rate filled", () => {
    const d = roadOkDraft();
    d.trucking = [{ legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: null, rateVariant: "DEDICATED", tonnage: "T_5" }];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_RATE")).toBe(true);
  });
  it("blocks a Sea leg with neither FCL nor LCL rate filled", () => {
    const d = roadOkDraft();
    d.mode = "SEA"; d.trucking = [];
    d.seaRates = [
      { rateVariant: "FCL", containerSize: "TWENTY", amount: null },
      { rateVariant: "LCL", containerSize: null, amount: null },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_RATE")).toBe(true);
  });
  it("does not fire Q_RATE for Air (single-variant mode)", () => {
    const f = validateQuote(airOkDraft(), deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_RATE")).toBe(false);
  });
});

describe("validateQuote — Q_PRICED (active-line pricing, 0-needs-remark, warehouse)", () => {
  const oneActiveLine: ResolvedChargeLine[] = [
    { definitionKey: "ROAD_STD_INSURANCE", role: "STANDARD", inputType: "PLAIN", zone: null, label: "Insurance" },
  ];
  it("blocks an active PLAIN line that isn't priced at all", () => {
    const d = roadOkDraft();
    d.charges = [];
    const f = validateQuote(d, deadline, now, oneActiveLine);
    expect(f.some((x) => x.rule === "Q_PRICED" && x.message.includes("Insurance"))).toBe(true);
  });
  it("blocks a zero-amount active line unless it carries a remark", () => {
    const d = roadOkDraft();
    d.charges = [{ zone: null, definitionKey: "ROAD_STD_INSURANCE", presetKey: null, label: "Insurance", amount: 0 }];
    const f = validateQuote(d, deadline, now, oneActiveLine);
    expect(f.some((x) => x.rule === "Q_PRICED")).toBe(true);
  });
  it("passes a zero-amount active line when it carries a remark", () => {
    const d = roadOkDraft();
    d.charges = [{ zone: null, definitionKey: "ROAD_STD_INSURANCE", presetKey: null, label: "Insurance", amount: 0, note: "Waived — bulk client" }];
    const f = validateQuote(d, deadline, now, oneActiveLine);
    expect(f.some((x) => x.rule === "Q_PRICED")).toBe(false);
  });
  it("blocks a Heavy-Weight-Calc active line missing any of its three inputs", () => {
    const heavyLine: ResolvedChargeLine[] = [
      { definitionKey: "AIR_MAIN_HEAVY_WEIGHT", role: "CORE", inputType: "HEAVY_WEIGHT_CALC", zone: "MAIN_FREIGHT", label: "Heavy Weight Surcharge" },
    ];
    const d = airOkDraft();
    d.charges = [{
      zone: "MAIN_FREIGHT", definitionKey: "AIR_MAIN_HEAVY_WEIGHT", presetKey: null, label: "Heavy Weight Surcharge", amount: null,
      pieceWeightKg: 1200, airlineLimitKg: 1000, // ratePerExcessKg missing
    }];
    const f = validateQuote(d, deadline, now, heavyLine);
    expect(f.some((x) => x.rule === "Q_PRICED" && x.message.includes("Heavy-Weight"))).toBe(true);
  });
  it("passes a Heavy-Weight-Calc active line with all three inputs present", () => {
    const heavyLine: ResolvedChargeLine[] = [
      { definitionKey: "AIR_MAIN_HEAVY_WEIGHT", role: "CORE", inputType: "HEAVY_WEIGHT_CALC", zone: "MAIN_FREIGHT", label: "Heavy Weight Surcharge" },
    ];
    const d = airOkDraft();
    d.charges = [{
      zone: "MAIN_FREIGHT", definitionKey: "AIR_MAIN_HEAVY_WEIGHT", presetKey: null, label: "Heavy Weight Surcharge", amount: null,
      pieceWeightKg: 1200, airlineLimitKg: 1000, ratePerExcessKg: 2,
    }];
    const f = validateQuote(d, deadline, now, heavyLine);
    expect(f.some((x) => x.rule === "Q_PRICED")).toBe(false);
  });
  it("blocks an unpriced included warehouse line", () => {
    const d = roadOkDraft();
    d.warehouse = [{ warehousePointId: "w1", position: "ORIGIN", label: "Warehousing (In/Out)", amount: null }];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_PRICED" && x.message.includes("Warehousing"))).toBe(true);
  });
});

describe("validateQuote — Q_CUSTOM_REMARK (custom [+ Add Charge] lines)", () => {
  it("blocks a custom line without a remark", () => {
    const d = airOkDraft();
    d.charges = [{ zone: null, definitionKey: null, presetKey: null, label: "Ad-hoc handling", amount: 40 }];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_CUSTOM_REMARK")).toBe(true);
  });
  it("passes a custom line that carries a remark", () => {
    const d = airOkDraft();
    d.charges = [{ zone: null, definitionKey: null, presetKey: null, label: "Ad-hoc handling", amount: 40, note: "Client-requested crating" }];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_CUSTOM_REMARK")).toBe(false);
  });
});

describe("validateQuote — Q_TRANSIT (Guaranteed Transit Time mandatory)", () => {
  it("blocks a leg missing Guaranteed Transit Time", () => {
    const d = airOkDraft();
    d.transit = { ...d.transit!, guaranteedTransitDays: null };
    const f = validateQuote(d, deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_TRANSIT")).toBe(true);
  });
  it("blocks when transit is entirely absent", () => {
    const d = airOkDraft();
    d.transit = null;
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_TRANSIT")).toBe(true);
  });
});

describe("validateQuote — currency / validity / deadline", () => {
  it("Q_CURRENCY: fires alone when currency is absent", () => {
    const d = airOkDraft(); d.currency = null;
    expect(validateQuote(d, deadline, now, airActiveLines).map((f) => f.rule)).toEqual(["Q_CURRENCY"]);
  });
  it("Q_VALIDITY: fires alone (with field scope) when validity is absent", () => {
    const d = airOkDraft(); d.quoteValidityUntil = null;
    const f = validateQuote(d, deadline, now, airActiveLines).find((x) => x.rule === "Q_VALIDITY");
    expect(f?.scope).toEqual({ type: "field", id: "quoteValidityUntil" });
  });
  it("Q_VALIDITY: fires when validity is before the deadline", () => {
    const d = airOkDraft(); d.quoteValidityUntil = "2026-08-05T00:00:00.000Z";
    expect(validateQuote(d, deadline, now, airActiveLines).some((f) => f.rule === "Q_VALIDITY")).toBe(true);
  });
  it("Q_DEADLINE: fires alone when now is past the deadline", () => {
    expect(validateQuote(airOkDraft(), deadline, "2026-08-11T00:00:00.000Z", airActiveLines).map((f) => f.rule)).toEqual(["Q_DEADLINE"]);
  });
  it("Q_CURRENCY/Q_VALIDITY/Q_DEADLINE can all fire together", () => {
    const d = airOkDraft();
    d.currency = null;
    d.quoteValidityUntil = "2026-08-05T00:00:00.000Z"; // before the deadline
    const rules = validateQuote(d, deadline, "2026-08-11T00:00:00.000Z", airActiveLines).map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["Q_CURRENCY", "Q_VALIDITY", "Q_DEADLINE"]));
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
