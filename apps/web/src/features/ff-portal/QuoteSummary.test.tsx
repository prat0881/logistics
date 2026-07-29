import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QuoteDraft } from "@svyft/shared";
import { QuoteSummary } from "./QuoteSummary";

const draft: QuoteDraft = {
  legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null,
  cargo: [{ cargoItemId: "c1", grossWtT: 1.5, cbm: 2.5, isDangerous: false, freightDensity: 1000 }],
  charges: [{ zone: "ORIGIN", presetKey: "x", label: "THC", amount: 500 }, { zone: "MAIN_FREIGHT", presetKey: "y", label: "Freight", amount: 2000 }],
  trucking: [], warehouse: [{ warehousePointId: "w1", position: "ORIGIN", label: "Origin warehouse", amount: 300 }],
  transit: null, dgSurchargeNote: null, termsConditions: null,
};

describe("QuoteSummary", () => {
  it("shows subtotals, chargeable weight and grand total with currency", () => {
    render(<QuoteSummary draft={draft} currency="USD" />);
    expect(screen.getByTestId("grand-total")).toHaveTextContent("2,800.00");   // 500+2000+300
    expect(screen.getByTestId("grand-total")).toHaveTextContent("USD");
    expect(screen.getByTestId("total-chargeable")).toHaveTextContent("2.500"); // max(1.5, 2.5)
  });

  it("hides zone/trucking/warehouse rows when draft has none", () => {
    const emptyDraft: QuoteDraft = {
      legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null,
      cargo: [],
      charges: [],
      trucking: [],
      warehouse: [],
      transit: null, dgSurchargeNote: null, termsConditions: null,
    };
    render(<QuoteSummary draft={emptyDraft} currency="EUR" />);
    expect(screen.queryByText(/origin subtotal/i)).toBeNull();
    expect(screen.queryByText(/main freight subtotal/i)).toBeNull();
    expect(screen.queryByText(/destination subtotal/i)).toBeNull();
    expect(screen.queryByText(/trucking subtotal/i)).toBeNull();
    expect(screen.queryByText(/warehouse subtotal/i)).toBeNull();
    // grand total is always visible, shows zero
    expect(screen.getByTestId("grand-total")).toHaveTextContent("0.00");
    expect(screen.getByTestId("grand-total")).toHaveTextContent("EUR");
  });
});
