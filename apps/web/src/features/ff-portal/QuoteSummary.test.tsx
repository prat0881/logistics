import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QuoteDraft } from "@svyft/shared";
import { QuoteSummary } from "./QuoteSummary";

const roadDraft: QuoteDraft = {
  legId: "L1", mode: "ROAD", currency: "USD", quoteValidityUntil: null,
  cargo: [{ packageId: "p1", grossWtKg: 1500, cbm: 2.5, chargedWeightKg: 1500 }],
  charges: [{ zone: null, presetKey: null, label: "Fuel surcharge", amount: 200 }],
  trucking: [
    { legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: 500, rateVariant: "DEDICATED", tonnage: "T_5" },
    { legEndpointPointId: "p1", truckingType: "GROUPAGE", basis: "PER_TRUCK", amount: null, rateVariant: "GROUPAGE", tonnage: null },
  ],
  seaRates: [],
  warehouse: [{ warehousePointId: "w1", position: "ORIGIN", label: "Origin warehouse", amount: 300 }],
  transit: null, dgSurchargeNote: null, termsConditions: null,
};

const airDraft: QuoteDraft = {
  legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null,
  cargo: [{ packageId: "p1", grossWtKg: 1000, cbm: 2, chargedWeightKg: 1000 }],
  charges: [{ zone: "MAIN_FREIGHT", presetKey: "x", label: "Air Freight", amount: 900 }],
  trucking: [], seaRates: [], warehouse: [],
  transit: null, dgSurchargeNote: null, termsConditions: null,
};

const seaDraft: QuoteDraft = {
  legId: "L1", mode: "SEA", currency: "USD", quoteValidityUntil: null,
  cargo: [{ packageId: "p1", grossWtKg: 2000, cbm: 5, chargedWeightKg: 2000 }],
  charges: [{ zone: "ORIGIN", presetKey: null, label: "Origin THC", amount: 150 }],
  trucking: [],
  seaRates: [
    { rateVariant: "FCL", containerSize: "TWENTY", amount: 1200 },
    { rateVariant: "LCL", containerSize: null, amount: null },
  ],
  warehouse: [],
  transit: null, dgSurchargeNote: null, termsConditions: null,
};

describe("QuoteSummary", () => {
  it("shows the shared subtotal and chargeable weight (kg)", () => {
    render(<QuoteSummary draft={roadDraft} currency="USD" />);
    // sharedSubtotal = 200 (charge) + 300 (warehouse) = 500; chargeableWeightKg = 1500
    const sharedRow = screen.getByText("Shared subtotal").closest("div");
    expect(sharedRow).toHaveTextContent("500.00");
    expect(screen.getByTestId("total-chargeable")).toHaveTextContent("1500.000");
  });

  it("Road: shows two totals side by side — Dedicated priced, Groupage blank", () => {
    render(<QuoteSummary draft={roadDraft} currency="USD" />);
    expect(screen.getAllByTestId(/^grand-total-/)).toHaveLength(2);

    // Dedicated: rateAmount 500 + sharedSubtotal 500 = 1000
    const dedicated = screen.getByTestId("grand-total-DEDICATED");
    expect(dedicated).toHaveTextContent("Dedicated total");
    expect(dedicated).toHaveTextContent("1,000.00");
    expect(dedicated).toHaveTextContent("USD");

    // Groupage: no row priced → rateAmount null → blank ("–"), not "500.00"
    const groupage = screen.getByTestId("grand-total-GROUPAGE");
    expect(groupage).toHaveTextContent("Groupage total");
    expect(groupage).toHaveTextContent("–");
    expect(groupage).not.toHaveTextContent("USD");
  });

  it("Air: shows a single Air total, never blank even though rateAmount is always null", () => {
    render(<QuoteSummary draft={airDraft} currency="USD" />);
    expect(screen.getAllByTestId(/^grand-total-/)).toHaveLength(1);

    const air = screen.getByTestId("grand-total-AIR");
    expect(air).toHaveTextContent("Air total");
    expect(air).toHaveTextContent("900.00"); // sharedSubtotal only (900 + 0 warehouse)
    expect(air).not.toHaveTextContent("–");
  });

  it("Sea: shows two totals side by side — FCL priced, LCL blank", () => {
    render(<QuoteSummary draft={seaDraft} currency="USD" />);
    expect(screen.getAllByTestId(/^grand-total-/)).toHaveLength(2);

    // FCL: rateAmount 1200 + sharedSubtotal 150 (Origin THC, no warehouse) = 1350
    const fcl = screen.getByTestId("grand-total-FCL");
    expect(fcl).toHaveTextContent("FCL total");
    expect(fcl).toHaveTextContent("1,350.00");
    expect(fcl).toHaveTextContent("USD");

    // LCL: unpriced → rateAmount null → blank ("–")
    const lcl = screen.getByTestId("grand-total-LCL");
    expect(lcl).toHaveTextContent("LCL total");
    expect(lcl).toHaveTextContent("–");
    expect(lcl).not.toHaveTextContent("USD");
  });
});
