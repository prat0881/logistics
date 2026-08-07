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
};

const roadLeg: FfPortalLegDto = {
  ...leg,
  legId: "L2",
  quoteId: "Q2",
  mode: "ROAD",
  manifest: { ...leg.manifest, legId: "L2", legCode: "LEG-02", mode: "ROAD", cargo: [] },
  seededCharges: [], // ROAD legs seed via `endpoints`/trucking, not `seededCharges`
};

// ── finding #8 fixtures: a QUOTED leg whose `draft` carries the FF's SUBMITTED per-variant
// figures (Task 3's resolveScope/submit contract — see ff-portal.service.ts), not the blank
// seed. ROAD exercises the 2-column matrix (Dedicated/Groupage) + the separate freight-rate row
// sourced from `trucking` (design §3.1: Road's freight rate is NOT a `charges` line).
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
      rateVariant: "DEDICATED",
    },
    {
      zone: "ORIGIN",
      definitionKey: "ROAD_STD_TAIL_LIFT",
      presetKey: "ROAD_STD_TAIL_LIFT",
      label: "Tail Lift",
      amount: 90,
      rateVariant: "GROUPAGE",
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
};

// AIR's degenerate single-implicit-column case (variantsForMode("AIR") === [null]): freight has
// NO separate row — it's just the AIR_MAIN_FREIGHT `charges` line, same as any other header.
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

  // ── finding #8: the preview must show the SUBMITTED quote for a QUOTED leg, not the empty seed ──
  it("renders the submitted per-variant charges, freight rate, chargeable weight, and notes for a QUOTED leg (finding #8)", () => {
    render(<RfqPrintView rfq={{ ...rfq, legs: [quotedRoadLeg] }} />);

    // per-variant charge amounts (Tail Lift: Dedicated 120.00, Groupage 90.00) — NOT "—"
    expect(screen.getByText("120.00")).toBeInTheDocument();
    expect(screen.getByText("90.00")).toBeInTheDocument();

    // freight rate per variant (Road Freight, sourced from `trucking`, not `charges`)
    expect(screen.getByText("Road Freight")).toBeInTheDocument();
    expect(screen.getByText("500.00")).toBeInTheDocument();
    expect(screen.getByText("300.00")).toBeInTheDocument();

    // per-variant grand total (120+500=620 Dedicated, 90+300=390 Groupage) — proves real arithmetic,
    // not just echoed input, so this fails if the fix is a tautological pass-through.
    expect(screen.getByText("620.00")).toBeInTheDocument();
    expect(screen.getByText("390.00")).toBeInTheDocument();

    // the one leg-level chargeable weight
    expect(screen.getByText("482.750")).toBeInTheDocument();

    // notes
    expect(screen.getByText("Handle with care — fragile glassware")).toBeInTheDocument();
  });

  it("renders per-cell amounts for a QUOTED AIR leg (single implicit column, freight folded into charges)", () => {
    render(<RfqPrintView rfq={{ ...rfq, legs: [quotedAirLeg] }} />);
    expect(screen.getByText("75.00")).toBeInTheDocument();
    expect(screen.getByText("640.00")).toBeInTheDocument();
    expect(screen.getByText("1250.500")).toBeInTheDocument();
    expect(screen.getByText("Priority handling requested")).toBeInTheDocument();
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
