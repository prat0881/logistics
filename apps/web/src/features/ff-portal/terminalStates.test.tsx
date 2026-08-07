import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FfPortalLegDto, FfPortalRfqDto, QuoteDraft } from "@svyft/shared";
import { InvalidTokenCard, ExpiredBanner, AlreadySubmittedSummary } from "./terminalStates";

describe("terminalStates", () => {
  it("invalid token card has no retry", () => {
    render(<InvalidTokenCard />);
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry|try again/i })).toBeNull();
  });

  it("expired banner announces the passed deadline", () => {
    render(<ExpiredBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(/deadline has passed/i);
  });

  it("AlreadySubmittedSummary shows badge and grand total for a QUOTED leg with draft", () => {
    const rfq: FfPortalRfqDto = {
      rfqNumber: "R-1",
      incoterms: "FOB",
      submissionDeadline: "2026-09-01T00:00:00.000Z",
      currency: "USD",
      quoteValidityUntil: "2026-09-30T00:00:00.000Z",
      freightForwarder: { companyName: "Acme FF" },
      legs: [],
    };

    const leg: FfPortalLegDto = {
      legId: "L1",
      quoteId: "Q1",
      status: "QUOTED",
      mode: "AIR",
      manifest: {
        cargo: [
          {
            packageId: "pk1",
            packageNo: "PK-1",
            packageType: "Crate",
            packageCount: 2,
            dimL: "1.2",
            dimW: "1.0",
            dimH: "0.8",
            netWt: "900",
            grossWt: "1500",
            volumeCbm: "2.5",
            tags: [],
          },
        ],
      } as never,
      endpoints: [
        {
          pointId: "w1",
          type: "WAREHOUSE",
          name: "Origin WH",
          country: "IN",
          warehousePosition: "ORIGIN",
        },
      ],
      seededCharges: [],
      draft: {
        legId: "L1",
        mode: "AIR",
        currency: "USD",
        quoteValidityUntil: "2026-09-30T00:00:00.000Z",
        cargo: [
          {
            packageId: "pk1",
            grossWtKg: 1500,
            cbm: 2.5,
            chargedWeightKg: 1500,
          },
        ],
        charges: [
          { zone: "MAIN_FREIGHT", presetKey: "air_freight", label: "Air Freight", amount: 3500 },
        ],
        trucking: [],
        seaRates: [],
        warehouse: [
          { warehousePointId: "w1", position: "ORIGIN", label: "Origin warehouse", amount: 200 },
        ],
        transit: { departureDate: null, arrivalDate: null, guaranteedTransitDays: null },
        dgSurchargeNote: null,
        termsConditions: null,
      },
    } as never;

    render(<AlreadySubmittedSummary leg={leg} rfq={rfq} />);
    expect(screen.getByText(/quote submitted/i)).toBeInTheDocument();
    // Single-variant (AIR) grand total — QuoteSummary keys the testid per rate variant.
    expect(screen.getByTestId("grand-total-AIR")).toBeInTheDocument();
  });

  it("AlreadySubmittedSummary falls back to draftFromDto when leg.draft is null", () => {
    const rfq: FfPortalRfqDto = {
      rfqNumber: "R-2",
      incoterms: "EXW",
      submissionDeadline: "2026-09-01T00:00:00.000Z",
      currency: "USD",
      quoteValidityUntil: "2026-09-30T00:00:00.000Z",
      freightForwarder: { companyName: "Beta FF" },
      legs: [],
    };

    const leg: FfPortalLegDto = {
      legId: "L2",
      quoteId: "Q2",
      status: "QUOTED",
      mode: "AIR",
      manifest: {
        cargo: [
          {
            packageId: "pk2",
            packageNo: "PK-2",
            packageType: "Pallet",
            packageCount: 4,
            dimL: "1.0",
            dimW: "0.8",
            dimH: "0.6",
            netWt: "800",
            grossWt: "2000",
            volumeCbm: "3.0",
            tags: [],
          },
        ],
      } as never,
      endpoints: [
        {
          pointId: "w2",
          type: "WAREHOUSE",
          name: "Origin WH 2",
          country: "SG",
          warehousePosition: "ORIGIN",
        },
      ],
      seededCharges: [{ zone: "MAIN_FREIGHT", presetKey: "air_freight", label: "Air Freight" }],
      draft: null,
    } as never;

    render(<AlreadySubmittedSummary leg={leg} rfq={rfq} />);
    expect(screen.getByText(/quote submitted/i)).toBeInTheDocument();
    // Single-variant (AIR) grand total — QuoteSummary keys the testid per rate variant.
    const grandTotal = screen.getByTestId("grand-total-AIR");
    expect(grandTotal).toBeInTheDocument();
    expect(grandTotal).toHaveTextContent(rfq.currency!);
  });

  // ── finding #8 companion check (Task 8 follow-up): AlreadySubmittedSummary reads `leg.draft`
  // the same way RfqPrintView does — this proves it renders the SUBMITTED per-variant totals for
  // a v3-shaped draft (the shape ff-portal.service.ts's submit() now persists onto
  // Quote.draftJson instead of nulling it), not just that a testid element exists. A blank/
  // reseeded draft (the pre-fix bug shape — same field, all amounts null) would render "–" here
  // instead of these figures, so this genuinely discriminates fixed vs. broken upstream data.
  it("AlreadySubmittedSummary renders the SUBMITTED per-variant totals for a v3 QUOTED leg (finding #8)", () => {
    const rfq: FfPortalRfqDto = {
      rfqNumber: "R-3",
      incoterms: "FOB",
      submissionDeadline: "2026-09-01T00:00:00.000Z",
      currency: "USD",
      quoteValidityUntil: "2026-09-30T00:00:00.000Z",
      freightForwarder: { companyName: "Gamma FF" },
      legs: [],
    };

    const draft: QuoteDraft = {
      legId: "L3",
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: "2026-09-30T00:00:00.000Z",
      chargedWeightKg: 482.75,
      notes: "Handle with care",
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
          tonnage: null,
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

    const leg: FfPortalLegDto = {
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
        cargo: [
          {
            packageId: "pk3",
            packageNo: "PK-3",
            packageType: "CRATE",
            packageCount: 1,
            dimL: "100",
            dimW: "50",
            dimH: "40",
            netWt: "800",
            grossWt: "900",
            volumeCbm: "2.5",
            tags: [],
          },
        ],
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
      draft,
    };

    render(<AlreadySubmittedSummary leg={leg} rfq={rfq} />);
    expect(screen.getByText(/quote submitted/i)).toBeInTheDocument();

    // 120 (charge) + 500 (freight) = 620 Dedicated; 90 + 300 = 390 Groupage — real per-variant
    // arithmetic, not an echoed input, so this fails if leg.draft were the blank reseed.
    expect(screen.getByTestId("grand-total-DEDICATED")).toHaveTextContent("620.00");
    expect(screen.getByTestId("grand-total-GROUPAGE")).toHaveTextContent("390.00");
  });
});
