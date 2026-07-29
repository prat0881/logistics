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
            cargoItemId: "c1",
            poReference: "PO-1",
            productName: "Pumps",
            hsCode: "8413",
            packageType: "Crate",
            isDangerous: false,
            qty: 2,
            dimL: "1.2",
            dimW: "1.0",
            dimH: "0.8",
            netWt: "900",
            grossWt: "1500",
            volumeCbm: "2.5",
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
      seededDensity: [{ cargoItemId: "c1", freightDensity: 1000 }],
      draft: {
        legId: "L1",
        mode: "AIR",
        currency: "USD",
        quoteValidityUntil: "2026-09-30T00:00:00.000Z",
        cargo: [
          {
            cargoItemId: "c1",
            grossWtT: 1.5,
            cbm: 2.5,
            isDangerous: false,
            freightDensity: 1000,
          },
        ],
        charges: [
          { zone: "MAIN_FREIGHT", presetKey: "air_freight", label: "Air Freight", amount: 3500 },
        ],
        trucking: [],
        warehouse: [
          { warehousePointId: "w1", position: "ORIGIN", label: "Origin warehouse", amount: 200 },
        ],
        transit: { departureDate: null, arrivalDate: null },
        dgSurchargeNote: null,
        termsConditions: null,
      },
    } as never;

    render(<AlreadySubmittedSummary leg={leg} rfq={rfq} />);
    expect(screen.getByText(/quote submitted/i)).toBeInTheDocument();
    expect(screen.getByTestId("grand-total")).toBeInTheDocument();
  });
});
