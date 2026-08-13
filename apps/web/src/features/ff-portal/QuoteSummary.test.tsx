import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QuoteDraft } from "@svyft/shared";
import { QuoteSummary } from "./QuoteSummary";

// v4 (design D1): every `charges` row is COMMON — ONE row per line (`rateVariant: null`), priced
// once, folded into EVERY variant's Grand Total equally via `additionalChargeSum`. Freight is the
// one thing that stays per-variant (`trucking`/`seaRates`).
const roadDraft: QuoteDraft = {
  legId: "L1",
  mode: "ROAD",
  currency: "USD",
  quoteValidityUntil: null,
  chargedWeightKg: 1500, // v3: leg-level, not per-package
  notes: null,
  cargo: [{ packageId: "p1", grossWtKg: 1500, cbm: 2.5 }],
  charges: [
    { zone: null, presetKey: null, label: "Fuel surcharge", amount: 200, rateVariant: null },
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

// Air's charges were ALREADY common in v3 (its single implicit column never fanned out) — this
// fixture is unchanged by the v4 model.
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
    { zone: "ORIGIN", presetKey: null, label: "Origin THC", amount: 150, rateVariant: null },
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
  it("shows the Additional-charges subtotal, Warehouse subtotal, and chargeable weight (kg)", () => {
    render(<QuoteSummary draft={roadDraft} currency="USD" />);
    // additionalChargeSum = 200 (the one common Fuel surcharge line); warehouseSum = 300;
    // chargeableWeightKg is the leg-level QuoteDraft.chargedWeightKg = 1500.
    expect(screen.getByTestId("total-additional-charges")).toHaveTextContent("200.00");
    expect(screen.getByTestId("total-warehouse")).toHaveTextContent("300.00");
    expect(screen.getByTestId("total-chargeable")).toHaveTextContent("1500.000");
  });

  it("Road: shows two totals side by side — Dedicated priced, Groupage shows its real total too (Round 4)", () => {
    render(<QuoteSummary draft={roadDraft} currency="USD" />);
    expect(screen.getAllByTestId(/^grand-total-/)).toHaveLength(2);

    // Dedicated: rateAmount 500 + additionalChargeSum 200 (common, same for every variant) +
    // warehouseSum 300 = 1000.
    const dedicated = screen.getByTestId("grand-total-DEDICATED");
    expect(dedicated).toHaveTextContent("Dedicated total");
    expect(dedicated).toHaveTextContent("1,000.00");
    expect(dedicated).toHaveTextContent("USD");

    // Groupage: its own freight rate (trucking) is unpriced, but the common charges (200) and
    // warehouse (300) DO apply to it — Round 4: the Grand total shows the real number (0 + 200 +
    // 300 = 500) whenever ANY input is priced, not just the variant's own rate. Contrast with the
    // genuinely-untouched-variant test below, which still shows "–".
    const groupage = screen.getByTestId("grand-total-GROUPAGE");
    expect(groupage).toHaveTextContent("Groupage total");
    expect(groupage).toHaveTextContent("500.00");
    expect(groupage).toHaveTextContent("USD");
  });

  it("a variant with nothing priced anywhere (no freight, no common charge, no warehouse) stays blank", () => {
    const untouchedDraft: QuoteDraft = {
      ...roadDraft,
      charges: [],
      warehouse: [],
      trucking: roadDraft.trucking.map((t) => ({ ...t, amount: null })),
    };
    render(<QuoteSummary draft={untouchedDraft} currency="USD" />);
    const dedicated = screen.getByTestId("grand-total-DEDICATED");
    const groupage = screen.getByTestId("grand-total-GROUPAGE");
    expect(dedicated).toHaveTextContent("–");
    expect(dedicated).not.toHaveTextContent("USD");
    expect(groupage).toHaveTextContent("–");
    expect(groupage).not.toHaveTextContent("USD");
  });

  it("Air: shows a single Air total, never blank even though rateAmount is always null", () => {
    render(<QuoteSummary draft={airDraft} currency="USD" />);
    expect(screen.getAllByTestId(/^grand-total-/)).toHaveLength(1);
    expect(screen.getByTestId("total-additional-charges")).toHaveTextContent("900.00");

    const air = screen.getByTestId("grand-total-AIR");
    expect(air).toHaveTextContent("Air total");
    expect(air).toHaveTextContent("900.00"); // additionalChargeSum (Air Freight) 900 + 0 warehouse
    expect(air).not.toHaveTextContent("–");
  });

  it("Sea: shows two totals side by side — FCL priced, LCL shows its real total too (Round 4, same rule as Road)", () => {
    render(<QuoteSummary draft={seaDraft} currency="USD" />);
    expect(screen.getAllByTestId(/^grand-total-/)).toHaveLength(2);

    // FCL: rateAmount 1200 + additionalChargeSum 150 (Origin THC, common) + warehouseSum 0 = 1350.
    const fcl = screen.getByTestId("grand-total-FCL");
    expect(fcl).toHaveTextContent("FCL total");
    expect(fcl).toHaveTextContent("1,350.00");
    expect(fcl).toHaveTextContent("USD");

    // LCL: its own rate is unpriced, but the common Origin THC charge (150) DOES apply to it →
    // real total (0 + 150 + 0 = 150), not blank — same Round-4 rule as Road's Groupage above.
    const lcl = screen.getByTestId("grand-total-LCL");
    expect(lcl).toHaveTextContent("LCL total");
    expect(lcl).toHaveTextContent("150.00");
    expect(lcl).toHaveTextContent("USD");
  });
});
