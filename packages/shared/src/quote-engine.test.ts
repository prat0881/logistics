import { describe, it, expect } from "vitest";
import {
  computeQuoteTotals,
  computeHeavyWeightAmount,
  validateQuote,
  classifyWarehousePositions,
} from "./quote-engine";
import { AIR_VARIANT_KEY, SEA_VARIANT_KEY, type QuoteDraft } from "./quote";
import type { ResolvedChargeLine } from "./charge-config";

// ── computeQuoteTotals v4 (partially reverses v3): charges are COMMON — one `additionalChargeSum`
// folded into EVERY variant's grandTotal equally; freight (trucking/seaRates) stays per-variant.
// grandTotal(v) = variantFreight(v) + additionalChargeSum + warehouseSum.
describe("computeQuoteTotals — v4 (common charges, per-variant freight)", () => {
  it("Road: additionalChargeSum is one number, folded identically into every variant's own freight + warehouse (Step 1a)", () => {
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
          definitionKey: "DOC",
          rateVariant: null,
          label: "Documentation",
          amount: 150,
        },
        {
          zone: null,
          presetKey: null,
          definitionKey: "CUSTOMS",
          rateVariant: null,
          label: "Customs",
          amount: 300,
        },
      ],
      trucking: [
        {
          legEndpointPointId: "e1",
          truckingType: "DEDICATED",
          basis: "PER_TRUCK",
          amount: 4200,
          rateVariant: "DEDICATED",
          tonnage: "T_5",
        },
        {
          legEndpointPointId: "e1",
          truckingType: "GROUPAGE",
          basis: "PER_CBM",
          amount: 3800,
          rateVariant: "GROUPAGE",
          tonnage: null,
        },
      ],
      seaRates: [],
      warehouse: [{ warehousePointId: "w1", position: "ORIGIN", label: "WH", amount: 0 }],
      transit: null,
      dgSurchargeNote: null,
      termsConditions: null,
    };

    const t = computeQuoteTotals(draft);

    expect(t.additionalChargeSum).toBe(450); // 150 + 300, ONE sum — no more per-variant grouping
    expect(t.warehouseSum).toBe(0);
    expect(t.variants.find((v) => v.key === "DEDICATED")?.grandTotal).toBe(4650); // 4200 + 450 + 0
    expect(t.variants.find((v) => v.key === "GROUPAGE")?.grandTotal).toBe(4250); // 3800 + 450 + 0
  });

  it("Air: single column grandTotal = additionalChargeSum (incl. AIR_MAIN_FREIGHT, since Air's freight is just another common charge) + warehouseSum", () => {
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

    expect(t.additionalChargeSum).toBe(950); // 900 + 50 — Air has no separate freight rate cell
    expect(t.warehouseSum).toBe(30);
    expect(t.variants).toEqual([{ key: "AIR", rateAmount: null, grandTotal: 980 }]); // 0 + 950 + 30
  });
});

// ── computeQuoteTotals — additional v4 coverage (additionalChargeSum/warehouseSum contract, fixed
// column counts, chargeableWeightKg defaulting, HEAVY_WEIGHT_CALC folding) ──

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

describe("computeQuoteTotals — additional v4 coverage", () => {
  it("warehouseSum and additionalChargeSum are exposed separately, both folded into the (single) variant's grandTotal", () => {
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
    expect(t.warehouseSum).toBe(30);
    expect(t.additionalChargeSum).toBe(900);
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
      { key: "LCL", rateAmount: null, grandTotal: 30 }, // untouched: no freight of its own + warehouse
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

  it("folds a HEAVY_WEIGHT_CALC line's derived amount into additionalChargeSum (Air)", () => {
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
    expect(t.additionalChargeSum).toBe(500); // 100 + 400 (derived)
    expect(t.warehouseSum).toBe(30);
    expect(t.variants).toEqual([{ key: "AIR", rateAmount: null, grandTotal: 530 }]); // 0 + 500 + 30
  });
});

describe("computeHeavyWeightAmount", () => {
  it("computes the Heavy-Weight excess amount", () => {
    expect(computeHeavyWeightAmount(1200, 1000, 2)).toBe(400);
    expect(computeHeavyWeightAmount(800, 1000, 2)).toBe(0);
  });
});

// ── validateQuote v4 submit-gate (design §3.2, Task 1 Step 1; partially reverses v3) ──

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
  it("Round 3 (locked, restored): a common charge alone STARTS a Road leg — no Q_RATE — even with no trucking rate anywhere. Road freight stays optional; contrast with the Sea test below, where freight IS required", () => {
    const d = roadOkDraft();
    d.trucking = [
      {
        legEndpointPointId: "p1",
        truckingType: "DEDICATED",
        basis: "PER_TRUCK",
        amount: null, // no freight rate anywhere
        rateVariant: "DEDICATED",
        tonnage: "T_5",
      },
    ];
    d.charges = [
      {
        zone: null,
        definitionKey: "X",
        presetKey: null,
        rateVariant: null,
        label: "X",
        amount: 20,
      },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_RATE")).toBe(false);
  });
});

describe("validateQuote — Q_PRICED (common active-line pricing, 0-needs-remark, warehouse)", () => {
  const insuranceLine: ResolvedChargeLine[] = [
    {
      definitionKey: "ROAD_STD_INSURANCE",
      role: "STANDARD",
      inputType: "PLAIN",
      zone: null,
      label: "Insurance",
    },
  ];

  it("blocks a priced leg's active PLAIN line that isn't priced at all — fires exactly once, with no per-variant suffix (charges are common now)", () => {
    const d = roadOkDraft(); // DEDICATED priced via trucking; GROUPAGE untouched
    d.charges = [];
    const f = validateQuote(d, deadline, now, insuranceLine);
    const hits = f.filter((x) => x.rule === "Q_PRICED" && x.message.includes("Insurance"));
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toBe('Charge line "Insurance" must be priced');
  });

  it("does not duplicate a common Q_PRICED finding when BOTH Road variants are priced (gated ONCE, not per variant)", () => {
    const d = roadOkDraft();
    d.trucking = [
      ...d.trucking,
      {
        legEndpointPointId: "p1",
        truckingType: "GROUPAGE",
        basis: "PER_TRUCK",
        amount: 400,
        rateVariant: "GROUPAGE",
        tonnage: null,
      },
    ];
    d.charges = [];
    const f = validateQuote(d, deadline, now, insuranceLine);
    const hits = f.filter((x) => x.rule === "Q_PRICED" && x.message.includes("Insurance"));
    expect(hits).toHaveLength(1); // not 2, even though both DEDICATED and GROUPAGE are priced
  });

  it("blocks a zero-amount active line unless it carries a remark", () => {
    const d = roadOkDraft();
    d.charges = [
      {
        zone: null,
        definitionKey: "ROAD_STD_INSURANCE",
        presetKey: null,
        rateVariant: null,
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
        rateVariant: null,
        label: "Insurance",
        amount: 0,
        note: "Waived — bulk client",
      },
    ];
    const f = validateQuote(d, deadline, now, insuranceLine);
    expect(f.some((x) => x.rule === "Q_PRICED")).toBe(false);
  });

  it("blocks a Heavy-Weight-Calc active line missing any of its three inputs", () => {
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
    d.cargo = [{ packageId: "c1", grossWtKg: 1500, cbm: 2 }]; // clear of Q_PIECE_WEIGHT's ceiling — not under test here
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

  it("passes a Heavy-Weight-Calc active line with all three inputs present (fully clean draft)", () => {
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
    d.cargo = [{ packageId: "c1", grossWtKg: 1500, cbm: 2 }]; // clear of Q_PIECE_WEIGHT's ceiling
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
    expect(f).toHaveLength(0);
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

// ── freight (trucking/seaRates) is per-variant, and Round 3 (locked, unchanged by Round 4) says
// the freight submit-gate itself is REQUIRED for Air & Sea, OPTIONAL for Road: a Sea/Air leg
// can't be submitted without its freight (seaRates rate / AIR_MAIN_FREIGHT charge); a Road leg
// CAN, on the strength of its common charges alone. Sea's "priced" and "has its own rate" are the
// same test by construction (isVariantPriced), so there's no separate "Sea Freight must be
// priced" check beyond that — it can't fail once a Sea variant is in `pricedVariants` at all. ──
describe("validateQuote — freight requirement (Round 3, locked: required for Air & Sea, optional for Road)", () => {
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
        {
          zone: "ORIGIN",
          definitionKey: "SEA_ORIGIN_THC",
          presetKey: null,
          rateVariant: null,
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
        guaranteedTransitDaysByVariant: { [SEA_VARIANT_KEY]: 12 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };
  }

  const seaThc: ResolvedChargeLine[] = [
    {
      definitionKey: "SEA_ORIGIN_THC",
      role: "CORE",
      inputType: "PLAIN",
      zone: "ORIGIN",
      label: "Origin THC",
    },
  ];

  it("a common charge alone does NOT make a Sea variant 'priced' — Q_RATE fires with no sea-freight rate set", () => {
    const f = validateQuote(seaDraft(), deadline, now, seaThc);
    expect(f.some((x) => x.rule === "Q_RATE")).toBe(true);
    // and since nothing is "priced", the common-charge completeness gate is skipped too —
    // progressive gating, same philosophy as an untouched leg
    expect(f.some((x) => x.rule === "Q_PRICED")).toBe(false);
  });

  it("passes once the Sea variant's own sea-freight rate is set (its common charge and GTT are already in place)", () => {
    const d = seaDraft();
    d.seaRates = [
      { rateVariant: "FCL", containerSize: "TWENTY", amount: 700 },
      { rateVariant: "LCL", containerSize: null, amount: null },
    ];
    const f = validateQuote(d, deadline, now, seaThc);
    expect(f).toHaveLength(0);
  });

  it("does not require a rate on an UNTOUCHED SEA variant (LCL left alone)", () => {
    const d = seaDraft();
    d.seaRates = [
      { rateVariant: "FCL", containerSize: "TWENTY", amount: 700 },
      { rateVariant: "LCL", containerSize: null, amount: null },
    ];
    const f = validateQuote(d, deadline, now, seaThc);
    expect(f.some((x) => x.message.includes("LCL"))).toBe(false);
  });

  // The exact scenario Fix 1 pins: a ROAD leg with priced common charges but NO trucking rate
  // anywhere must be fully submittable — freight stays optional for Road (Round 3, locked).
  it("Round 3 (locked, restored): a ROAD leg with priced common charges but NO trucking rate is fully submittable", () => {
    const xLine: ResolvedChargeLine[] = [
      { definitionKey: "X", role: "STANDARD", inputType: "PLAIN", zone: null, label: "X" },
    ];
    const d = roadOkDraft();
    d.trucking = []; // no trucking rate at all — neither DEDICATED nor GROUPAGE
    d.charges = [
      {
        zone: null,
        definitionKey: "X",
        presetKey: null,
        rateVariant: null,
        label: "X",
        amount: 20,
      },
    ];
    const f = validateQuote(d, deadline, now, xLine);
    expect(f).toHaveLength(0); // fully submittable: common charge priced, no freight required
  });

  it("Round 3 (locked): a Road leg started only via a common charge still needs no Guaranteed Transit Time — an untouched freight variant (no rate of its own) stays untouched even once the leg is started", () => {
    const d = roadOkDraft();
    d.trucking = [];
    d.transit = { ...d.transit!, guaranteedTransitDaysByVariant: {} }; // no GTT anywhere either
    d.charges = [
      {
        zone: null,
        definitionKey: "X",
        presetKey: null,
        rateVariant: null,
        label: "X",
        amount: 20,
      },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_TRANSIT")).toBe(false);
  });

  it("passes a Road leg once its own trucking rate is set (freight present and sufficient, even though not required)", () => {
    const d = roadOkDraft(); // DEDICATED priced via trucking amount: 500
    const f = validateQuote(d, deadline, now, []);
    expect(f).toHaveLength(0);
  });

  it("AIR: a priced Air variant still requires its AIR_MAIN_FREIGHT charge line (existing Q_PRICED — verified unchanged, since Air's freight is just a common charge)", () => {
    const d = airOkDraft();
    const freightCell = d.charges.find((c) => c.definitionKey === "AIR_MAIN_FREIGHT")!;
    freightCell.amount = null; // unprice the air freight
    const f = validateQuote(d, deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_PRICED" && x.message.includes("Air Freight Charges"))).toBe(
      true,
    );
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

describe("validateQuote — Q_TRANSIT (Road: per priced variant; Sea: ONE common value; Air: single)", () => {
  it("Road: blocks a priced variant missing its Guaranteed Transit Time", () => {
    const d = roadOkDraft(); // DEDICATED is the only priced variant
    d.transit = { ...d.transit!, guaranteedTransitDaysByVariant: {} };
    const f = validateQuote(d, deadline, now, []);
    const finding = f.find((x) => x.rule === "Q_TRANSIT");
    expect(finding).toBeDefined();
    expect(finding?.scope).toEqual({ type: "field", id: "guaranteedTransitDays" }); // keeps findingNav routing working
  });
  it("Road: does not require transit-days for an untouched variant", () => {
    const d = roadOkDraft(); // GROUPAGE is untouched — transit only carries a DEDICATED entry
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_TRANSIT" && x.message.includes("Groupage"))).toBe(false);
  });
  it("Air: blocks a priced Air leg when transit is entirely absent", () => {
    const d = airOkDraft();
    d.transit = null;
    const f = validateQuote(d, deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_TRANSIT")).toBe(true);
  });
  it("Air: blocks a priced Air leg when the transit block exists but has no entry under Air's key (AIR_VARIANT_KEY) — distinct from transit being entirely absent above", () => {
    const d = airOkDraft();
    d.transit = { ...d.transit!, guaranteedTransitDaysByVariant: {} };
    const f = validateQuote(d, deadline, now, airActiveLines);
    const finding = f.find((x) => x.rule === "Q_TRANSIT");
    expect(finding).toBeDefined();
    expect(finding?.scope).toEqual({ type: "field", id: "guaranteedTransitDays" });
  });
  it("Air: passes a fully-priced Air leg with its Guaranteed Transit Time set under AIR_VARIANT_KEY", () => {
    const f = validateQuote(airOkDraft(), deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_TRANSIT")).toBe(false);
  });

  // ── Step 1b: Sea's GTT is ONE common value, required once (not per FCL/LCL) ──
  function seaPricedDraft(): QuoteDraft {
    return {
      legId: "l1",
      mode: "SEA",
      currency: "USD",
      quoteValidityUntil: "2026-08-20T00:00:00.000Z",
      chargedWeightKg: 1000,
      notes: null,
      cargo: [{ packageId: "c1", grossWtKg: 1000, cbm: 2 }],
      charges: [],
      trucking: [],
      seaRates: [{ rateVariant: "FCL", containerSize: "TWENTY", amount: 700 }],
      warehouse: [],
      transit: {
        departureDate: null,
        arrivalDate: null,
        guaranteedTransitDaysByVariant: {},
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };
  }

  it("Sea: blocks when the ONE common Guaranteed Transit Time is missing, even though only FCL is priced", () => {
    const f = validateQuote(seaPricedDraft(), deadline, now, []);
    const finding = f.find((x) => x.rule === "Q_TRANSIT");
    expect(finding).toBeDefined();
    expect(finding?.message).toBe("Guaranteed Transit Time is required"); // no per-variant suffix — it's common
    expect(finding?.scope).toEqual({ type: "field", id: "guaranteedTransitDays" });
  });

  it("Sea: passes once the ONE common GTT is set — covers BOTH FCL and LCL, no per-variant duplication required", () => {
    const d = seaPricedDraft();
    d.transit!.guaranteedTransitDaysByVariant = { [SEA_VARIANT_KEY]: 14 };
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_TRANSIT")).toBe(false);
  });

  it("Sea: does not fire Q_TRANSIT twice when BOTH FCL and LCL are priced but the common GTT is missing (fires exactly once)", () => {
    const d = seaPricedDraft();
    d.seaRates = [
      { rateVariant: "FCL", containerSize: "TWENTY", amount: 700 },
      { rateVariant: "LCL", containerSize: null, amount: 650 },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.filter((x) => x.rule === "Q_TRANSIT")).toHaveLength(1);
  });

  it("Sea: an old per-FCL/LCL entry under the real variant keys does NOT satisfy the common gate (only SEA_VARIANT_KEY does)", () => {
    const d = seaPricedDraft();
    d.transit!.guaranteedTransitDaysByVariant = { FCL: 12 }; // wrong key for v4
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_TRANSIT")).toBe(true);
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

// ── Q_PAST_DATE (design D3, NEW, Task 1 Step 1c): any FF-entered datetime earlier than `nowIso`
// blocks, scoped to that specific field so findingNav can route/focus it. Unconditional — checked
// regardless of pricing progress, same as Q_VALIDITY. ──
describe("validateQuote — Q_PAST_DATE (D3)", () => {
  it("blocks when Road's plannedPickupDate is in the past", () => {
    const d = roadOkDraft();
    d.transit!.plannedPickupDate = "2026-07-20T00:00:00.000Z"; // before `now` (2026-08-01)
    const f = validateQuote(d, deadline, now, []);
    const finding = f.find((x) => x.rule === "Q_PAST_DATE" && x.message.includes("Pickup"));
    expect(finding).toBeDefined();
    expect(finding?.scope).toEqual({ type: "field", id: "plannedPickupDate" });
  });

  it("does not fire when Road's plannedPickupDate is in the future", () => {
    const f = validateQuote(roadOkDraft(), deadline, now, []); // plannedPickupDate: 2026-08-11
    expect(f.some((x) => x.rule === "Q_PAST_DATE")).toBe(false);
  });

  it("blocks when a warehouse row's cargoAcceptanceWindow is in the past, scoped by warehousePointId", () => {
    const d = roadOkDraft();
    d.warehouse = [
      {
        warehousePointId: "w1",
        position: "ORIGIN",
        label: "Warehousing (In/Out)",
        amount: 100,
        cargoAcceptanceWindow: "2026-07-15T09:00:00.000Z",
      },
    ];
    const f = validateQuote(d, deadline, now, []);
    const finding = f.find((x) => x.rule === "Q_PAST_DATE" && x.message.includes("Acceptance"));
    expect(finding).toBeDefined();
    expect(finding?.scope).toEqual({ type: "field", id: "cargoAcceptanceWindow:w1" });
  });

  it("does not fire for a future cargoAcceptanceWindow", () => {
    const d = roadOkDraft();
    d.warehouse = [
      {
        warehousePointId: "w1",
        position: "ORIGIN",
        label: "Warehousing (In/Out)",
        amount: 100,
        cargoAcceptanceWindow: "2026-08-15T09:00:00.000Z",
      },
    ];
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_PAST_DATE")).toBe(false);
  });

  it("blocks when the generic departureDate/arrivalDate are in the past", () => {
    const d = airOkDraft();
    d.transit!.departureDate = "2026-07-01T00:00:00.000Z";
    d.transit!.arrivalDate = "2026-07-03T00:00:00.000Z";
    const f = validateQuote(d, deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_PAST_DATE" && x.scope.id === "departureDate")).toBe(true);
    expect(f.some((x) => x.rule === "Q_PAST_DATE" && x.scope.id === "arrivalDate")).toBe(true);
  });

  it("blocks when Air's plannedDeparture/plannedArrival are in the past", () => {
    const d = airOkDraft();
    d.transit!.plannedDeparture = "2026-07-01T00:00:00.000Z";
    d.transit!.plannedArrival = "2026-07-02T00:00:00.000Z";
    const f = validateQuote(d, deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_PAST_DATE" && x.scope.id === "plannedDeparture")).toBe(true);
    expect(f.some((x) => x.rule === "Q_PAST_DATE" && x.scope.id === "plannedArrival")).toBe(true);
  });

  it("blocks when Sea's ETD/ETA are in the past", () => {
    const d = airOkDraft();
    d.transit!.etd = "2026-07-01T00:00:00.000Z";
    d.transit!.eta = "2026-07-05T00:00:00.000Z";
    const f = validateQuote(d, deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_PAST_DATE" && x.scope.id === "etd")).toBe(true);
    expect(f.some((x) => x.rule === "Q_PAST_DATE" && x.scope.id === "eta")).toBe(true);
  });

  it("does not fire for an unset (null/undefined) date field", () => {
    const d = airOkDraft();
    d.transit!.plannedPickupDate = null;
    const f = validateQuote(d, deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_PAST_DATE")).toBe(false);
  });

  it("does not fire when transit is entirely null (nothing to check)", () => {
    const d = roadOkDraft();
    d.transit = null;
    const f = validateQuote(d, deadline, now, []);
    expect(f.some((x) => x.rule === "Q_PAST_DATE")).toBe(false);
  });
});

// ── Q_PIECE_WEIGHT (design D4, NEW, Task 1 Step 1d): a HEAVY_WEIGHT_CALC charge's pieceWeightKg
// can't exceed Σ draft.cargo[].grossWtKg. ──
describe("validateQuote — Q_PIECE_WEIGHT (D4)", () => {
  function draftWithHeavyWeight(pieceWeightKg: number, cargoGrossWtKg: number[]): QuoteDraft {
    const d = airOkDraft();
    d.cargo = cargoGrossWtKg.map((grossWtKg, i) => ({
      packageId: `c${i}`,
      grossWtKg,
      cbm: 1,
    }));
    d.charges = [
      ...d.charges,
      {
        zone: "MAIN_FREIGHT",
        definitionKey: "AIR_MAIN_HEAVY_WEIGHT",
        presetKey: null,
        rateVariant: null,
        label: "Heavy Weight Surcharge",
        amount: null,
        pieceWeightKg,
        airlineLimitKg: 1000,
        ratePerExcessKg: 2,
      },
    ];
    return d;
  }

  it("blocks when pieceWeightKg exceeds the total manifested cargo gross weight", () => {
    const d = draftWithHeavyWeight(1200, [1000]); // 1200 > 1000
    const f = validateQuote(d, deadline, now, airActiveLines);
    const finding = f.find((x) => x.rule === "Q_PIECE_WEIGHT");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("1200");
    expect(finding?.message).toContain("1000");
    expect(finding?.scope).toEqual({ type: "field", id: "pieceWeightKg:AIR_MAIN_HEAVY_WEIGHT" });
  });

  it("passes when pieceWeightKg is within the cargo's total gross weight", () => {
    const d = draftWithHeavyWeight(900, [1000]); // 900 <= 1000
    const f = validateQuote(d, deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_PIECE_WEIGHT")).toBe(false);
  });

  it("passes at the exact boundary (pieceWeightKg === total gross weight — strict > only)", () => {
    const d = draftWithHeavyWeight(1000, [1000]);
    const f = validateQuote(d, deadline, now, airActiveLines);
    expect(f.some((x) => x.rule === "Q_PIECE_WEIGHT")).toBe(false);
  });

  it("sums gross weight ACROSS MULTIPLE cargo packages", () => {
    const blocked = draftWithHeavyWeight(901, [500, 400]); // sum 900, 901 > 900
    expect(
      validateQuote(blocked, deadline, now, airActiveLines).some(
        (x) => x.rule === "Q_PIECE_WEIGHT",
      ),
    ).toBe(true);

    const ok = draftWithHeavyWeight(900, [500, 400]); // sum 900, 900 is not > 900
    expect(
      validateQuote(ok, deadline, now, airActiveLines).some((x) => x.rule === "Q_PIECE_WEIGHT"),
    ).toBe(false);
  });

  it("does not fire for a charge with no pieceWeightKg at all (not a HEAVY_WEIGHT_CALC line)", () => {
    const f = validateQuote(airOkDraft(), deadline, now, airActiveLines); // cargo grossWtKg: 1000, no heavy-weight charge
    expect(f.some((x) => x.rule === "Q_PIECE_WEIGHT")).toBe(false);
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
