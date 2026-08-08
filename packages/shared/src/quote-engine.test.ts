import { describe, it, expect } from "vitest";
import {
  computeQuoteTotals,
  computeHeavyWeightAmount,
  validateQuote,
  classifyWarehousePositions,
} from "./quote-engine";
import { AIR_VARIANT_KEY, type QuoteDraft } from "./quote";
import type { ResolvedChargeLine } from "./charge-config";

// ── computeQuoteTotals v3: per-variant charge columns (FF Portal v3, Task 1 Step 1) ──
// Each rate variant is a full column: its own charge cells (grouped by `rateVariant`) + its own
// freight rate (trucking/seaRates row for that variant) + the one shared warehouse total.
// Chargeable weight is a single leg-level value (QuoteDraft.chargedWeightKg), not summed from cargo.
describe("computeQuoteTotals — v3 per-variant charge columns", () => {
  it("Road: each variant's grandTotal = its own charge column + its own trucking rate + shared warehouse", () => {
    const draft: QuoteDraft = {
      legId: "l1",
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: null,
      chargedWeightKg: 900,
      notes: null,
      cargo: [{ packageId: "p1", grossWtKg: 1000, cbm: 5 }],
      charges: [
        {
          zone: null,
          presetKey: null,
          definitionKey: "X",
          rateVariant: "DEDICATED",
          label: "X",
          amount: 100,
        },
        {
          zone: null,
          presetKey: null,
          definitionKey: "X",
          rateVariant: "GROUPAGE",
          label: "X",
          amount: 120,
        },
      ],
      trucking: [
        {
          legEndpointPointId: "e1",
          truckingType: "DEDICATED",
          basis: "PER_TRUCK",
          amount: 500,
          rateVariant: "DEDICATED",
          tonnage: "T_5",
        },
        {
          legEndpointPointId: "e1",
          truckingType: "GROUPAGE",
          basis: "PER_CBM",
          amount: 400,
          rateVariant: "GROUPAGE",
          tonnage: null,
        },
      ],
      seaRates: [],
      warehouse: [{ warehousePointId: "w1", position: "ORIGIN", label: "WH", amount: 50 }],
      transit: null,
      dgSurchargeNote: null,
      termsConditions: null,
    };

    const t = computeQuoteTotals(draft);

    expect(t.chargeableWeightKg).toBe(900);
    expect(t.variants.find((v) => v.key === "DEDICATED")?.grandTotal).toBe(650); // 100 + 500 + 50
    expect(t.variants.find((v) => v.key === "GROUPAGE")?.grandTotal).toBe(570); // 120 + 400 + 50
  });

  it("Air: single column grandTotal = Σ charges (incl. AIR_MAIN_FREIGHT) + shared warehouse", () => {
    const draft: QuoteDraft = {
      legId: "l1",
      mode: "AIR",
      currency: "USD",
      quoteValidityUntil: null,
      chargedWeightKg: 1000,
      notes: null,
      cargo: [{ packageId: "p1", grossWtKg: 1000, cbm: 2 }],
      charges: [
        {
          zone: "MAIN_FREIGHT",
          presetKey: null,
          definitionKey: "AIR_MAIN_FREIGHT",
          rateVariant: null,
          label: "Air Freight Charges",
          amount: 900,
        },
        {
          zone: "ORIGIN",
          presetKey: null,
          definitionKey: "AIR_ORIGIN_THC",
          rateVariant: null,
          label: "Origin THC",
          amount: 50,
        },
      ],
      trucking: [],
      seaRates: [],
      warehouse: [{ warehousePointId: "w1", position: "ORIGIN", label: "WH", amount: 30 }],
      transit: null,
      dgSurchargeNote: null,
      termsConditions: null,
    };

    const t = computeQuoteTotals(draft);

    expect(t.variants).toEqual([{ key: "AIR", rateAmount: null, grandTotal: 980 }]); // 900 + 50 + 30
  });
});

// ── computeQuoteTotals — additional v3 coverage (sharedSubtotal contract, fixed column counts,
// chargeableWeightKg defaulting, HEAVY_WEIGHT_CALC folding) ──

function emptyDraft(mode: QuoteDraft["mode"], over: Partial<QuoteDraft> = {}): QuoteDraft {
  return {
    legId: "l",
    mode,
    currency: "USD",
    quoteValidityUntil: null,
    chargedWeightKg: null,
    notes: null,
    cargo: [],
    charges: [],
    trucking: [],
    seaRates: [],
    warehouse: [],
    transit: null,
    dgSurchargeNote: null,
    termsConditions: null,
    ...over,
  };
}

describe("computeQuoteTotals — additional v3 coverage", () => {
  it("sharedSubtotal is the warehouse total only — charges are per-variant, not shared", () => {
    const t = computeQuoteTotals(
      emptyDraft("AIR", {
        charges: [
          {
            zone: "MAIN_FREIGHT",
            presetKey: null,
            rateVariant: null,
            label: "Air Freight",
            amount: 900,
          },
        ],
        warehouse: [{ warehousePointId: "w", position: "ORIGIN", label: "WH", amount: 30 }],
      }),
    );
    expect(t.sharedSubtotal).toBe(30); // warehouse only — the 900 charge is NOT shared
    expect(t.variants).toEqual([{ key: "AIR", rateAmount: null, grandTotal: 930 }]);
  });

  it("Sea always yields both FCL and LCL columns, even when only one seaRates row is given", () => {
    const t = computeQuoteTotals(
      emptyDraft("SEA", {
        seaRates: [{ rateVariant: "FCL", containerSize: "TWENTY", amount: 700 }], // no LCL row at all
        warehouse: [{ warehousePointId: "w", position: "ORIGIN", label: "WH", amount: 30 }],
      }),
    );
    expect(t.variants).toEqual([
      { key: "FCL", rateAmount: 700, grandTotal: 730 },
      { key: "LCL", rateAmount: null, grandTotal: 30 }, // untouched: its own (empty) charge column + warehouse
    ]);
  });

  it("Road always yields both Dedicated and Groupage columns, even when only one trucking row is given", () => {
    const t = computeQuoteTotals(
      emptyDraft("ROAD", {
        trucking: [
          {
            legEndpointPointId: "e",
            truckingType: "DEDICATED",
            basis: "FIXED",
            amount: null,
            rateVariant: "DEDICATED",
            tonnage: null,
          },
        ],
      }),
    );
    expect(t.variants).toEqual([
      { key: "DEDICATED", rateAmount: null, grandTotal: 0 },
      { key: "GROUPAGE", rateAmount: null, grandTotal: 0 },
    ]);
  });

  it("pricing a Road variant's trucking rate yields its numeric rateAmount", () => {
    const t = computeQuoteTotals(
      emptyDraft("ROAD", {
        trucking: [
          {
            legEndpointPointId: "e",
            truckingType: "DEDICATED",
            basis: "FIXED",
            amount: 500,
            rateVariant: "DEDICATED",
            tonnage: null,
          },
        ],
      }),
    );
    expect(t.variants.find((v) => v.key === "DEDICATED")).toEqual({
      key: "DEDICATED",
      rateAmount: 500,
      grandTotal: 500,
    });
  });

  it("chargeableWeightKg is the leg-level value, defaulting to 0 when unset", () => {
    expect(
      computeQuoteTotals(emptyDraft("ROAD", { chargedWeightKg: 900 })).chargeableWeightKg,
    ).toBe(900);
    expect(
      computeQuoteTotals(emptyDraft("ROAD", { chargedWeightKg: null })).chargeableWeightKg,
    ).toBe(0);
  });

  it("folds a HEAVY_WEIGHT_CALC line's derived amount into its variant's charge column (Air)", () => {
    // The calc line's own `amount` is null (the FF prices it via piece/limit/rate, not a flat
    // figure) — computeHeavyWeightAmount(1200, 1000, 2) = (1200-1000)*2 = 400 must still be
    // folded in, same as it is at ChargeLine-materialize time (ff-portal.service.ts).
    const t = computeQuoteTotals(
      emptyDraft("AIR", {
        charges: [
          {
            zone: "MAIN_FREIGHT",
            presetKey: null,
            rateVariant: null,
            label: "Air Freight",
            amount: 100,
          },
          {
            zone: "MAIN_FREIGHT",
            presetKey: null,
            definitionKey: "AIR_MAIN_HEAVY_WEIGHT",
            rateVariant: null,
            label: "Heavy Weight Surcharge",
            amount: null,
            pieceWeightKg: 1200,
            airlineLimitKg: 1000,
            ratePerExcessKg: 2,
          },
        ],
        warehouse: [{ warehousePointId: "w", position: "ORIGIN", label: "WH", amount: 30 }],
      }),
    );
    expect(t.sharedSubtotal).toBe(30); // warehouse only
    expect(t.variants).toEqual([{ key: "AIR", rateAmount: null, grandTotal: 530 }]); // 100 + 400 (derived) + 30
  });
});

describe("computeHeavyWeightAmount", () => {
  it("computes the Heavy-Weight excess amount", () => {
    expect(computeHeavyWeightAmount(1200, 1000, 2)).toBe(400);
    expect(computeHeavyWeightAmount(800, 1000, 2)).toBe(0);
  });
});

// ── validateQuote v3 submit-gate (design §3.2, Task 1 Step 5) ──

const deadline = "2026-08-10T00:00:00.000Z";
const now = "2026-08-01T00:00:00.000Z";

// v3 no longer ships a fixed AIR_CHARGE_PRESETS array from quote.ts (removed — dead per the
// Unit-6 review); the real catalogue is DB-seeded (ChargeLineDefinitionDto). Tests use a small
// representative stand-in.
const airActiveLines: ResolvedChargeLine[] = [
  {
    definitionKey: "AIR_ORIGIN_THC",
    role: "CORE",
    inputType: "PLAIN",
    zone: "ORIGIN",
    label: "Origin THC",
  },
  {
    definitionKey: "AIR_MAIN_FREIGHT",
    role: "CORE",
    inputType: "PLAIN",
    zone: "MAIN_FREIGHT",
    label: "Air Freight Charges",
  },
];

function airOkDraft(): QuoteDraft {
  return {
    legId: "l1",
    mode: "AIR",
    currency: "USD",
    quoteValidityUntil: "2026-08-20T00:00:00.000Z",
    chargedWeightKg: 1000,
    notes: null,
    cargo: [{ packageId: "c1", grossWtKg: 1000, cbm: 2 }],
    charges: airActiveLines.map((l) => ({
      zone: l.zone,
      definitionKey: l.definitionKey,
      presetKey: l.definitionKey,
      rateVariant: null,
      label: l.label,
      amount: 10,
    })),
    trucking: [],
    seaRates: [],
    warehouse: [],
    transit: {
      departureDate: "2026-08-12T00:00:00.000Z",
      arrivalDate: "2026-08-14T00:00:00.000Z",
      guaranteedTransitDaysByVariant: { [AIR_VARIANT_KEY]: 5 },
    },
    dgSurchargeNote: null,
    termsConditions: null,
  };
}

function roadOkDraft(): QuoteDraft {
  return {
    legId: "l1",
    mode: "ROAD",
    currency: "USD",
    quoteValidityUntil: "2026-08-20T00:00:00.000Z",
    chargedWeightKg: 1000,
    notes: null,
    cargo: [{ packageId: "c1", grossWtKg: 1000, cbm: 2 }],
    charges: [],
    trucking: [
      // GROUPAGE has no row at all here — an untouched column (design §3.2: left alone).
      {
        legEndpointPointId: "p1",
        truckingType: "DEDICATED",
        basis: "PER_TRUCK",
        amount: 500,
        rateVariant: "DEDICATED",
        tonnage: "T_5",
      },
    ],
    seaRates: [],
    warehouse: [
      { warehousePointId: "w1", position: "ORIGIN", label: "Warehousing (In/Out)", amount: 100 },
    ],
    transit: {
      departureDate: null,
      arrivalDate: null,
      guaranteedTransitDaysByVariant: { DEDICATED: 3 },
      plannedPickupDate: "2026-08-11T00:00:00.000Z",
    },
    dgSurchargeNote: null,
    termsConditions: null,
  };
}

describe("validateQuote — happy paths", () => {
  it("passes a fully-priced single-variant Air quote", () => {
    expect(validateQuote(airOkDraft(), deadline, now, airActiveLines)).toHaveLength(0);
  });
  it("passes a fully-priced Road quote with only one of the two variants filled — the untouched variant is left alone", () => {
    expect(validateQuote(roadOkDraft(), deadline, now, [])).toHaveLength(0);
  });
});

describe("validateQuote — Q_RATE (nothing priced in any column at all)", () => {
  it("blocks a Road leg where neither variant has anything priced", () => {
    const d = roadOkDraft();
    d.trucking = [
      {
        legEndpointPointId: "p1",
        truckingType: "DEDICATED",
        basis: "PER_TRUCK",
        amount: null,
        rateVariant: "DEDICATED",
        tonnage: "T_5",
      },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_RATE")).toBe(true);
  });
  it("blocks a Sea leg where neither FCL nor LCL has anything priced", () => {
    const d = roadOkDraft();
    d.mode = "SEA";
    d.trucking = [];
    d.seaRates = [
      { rateVariant: "FCL", containerSize: "TWENTY", amount: null },
      { rateVariant: "LCL", containerSize: null, amount: null },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_RATE")).toBe(true);
  });
  it("does not fire Q_RATE for Air once its charges are priced", () => {
    const f = validateQuote(airOkDraft(), deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_RATE")).toBe(false);
  });
  it("does not fire once a variant is started via a charge cell alone, with no trucking rate entered", () => {
    const d = roadOkDraft();
    d.trucking = [
      {
        legEndpointPointId: "p1",
        truckingType: "DEDICATED",
        basis: "PER_TRUCK",
        amount: null,
        rateVariant: "DEDICATED",
        tonnage: "T_5",
      },
    ];
    d.charges = [
      {
        zone: null,
        definitionKey: "X",
        presetKey: null,
        rateVariant: "DEDICATED",
        label: "X",
        amount: 20,
      },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_RATE")).toBe(false);
  });
});

describe("validateQuote — Q_PRICED (per-variant active-line pricing, 0-needs-remark, warehouse)", () => {
  const insuranceLine: ResolvedChargeLine[] = [
    {
      definitionKey: "ROAD_STD_INSURANCE",
      role: "STANDARD",
      inputType: "PLAIN",
      zone: null,
      label: "Insurance",
    },
  ];

  it("blocks a priced variant's active PLAIN line that isn't priced at all", () => {
    const d = roadOkDraft(); // DEDICATED priced via trucking; GROUPAGE untouched
    d.charges = [];
    const f = validateQuote(d, deadline, now, insuranceLine);
    const hits = f.filter((x) => x.rule === "Q_PRICED" && x.message.includes("Insurance"));
    expect(hits).toHaveLength(1); // only DEDICATED — GROUPAGE is untouched, left alone
    expect(hits[0].message).toContain("Dedicated");
  });

  it("does not require the same active line on an untouched variant", () => {
    const d = roadOkDraft();
    d.charges = [];
    const f = validateQuote(d, deadline, now, insuranceLine);
    expect(f.some((x) => x.rule === "Q_PRICED" && x.message.includes("Groupage"))).toBe(false);
  });

  it("blocks a zero-amount active line on a priced variant unless it carries a remark", () => {
    const d = roadOkDraft();
    d.charges = [
      {
        zone: null,
        definitionKey: "ROAD_STD_INSURANCE",
        presetKey: null,
        rateVariant: "DEDICATED",
        label: "Insurance",
        amount: 0,
      },
    ];
    const f = validateQuote(d, deadline, now, insuranceLine);
    expect(f.some((x) => x.rule === "Q_PRICED")).toBe(true);
  });

  it("passes a zero-amount active line when it carries a remark", () => {
    const d = roadOkDraft();
    d.charges = [
      {
        zone: null,
        definitionKey: "ROAD_STD_INSURANCE",
        presetKey: null,
        rateVariant: "DEDICATED",
        label: "Insurance",
        amount: 0,
        note: "Waived — bulk client",
      },
    ];
    const f = validateQuote(d, deadline, now, insuranceLine);
    expect(f.some((x) => x.rule === "Q_PRICED")).toBe(false);
  });

  it("blocks a Heavy-Weight-Calc active line missing any of its three inputs, on a priced variant", () => {
    const heavyLine: ResolvedChargeLine[] = [
      {
        definitionKey: "AIR_MAIN_HEAVY_WEIGHT",
        role: "CORE",
        inputType: "HEAVY_WEIGHT_CALC",
        zone: "MAIN_FREIGHT",
        label: "Heavy Weight Surcharge",
      },
    ];
    const d = airOkDraft();
    d.charges = [
      ...d.charges,
      {
        zone: "MAIN_FREIGHT",
        definitionKey: "AIR_MAIN_HEAVY_WEIGHT",
        presetKey: null,
        rateVariant: null,
        label: "Heavy Weight Surcharge",
        amount: null,
        pieceWeightKg: 1200,
        airlineLimitKg: 1000, // ratePerExcessKg missing
      },
    ];
    const f = validateQuote(d, deadline, now, [...airActiveLines, ...heavyLine]);
    expect(f.some((x) => x.rule === "Q_PRICED" && x.message.includes("Heavy-Weight"))).toBe(true);
  });

  it("passes a Heavy-Weight-Calc active line with all three inputs present", () => {
    const heavyLine: ResolvedChargeLine[] = [
      {
        definitionKey: "AIR_MAIN_HEAVY_WEIGHT",
        role: "CORE",
        inputType: "HEAVY_WEIGHT_CALC",
        zone: "MAIN_FREIGHT",
        label: "Heavy Weight Surcharge",
      },
    ];
    const d = airOkDraft();
    d.charges = [
      ...d.charges,
      {
        zone: "MAIN_FREIGHT",
        definitionKey: "AIR_MAIN_HEAVY_WEIGHT",
        presetKey: null,
        rateVariant: null,
        label: "Heavy Weight Surcharge",
        amount: null,
        pieceWeightKg: 1200,
        airlineLimitKg: 1000,
        ratePerExcessKg: 2,
      },
    ];
    const f = validateQuote(d, deadline, now, [...airActiveLines, ...heavyLine]);
    expect(f.some((x) => x.rule === "Q_PRICED" && x.message.includes("Heavy-Weight"))).toBe(false);
  });

  it("blocks an unpriced included warehouse line (shared, not per-variant)", () => {
    const d = roadOkDraft();
    d.warehouse = [
      { warehousePointId: "w1", position: "ORIGIN", label: "Warehousing (In/Out)", amount: null },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_PRICED" && x.message.includes("Warehousing"))).toBe(true);
  });
});

// ── Freight-required submit-gate (owner decision): freight is REQUIRED for a priced AIR & SEA
// variant, OPTIONAL for ROAD. Air's freight is the AIR_MAIN_FREIGHT charge line (gated by the
// Q_PRICED active-line loop, verified below); Sea's is its dedicated seaRates rate (this is the
// gap the rule closes); Road's trucking stays optional.
describe("validateQuote — freight required for priced SEA variants (Q_PRICED), optional for ROAD", () => {
  function seaDraft(): QuoteDraft {
    return {
      legId: "l1",
      mode: "SEA",
      currency: "USD",
      quoteValidityUntil: "2026-08-20T00:00:00.000Z",
      chargedWeightKg: 1000,
      notes: null,
      cargo: [{ packageId: "c1", grossWtKg: 1000, cbm: 2 }],
      charges: [
        // FCL is "priced" via a lone charge cell — the exact case isVariantPriced treats as
        // priced while the sea freight rate is still blank.
        {
          zone: "ORIGIN",
          definitionKey: "SEA_ORIGIN_THC",
          presetKey: null,
          rateVariant: "FCL",
          label: "Origin THC",
          amount: 50,
        },
      ],
      trucking: [],
      seaRates: [
        { rateVariant: "FCL", containerSize: null, amount: null },
        { rateVariant: "LCL", containerSize: null, amount: null },
      ],
      warehouse: [],
      transit: {
        departureDate: null,
        arrivalDate: null,
        guaranteedTransitDaysByVariant: { FCL: 12 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };
  }

  const seaThc: ResolvedChargeLine[] = [
    { definitionKey: "SEA_ORIGIN_THC", role: "CORE", inputType: "PLAIN", zone: "ORIGIN", label: "Origin THC" },
  ];

  it("blocks a priced SEA variant that has no sea-freight rate (leg scope → findingNav routes to charges)", () => {
    const f = validateQuote(seaDraft(), deadline, now, seaThc);
    const finding = f.find((x) => x.rule === "Q_PRICED" && x.message.includes("Sea Freight"));
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("FCL");
    expect(finding?.scope).toEqual({ type: "leg", id: "l1" }); // charges section, not warehouse
  });

  it("passes once the priced SEA variant's sea-freight rate is set", () => {
    const d = seaDraft();
    d.seaRates = [
      { rateVariant: "FCL", containerSize: "TWENTY", amount: 700 },
      { rateVariant: "LCL", containerSize: null, amount: null },
    ];
    const f = validateQuote(d, deadline, now, seaThc);
    expect(f.some((x) => x.message.includes("Sea Freight"))).toBe(false);
  });

  it("does not require the sea-freight rate on an UNTOUCHED SEA variant (LCL left alone)", () => {
    const d = seaDraft();
    d.seaRates = [
      { rateVariant: "FCL", containerSize: "TWENTY", amount: 700 },
      { rateVariant: "LCL", containerSize: null, amount: null },
    ];
    const f = validateQuote(d, deadline, now, seaThc);
    // FCL is the only priced variant; LCL is untouched → no Sea Freight finding for LCL.
    expect(f.some((x) => x.message.includes("Sea Freight") && x.message.includes("LCL"))).toBe(false);
  });

  it("does NOT require a trucking rate on a priced ROAD variant (freight optional for Road)", () => {
    const d = roadOkDraft();
    // DEDICATED priced via a charge cell only, its trucking rate left blank.
    d.trucking = [
      {
        legEndpointPointId: "p1",
        truckingType: "DEDICATED",
        basis: "PER_TRUCK",
        amount: null,
        rateVariant: "DEDICATED",
        tonnage: null,
      },
    ];
    d.charges = [
      { zone: null, definitionKey: "X", presetKey: null, rateVariant: "DEDICATED", label: "X", amount: 20 },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.message.includes("Road Freight"))).toBe(false);
    expect(f).toHaveLength(0); // fully valid: Road freight is optional
  });

  it("AIR: a priced Air variant still requires its AIR_MAIN_FREIGHT charge line (existing Q_PRICED — verified unchanged)", () => {
    const d = airOkDraft();
    const freightCell = d.charges.find((c) => c.definitionKey === "AIR_MAIN_FREIGHT")!;
    freightCell.amount = null; // unprice the air freight
    const f = validateQuote(d, deadline, now, airActiveLines);
    expect(
      f.some((x) => x.rule === "Q_PRICED" && x.message.includes("Air Freight Charges")),
    ).toBe(true);
  });
});

describe("validateQuote — Q_CUSTOM_REMARK (custom [+ Add Charge] lines)", () => {
  it("blocks a custom line without a remark", () => {
    const d = airOkDraft();
    d.charges = [
      {
        zone: null,
        definitionKey: null,
        presetKey: null,
        rateVariant: null,
        label: "Ad-hoc handling",
        amount: 40,
      },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_CUSTOM_REMARK")).toBe(true);
  });
  it("passes a custom line that carries a remark", () => {
    const d = airOkDraft();
    d.charges = [
      {
        zone: null,
        definitionKey: null,
        presetKey: null,
        rateVariant: null,
        label: "Ad-hoc handling",
        amount: 40,
        note: "Client-requested crating",
      },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_CUSTOM_REMARK")).toBe(false);
  });
});

describe("validateQuote — Q_WEIGHT (leg-level Charged Weight (kg))", () => {
  it("blocks when chargedWeightKg is null — Quote.chargedWeightKg is NOT NULL at materialize", () => {
    const d = airOkDraft();
    d.chargedWeightKg = null;
    const f = validateQuote(d, deadline, now, airActiveLines);
    const finding = f.find((x) => x.rule === "Q_WEIGHT");
    expect(finding).toBeDefined();
    expect(finding?.scope).toEqual({ type: "field", id: "chargedWeightKg" });
  });
  it("passes when chargedWeightKg is set", () => {
    const f = validateQuote(airOkDraft(), deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_WEIGHT")).toBe(false);
  });
});

describe("validateQuote — Q_CUSTOM_AMOUNT (custom [+ Add Charge] amount mandatory)", () => {
  it("blocks a custom line that has a remark but no amount — force-unwrapped at materialize", () => {
    const d = airOkDraft();
    d.charges = [
      {
        zone: null,
        definitionKey: null,
        presetKey: null,
        rateVariant: null,
        label: "Ad-hoc handling",
        amount: null,
        note: "Client-requested crating",
      },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_CUSTOM_AMOUNT")).toBe(true);
    expect(f.some((x) => x.rule === "Q_CUSTOM_REMARK")).toBe(false); // has a note — remark rule doesn't also fire
  });
  it("passes a custom line with both a remark and an amount", () => {
    const d = airOkDraft();
    d.charges = [
      {
        zone: null,
        definitionKey: null,
        presetKey: null,
        rateVariant: null,
        label: "Ad-hoc handling",
        amount: 40,
        note: "Client-requested crating",
      },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_CUSTOM_AMOUNT")).toBe(false);
  });
});

describe("validateQuote — Q_TRANSIT (Guaranteed Transit Time, per priced variant)", () => {
  it("blocks a priced variant missing its Guaranteed Transit Time", () => {
    const d = roadOkDraft(); // DEDICATED is the only priced variant
    d.transit = { ...d.transit!, guaranteedTransitDaysByVariant: {} };
    const f = validateQuote(d, deadline, now, []);
    const finding = f.find((x) => x.rule === "Q_TRANSIT");
    expect(finding).toBeDefined();
    expect(finding?.scope).toEqual({ type: "field", id: "guaranteedTransitDays" }); // keeps findingNav routing working
  });
  it("does not require transit-days for an untouched variant", () => {
    const d = roadOkDraft(); // GROUPAGE is untouched — transit only carries a DEDICATED entry
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_TRANSIT" && x.message.includes("Groupage"))).toBe(false);
  });
  it("blocks a priced Air leg when transit is entirely absent", () => {
    const d = airOkDraft();
    d.transit = null;
    const f = validateQuote(d, deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_TRANSIT")).toBe(true);
  });
  it("blocks a priced Air leg when the transit block exists but has no entry under Air's key (AIR_VARIANT_KEY) — distinct from transit being entirely absent above", () => {
    const d = airOkDraft();
    d.transit = { ...d.transit!, guaranteedTransitDaysByVariant: {} };
    const f = validateQuote(d, deadline, now, airActiveLines);
    const finding = f.find((x) => x.rule === "Q_TRANSIT");
    expect(finding).toBeDefined();
    expect(finding?.scope).toEqual({ type: "field", id: "guaranteedTransitDays" });
  });
  it("passes a fully-priced Air leg with its Guaranteed Transit Time set under AIR_VARIANT_KEY", () => {
    const f = validateQuote(airOkDraft(), deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_TRANSIT")).toBe(false);
  });
});

describe("validateQuote — currency / validity / deadline", () => {
  it("Q_CURRENCY: fires alone when currency is absent", () => {
    const d = airOkDraft();
    d.currency = null;
    expect(validateQuote(d, deadline, now, airActiveLines).map((f) => f.rule)).toEqual([
      "Q_CURRENCY",
    ]);
  });
  it("Q_VALIDITY: fires alone (with field scope) when validity is absent", () => {
    const d = airOkDraft();
    d.quoteValidityUntil = null;
    const f = validateQuote(d, deadline, now, airActiveLines).find((x) => x.rule === "Q_VALIDITY");
    expect(f?.scope).toEqual({ type: "field", id: "quoteValidityUntil" });
  });
  it("Q_VALIDITY: fires when validity is before the deadline", () => {
    const d = airOkDraft();
    d.quoteValidityUntil = "2026-08-05T00:00:00.000Z";
    expect(
      validateQuote(d, deadline, now, airActiveLines).some((f) => f.rule === "Q_VALIDITY"),
    ).toBe(true);
  });
  it("Q_DEADLINE: fires alone when now is past the deadline", () => {
    expect(
      validateQuote(airOkDraft(), deadline, "2026-08-11T00:00:00.000Z", airActiveLines).map(
        (f) => f.rule,
      ),
    ).toEqual(["Q_DEADLINE"]);
  });
  it("Q_CURRENCY/Q_VALIDITY/Q_DEADLINE can all fire together", () => {
    const d = airOkDraft();
    d.currency = null;
    d.quoteValidityUntil = "2026-08-05T00:00:00.000Z"; // before the deadline
    const rules = validateQuote(d, deadline, "2026-08-11T00:00:00.000Z", airActiveLines).map(
      (f) => f.rule,
    );
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
    expect(classifyWarehousePositions(legs, ["w1", "w2"])).toEqual({
      w1: "ORIGIN",
      w2: "DESTINATION",
    });
  });
  it("Road-only: splits warehouses by the chain midpoint", () => {
    const legs = [
      { originPointId: "w1", destinationPointId: "m", mode: "ROAD" as const },
      { originPointId: "m", destinationPointId: "w2", mode: "ROAD" as const },
    ];
    expect(classifyWarehousePositions(legs, ["w1", "w2"])).toEqual({
      w1: "ORIGIN",
      w2: "DESTINATION",
    });
  });
});
