import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type {
  FfPortalRfqDto,
  FfPortalLegDto,
  ManifestSnapshotCargo,
  QuoteDraft,
} from "@svyft/shared";
import { RfqPrintView } from "./RfqPrintView";

const pkg: ManifestSnapshotCargo = {
  packageId: "pk1",
  packageNo: "PK-1",
  packageType: "CRATE",
  packageCount: 2,
  dimL: "120",
  dimW: "100",
  dimH: "80",
  netWt: "900",
  grossWt: "1500",
  volumeCbm: "2.5",
  tags: ["DG"],
};

const leg: FfPortalLegDto = {
  legId: "L1",
  quoteId: "Q1",
  status: "RFQ_SENT",
  mode: "AIR",
  manifest: {
    legId: "L1",
    legCode: "LEG-01",
    legName: null,
    mode: "AIR",
    incoterms: null,
    origin: { name: "Origin WH", city: "Mumbai", country: "IN" },
    destination: { name: "Dest Airport", city: "Dubai", country: "AE" },
    readyDate: null,
    targetDelivery: null,
    cargo: [pkg],
    frozenAt: "2026-08-01T00:00:00.000Z",
  },
  endpoints: [],
  seededCharges: [
    {
      zone: "ORIGIN",
      definitionKey: "AIR_ORIGIN_THC",
      inputType: "PLAIN",
      presetKey: "AIR_ORIGIN_THC",
      label: "Origin THC / Airport Handling",
      isPreset: true,
      amount: null,
    },
    {
      zone: "MAIN_FREIGHT",
      definitionKey: "AIR_MAIN_FREIGHT",
      inputType: "PLAIN",
      presetKey: "AIR_MAIN_FREIGHT",
      label: "Air Freight",
      isPreset: true,
      amount: null,
    },
  ],
  warehouseIncluded: true,
  draft: null,
  version: "v1",
};

const roadLeg: FfPortalLegDto = {
  ...leg,
  legId: "L2",
  quoteId: "Q2",
  mode: "ROAD",
  manifest: { ...leg.manifest, legId: "L2", legCode: "LEG-02", mode: "ROAD", cargo: [] },
  seededCharges: [], // ROAD legs seed via `endpoints`/trucking, not `seededCharges`
};

// ── finding #8 fixtures: a QUOTED leg whose `draft` carries the FF's SUBMITTED figures (Task 3's
// resolveScope/submit contract — see ff-portal.service.ts), not the blank seed. ROAD exercises the
// 2-column matrix (Dedicated/Groupage) + the separate freight-rate row sourced from `trucking`
// (design §3.1: Road's freight rate is NOT a `charges` line).
// v4 (design D1): `charges` is COMMON — ONE row per line (`rateVariant: null`), priced once and
// folded into EVERY variant's total equally; freight (`trucking`) is the one thing that stays
// per-variant.
const quotedRoadDraft: QuoteDraft = {
  legId: "L3",
  mode: "ROAD",
  currency: "USD",
  quoteValidityUntil: "2026-09-15T00:00:00.000Z",
  chargedWeightKg: 482.75,
  notes: "Handle with care — fragile glassware",
  cargo: [{ packageId: "pk3", grossWtKg: 900, cbm: 2.5 }],
  charges: [
    {
      zone: "ORIGIN",
      definitionKey: "ROAD_STD_TAIL_LIFT",
      presetKey: "ROAD_STD_TAIL_LIFT",
      label: "Tail Lift",
      amount: 120,
      rateVariant: null,
    },
  ],
  trucking: [
    {
      legEndpointPointId: "P1",
      truckingType: "DEDICATED",
      basis: "PER_TRUCK",
      amount: 500,
      rateVariant: "DEDICATED",
      tonnage: "T_5",
    },
    {
      legEndpointPointId: "P1",
      truckingType: "GROUPAGE",
      basis: "PER_TRUCK",
      amount: 300,
      rateVariant: "GROUPAGE",
      tonnage: null,
    },
  ],
  seaRates: [],
  warehouse: [],
  transit: {
    departureDate: "2026-08-12T00:00:00.000Z",
    arrivalDate: "2026-08-14T00:00:00.000Z",
    guaranteedTransitDaysByVariant: { DEDICATED: 3, GROUPAGE: 5 },
  },
  dgSurchargeNote: null,
  termsConditions: null,
};

const quotedRoadLeg: FfPortalLegDto = {
  legId: "L3",
  quoteId: "Q3",
  status: "QUOTED",
  mode: "ROAD",
  manifest: {
    legId: "L3",
    legCode: "LEG-03",
    legName: null,
    mode: "ROAD",
    incoterms: null,
    origin: { name: "Origin WH", city: "Shenzhen", country: "CN" },
    destination: { name: "Dest WH", city: "Dubai", country: "AE" },
    readyDate: null,
    targetDelivery: null,
    cargo: [{ ...pkg, packageId: "pk3", packageNo: "PK-3" }],
    frozenAt: "2026-08-01T00:00:00.000Z",
  },
  endpoints: [],
  seededCharges: [
    {
      zone: "ORIGIN",
      definitionKey: "ROAD_STD_TAIL_LIFT",
      inputType: "PLAIN",
      presetKey: "ROAD_STD_TAIL_LIFT",
      label: "Tail Lift",
      isPreset: true,
      amount: null,
    },
  ],
  warehouseIncluded: false,
  draft: quotedRoadDraft,
  version: "v3",
};

// Warehousing is shared (design D4), not per-variant — WarehouseStaging's read-only mirror
// (design §6 finding #8 fix round 1: the preview omitted this section entirely, so a leg with a
// priced warehouse point showed a Grand Total that silently included warehouse money nothing on
// the page explained).
const quotedRoadLegWithWarehouse: FfPortalLegDto = {
  ...quotedRoadLeg,
  legId: "L4",
  quoteId: "Q4",
  manifest: { ...quotedRoadLeg.manifest, legId: "L4", legCode: "LEG-04" },
  warehouseIncluded: true,
  draft: {
    ...quotedRoadDraft,
    legId: "L4",
    warehouse: [
      {
        warehousePointId: "wp1",
        position: "ORIGIN",
        label: "Nhava Sheva CFS",
        amount: 250,
        cargoAcceptanceWindow: "2025-08-01 09:00",
      },
    ],
  },
};

// Round 4 (was finding #3a pre-reversal): a variant whose own freight rate was never entered now
// shows its REAL total in the grand-total row — the SAME rule ChargeMatrix/QuoteSummary use —
// whenever any input (freight, a common charge, or warehouse) is priced; "—" is reserved for a
// variant with nothing priced anywhere. Here DEDICATED is priced (tail lift 120 + trucking 500 =
// 620) while GROUPAGE's OWN freight is untouched — but the SAME common Tail Lift charge (120)
// also applies to it, so GROUPAGE reads 120.00, not "—".
const partiallyPricedRoadLeg: FfPortalLegDto = {
  ...quotedRoadLeg,
  legId: "L5",
  quoteId: "Q5",
  manifest: { ...quotedRoadLeg.manifest, legId: "L5", legCode: "LEG-05" },
  draft: {
    ...quotedRoadDraft,
    legId: "L5",
    trucking: [
      {
        legEndpointPointId: "P1",
        truckingType: "DEDICATED",
        basis: "PER_TRUCK",
        amount: 500,
        rateVariant: "DEDICATED",
        tonnage: "T_5",
      },
      {
        legEndpointPointId: "P1",
        truckingType: "GROUPAGE",
        basis: "PER_TRUCK",
        amount: null, // untouched → blank rate
        rateVariant: "GROUPAGE",
        tonnage: null,
      },
    ],
  },
};

// design D1/#6: a custom [+ Add Charge Line] row (no definitionKey/presetKey) — present only in
// `draft.charges`, never in `seededCharges` — must still render as its own read-only line item
// (not silently folded into the totals with nothing on the page explaining it, the same class of
// bug fix round 1 already fixed for warehouse — see WarehousingList's doc comment).
const quotedRoadLegWithCustomCharge: FfPortalLegDto = {
  ...quotedRoadLeg,
  legId: "L6",
  quoteId: "Q6",
  manifest: { ...quotedRoadLeg.manifest, legId: "L6", legCode: "LEG-06" },
  draft: {
    ...quotedRoadDraft,
    legId: "L6",
    charges: [
      ...quotedRoadDraft.charges,
      {
        zone: null,
        definitionKey: null,
        presetKey: null,
        label: "Fuel surcharge",
        amount: 45,
        rateVariant: null,
        note: "Peak season",
      },
    ],
  },
};

// AIR's degenerate single-implicit-column case (variantsForMode("AIR") === [null]): freight has
// NO separate row — it's just the AIR_MAIN_FREIGHT `charges` line, same as any other header. Air's
// charges were ALREADY common in v3 (rateVariant: null) — this fixture is unchanged by v4.
const quotedAirLeg: FfPortalLegDto = {
  ...leg,
  status: "QUOTED",
  draft: {
    legId: "L1",
    mode: "AIR",
    currency: "USD",
    quoteValidityUntil: "2026-09-15T00:00:00.000Z",
    chargedWeightKg: 1250.5,
    notes: "Priority handling requested",
    cargo: [{ packageId: "pk1", grossWtKg: 1500, cbm: 2.5 }],
    charges: [
      {
        zone: "ORIGIN",
        definitionKey: "AIR_ORIGIN_THC",
        presetKey: "AIR_ORIGIN_THC",
        label: "Origin THC / Airport Handling",
        amount: 75,
        rateVariant: null,
      },
      {
        zone: "MAIN_FREIGHT",
        definitionKey: "AIR_MAIN_FREIGHT",
        presetKey: "AIR_MAIN_FREIGHT",
        label: "Air Freight",
        amount: 640,
        rateVariant: null,
      },
    ],
    trucking: [],
    seaRates: [],
    warehouse: [],
    transit: { departureDate: null, arrivalDate: null, guaranteedTransitDaysByVariant: { AIR: 4 } },
    dgSurchargeNote: null,
    termsConditions: null,
  } satisfies QuoteDraft,
};

const rfq: FfPortalRfqDto = {
  rfqNumber: "R-99",
  incoterms: "FOB",
  submissionDeadline: "2026-09-01T12:00:00.000Z",
  currency: "USD",
  quoteValidityUntil: "2026-09-15T00:00:00.000Z",
  freightForwarder: { companyName: "Acme Freight" },
  legs: [leg],
};

describe("RfqPrintView", () => {
  it("renders the RFQ header — number, company, incoterms, currency", () => {
    render(<RfqPrintView rfq={rfq} />);
    expect(screen.getByText("R-99")).toBeInTheDocument();
    expect(screen.getByText("Acme Freight")).toBeInTheDocument();
    expect(screen.getByText("FOB")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
  });

  it("renders the leg code, mode, and masked origin/destination (name · city · country)", () => {
    render(<RfqPrintView rfq={rfq} />);
    expect(screen.getByText("LEG-01")).toBeInTheDocument();
    expect(screen.getByText("AIR")).toBeInTheDocument();
    const routeLine = screen.getByText(/Origin WH/).closest("p")!;
    expect(routeLine).toHaveTextContent("Origin WH · Mumbai · IN");
    expect(routeLine).toHaveTextContent("Dest Airport · Dubai · AE");
  });

  it("renders the leg's package list rows (reusing CargoManifestTable)", () => {
    render(<RfqPrintView rfq={rfq} />);
    const row = screen.getByText("CRATE").closest("tr")!;
    expect(within(row).getByText("2")).toBeInTheDocument(); // package count
    expect(within(row).getByText("900")).toBeInTheDocument(); // net wt
    expect(within(row).getByText("1500")).toBeInTheDocument(); // gross wt
    expect(within(row).getByLabelText("Dangerous Goods")).toBeInTheDocument();
  });

  it("renders the requested charge structure with zone + label, amounts blank", () => {
    render(<RfqPrintView rfq={rfq} />);
    expect(screen.getByText("Air Freight")).toBeInTheDocument();
    expect(screen.getByText("Origin THC / Airport Handling")).toBeInTheDocument();
    expect(screen.getByText("Main freight")).toBeInTheDocument();
    expect(screen.getByText("Origin")).toBeInTheDocument();
    // Amounts are blank "—" — this is the request document, not the FF's priced quote.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("shows an empty state for a leg with no seeded charge lines (e.g. ROAD)", () => {
    render(<RfqPrintView rfq={{ ...rfq, legs: [roadLeg] }} />);
    expect(screen.getByText(/no preset charge lines/i)).toBeInTheDocument();
  });

  // ── finding #8 / design D1: the preview must show the SUBMITTED quote for a QUOTED leg, with
  // the SAME D1 layout as the live ChargeMatrix — common charges as a single amount, freight
  // per-variant, an Additional-charges subtotal, and the Grand total per variant.
  it("renders the submitted common charge (single amount), freight rate, chargeable weight, and notes for a QUOTED leg (finding #8, Round 4)", () => {
    render(<RfqPrintView rfq={{ ...rfq, legs: [quotedRoadLeg] }} />);

    // the ONE common Tail Lift charge — a single amount, not two per-variant cells.
    const tailLiftRow = screen.getByText("Tail Lift").closest("tr")!;
    expect(within(tailLiftRow).getByText("120.00")).toBeInTheDocument();

    // freight rate per variant (Road Freight, sourced from `trucking`, not `charges`) — UNCHANGED,
    // freight stays per-variant.
    const freightRow = screen.getByText("Road Freight").closest("tr")!;
    expect(within(freightRow).getByText("500.00")).toBeInTheDocument();
    expect(within(freightRow).getByText("300.00")).toBeInTheDocument();

    // Additional-charges subtotal = the one common Tail Lift charge (120).
    const subtotalRow = screen.getByText("Additional charges").closest("tr")!;
    expect(within(subtotalRow).getByText("120.00")).toBeInTheDocument();

    // per-variant grand total (500+120=620 Dedicated, 300+120=420 Groupage) — proves real
    // arithmetic, not just echoed input, so this fails if the fix is a tautological pass-through.
    const totalRow = screen.getByText("Grand total").closest("tr")!;
    expect(within(totalRow).getByText("620.00")).toBeInTheDocument();
    expect(within(totalRow).getByText("420.00")).toBeInTheDocument();

    // the one leg-level chargeable weight
    expect(screen.getByText("482.750")).toBeInTheDocument();

    // notes
    expect(screen.getByText("Handle with care — fragile glassware")).toBeInTheDocument();
  });

  it("shows the real total (not '—') for a variant whose own freight rate is unset but a common charge IS priced (Round 4)", () => {
    render(<RfqPrintView rfq={{ ...rfq, legs: [partiallyPricedRoadLeg] }} />);
    const totalRow = screen.getByText("Grand total").closest("tr")!;
    // DEDICATED: 500 (own freight) + 120 (common Tail Lift) = 620. GROUPAGE: its own freight rate
    // is unset, but the SAME common Tail Lift (120) still applies to it → 0 + 120 = 120, the real
    // number, not a blank "—" anymore — Round 4 reverses the old "own-rate-only" blank rule.
    expect(within(totalRow).getByText("620.00")).toBeInTheDocument();
    expect(within(totalRow).getByText("120.00")).toBeInTheDocument();
    expect(within(totalRow).queryByText("—")).toBeNull();
  });

  it("still shows '—' (not 0.00) for a variant with nothing priced anywhere — no freight, no common charge, no warehouse", () => {
    const untouchedLeg: FfPortalLegDto = {
      ...quotedRoadLeg,
      legId: "L8",
      quoteId: "Q8",
      manifest: { ...quotedRoadLeg.manifest, legId: "L8", legCode: "LEG-08" },
      draft: {
        ...quotedRoadDraft,
        legId: "L8",
        charges: [],
        trucking: quotedRoadDraft.trucking.map((t) => ({ ...t, amount: null })),
      },
    };
    render(<RfqPrintView rfq={{ ...rfq, legs: [untouchedLeg] }} />);
    const totalRow = screen.getByText("Grand total").closest("tr")!;
    expect(within(totalRow).getAllByText("—")).toHaveLength(2); // both DEDICATED and GROUPAGE blank
    expect(within(totalRow).queryByText("0.00")).toBeNull();
  });

  // design D1/#6: a custom [+ Add Charge Line] row must render as its own line item, not vanish
  // into the totals with nothing on the page explaining it — same fix-round-1 principle already
  // applied to warehouse (see WarehousingList's doc comment).
  it("renders a custom [+ Add Charge Line] line as its own read-only row, folded into the Additional-charges subtotal and Grand total", () => {
    render(<RfqPrintView rfq={{ ...rfq, legs: [quotedRoadLegWithCustomCharge] }} />);

    const customRow = screen.getByText("Fuel surcharge").closest("tr")!;
    expect(within(customRow).getByText("45.00")).toBeInTheDocument();

    // Additional charges = 120 (Tail Lift, catalogue) + 45 (Fuel surcharge, custom) = 165.
    const subtotalRow = screen.getByText("Additional charges").closest("tr")!;
    expect(within(subtotalRow).getByText("165.00")).toBeInTheDocument();

    // Grand total: 500+165=665 Dedicated, 300+165=465 Groupage.
    const totalRow = screen.getByText("Grand total").closest("tr")!;
    expect(within(totalRow).getByText("665.00")).toBeInTheDocument();
    expect(within(totalRow).getByText("465.00")).toBeInTheDocument();
  });

  it("renders per-cell amounts, the Additional-charges subtotal, and Grand total for a QUOTED AIR leg (single implicit column, freight folded into charges)", () => {
    render(<RfqPrintView rfq={{ ...rfq, legs: [quotedAirLeg] }} />);
    expect(screen.getByText("75.00")).toBeInTheDocument();
    expect(screen.getByText("640.00")).toBeInTheDocument();
    expect(screen.getByText("1250.500")).toBeInTheDocument();
    expect(screen.getByText("Priority handling requested")).toBeInTheDocument();

    // Additional charges = 75 (Origin THC) + 640 (Air Freight) = 715; Air has no separate freight
    // rate cell, so Grand total = 0 + 715 + 0 (warehouse) = 715.
    const subtotalRow = screen.getByText("Additional charges").closest("tr")!;
    expect(within(subtotalRow).getByText("715.00")).toBeInTheDocument();
    const totalRow = screen.getByText("Grand total").closest("tr")!;
    expect(within(totalRow).getByText("715.00")).toBeInTheDocument();
  });

  // ── finding #8 fix round 1: the shared (non-per-variant, design D4) Warehousing section was
  // missing entirely, even though computeQuoteTotals folds it into every variant's Grand Total —
  // so a priced warehouse point made the Grand Total not reconcile with the visible line items.
  it("renders a Warehousing section with the label, amount, and acceptance window for a priced warehouse row (finding #8 fix round 1)", () => {
    render(<RfqPrintView rfq={{ ...rfq, legs: [quotedRoadLegWithWarehouse] }} />);
    expect(screen.getByText("Warehousing")).toBeInTheDocument();
    expect(screen.getByText("Nhava Sheva CFS")).toBeInTheDocument();
    expect(screen.getByText("250.00")).toBeInTheDocument();
    expect(screen.getByText(/2025-08-01 09:00/)).toBeInTheDocument();
  });

  it("does not render a Warehousing section when no warehouse row is priced", () => {
    render(<RfqPrintView rfq={{ ...rfq, legs: [quotedRoadLeg] }} />);
    expect(screen.queryByText("Warehousing")).toBeNull();
  });

  it("renders a Terms & Conditions section", () => {
    render(<RfqPrintView rfq={rfq} />);
    expect(screen.getByText(/terms.*conditions/i)).toBeInTheDocument();
  });

  it("renders nothing interactive — no buttons, inputs, or checkboxes", () => {
    render(<RfqPrintView rfq={rfq} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
