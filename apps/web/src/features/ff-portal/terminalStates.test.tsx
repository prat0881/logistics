import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FfPortalLegDto, FfPortalRfqDto } from "@svyft/shared";
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
});
