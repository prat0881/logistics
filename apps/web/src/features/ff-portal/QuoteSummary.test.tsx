import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QuoteDraft } from "@svyft/shared";
import { QuoteSummary } from "./QuoteSummary";

const roadDraft: QuoteDraft = {
  legId: "L1",
  mode: "ROAD",
  currency: "USD",
  quoteValidityUntil: null,
  chargedWeightKg: 1500, // v3: leg-level, not per-package
  notes: null,
  cargo: [{ packageId: "p1", grossWtKg: 1500, cbm: 2.5 }],
  // v3: charges are per-variant matrix cells — the same "Fuel surcharge" priced identically under
  // both columns (a charge no longer has a variant-independent "shared" cell).
  charges: [
    { zone: null, presetKey: null, label: "Fuel surcharge", amount: 200, rateVariant: "DEDICATED" },
    { zone: null, presetKey: null, label: "Fuel surcharge", amount: 200, rateVariant: "GROUPAGE" },
  ],
  trucking: [
    {
      legEndpointPointId: "p1",
      truckingType: "DEDICATED",
      basis: "PER_TRUCK",
      amount: 500,
      rateVariant: "DEDICATED",
      tonnage: "T_5",
    },
    {
      legEndpointPointId: "p1",
      truckingType: "GROUPAGE",
      basis: "PER_TRUCK",
      amount: null,
      rateVariant: "GROUPAGE",
      tonnage: null,
    },
  ],
  seaRates: [],
  warehouse: [
    { warehousePointId: "w1", position: "ORIGIN", label: "Origin warehouse", amount: 300 },
  ],
  transit: null,
  dgSurchargeNote: null,
  termsConditions: null,
};

const airDraft: QuoteDraft = {
  legId: "L1",
  mode: "AIR",
  currency: "USD",
  quoteValidityUntil: null,
  chargedWeightKg: 1000, // v3: leg-level, not per-package
  notes: null,
  cargo: [{ packageId: "p1", grossWtKg: 1000, cbm: 2 }],
  charges: [
    { zone: "MAIN_FREIGHT", presetKey: "x", label: "Air Freight", amount: 900, rateVariant: null },
  ],
  trucking: [],
  seaRates: [],
  warehouse: [],
  transit: null,
  dgSurchargeNote: null,
  termsConditions: null,
};

const seaDraft: QuoteDraft = {
  legId: "L1",
  mode: "SEA",
  currency: "USD",
  quoteValidityUntil: null,
  chargedWeightKg: 2000, // v3: leg-level, not per-package
  notes: null,
  cargo: [{ packageId: "p1", grossWtKg: 2000, cbm: 5 }],
  charges: [
    { zone: "ORIGIN", presetKey: null, label: "Origin THC", amount: 150, rateVariant: "FCL" },
  ],
  trucking: [],
  seaRates: [
    { rateVariant: "FCL", containerSize: "TWENTY", amount: 1200 },
    { rateVariant: "LCL", containerSize: null, amount: null },
  ],
  warehouse: [],
  transit: null,
  dgSurchargeNote: null,
  termsConditions: null,
};

describe("QuoteSummary", () => {
  it("shows the shared subtotal and chargeable weight (kg)", () => {
    render(<QuoteSummary draft={roadDraft} currency="USD" />);
    // v3: sharedSubtotal is the warehouse total ONLY (charges are per-variant matrix cells now,
    // folded into each variant's own grandTotal instead — see computeQuoteTotals) = 300 (warehouse);
    // chargeableWeightKg is the leg-level QuoteDraft.chargedWeightKg = 1500.
    const sharedRow = screen.getByText("Shared subtotal").closest("div");
    expect(sharedRow).toHaveTextContent("300.00");
    expect(screen.getByTestId("total-chargeable")).toHaveTextContent("1500.000");
  });

  it("Road: shows two totals side by side — Dedicated priced, Groupage blank", () => {
    render(<QuoteSummary draft={roadDraft} currency="USD" />);
    expect(screen.getAllByTestId(/^grand-total-/)).toHaveLength(2);

    // Dedicated: chargeSum 200 (Fuel surcharge, DEDICATED column) + rateAmount 500 + sharedSubtotal
    // (warehouse) 300 = 1000
    const dedicated = screen.getByTestId("grand-total-DEDICATED");
    expect(dedicated).toHaveTextContent("Dedicated total");
    expect(dedicated).toHaveTextContent("1,000.00");
    expect(dedicated).toHaveTextContent("USD");

    // Groupage: its own freight rate (trucking) is unpriced → rateAmount null → blank ("–")
    // regardless of its 200 of charges — QuoteSummary's blank rule keys off rateAmount alone.
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
    expect(air).toHaveTextContent("900.00"); // chargeSum (Air Freight, rateVariant: null) 900 + 0 warehouse
    expect(air).not.toHaveTextContent("–");
  });

  it("Sea: shows two totals side by side — FCL priced, LCL blank", () => {
    render(<QuoteSummary draft={seaDraft} currency="USD" />);
    expect(screen.getAllByTestId(/^grand-total-/)).toHaveLength(2);

    // FCL: chargeSum 150 (Origin THC, FCL column) + rateAmount 1200 + sharedSubtotal (warehouse) 0 = 1350
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
