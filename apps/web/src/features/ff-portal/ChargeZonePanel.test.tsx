import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { ChargeZonePanel } from "./ChargeZonePanel";

function Harness() {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null, cargo: [],
    charges: [
      { zone: "ORIGIN", presetKey: "AIR_ORIGIN_THC", label: "Origin THC", amount: null },
      { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_FREIGHT", label: "Air Freight", amount: null },
    ],
    trucking: [], warehouse: [], transit: null, dgSurchargeNote: null, termsConditions: null } });
  return <FormProvider {...form}><ChargeZonePanel /></FormProvider>;
}

describe("ChargeZonePanel", () => {
  it("shows preset lines grouped by zone and a live origin subtotal", async () => {
    render(<Harness />);
    expect(screen.getByText("Origin THC")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/amount.*Origin THC/i), "500");
    const origin = screen.getByTestId("zone-subtotal-ORIGIN");
    expect(within(origin).getByText("500.00")).toBeInTheDocument();
  });
  it("adds a custom line to a zone", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /add line.*origin/i }));
    expect(screen.getAllByDisplayValue("Custom charge").length).toBe(1);
  });
  it("custom line amount updates zone subtotal via absolute index binding", async () => {
    render(<Harness />);
    // Append a custom line to MAIN_FREIGHT (it will sit at absolute index 2)
    await userEvent.click(screen.getByRole("button", { name: /add line.*main freight/i }));
    // Type into the custom line's amount field — label is "Custom charge"
    const amountInputs = screen.getAllByLabelText(/amount.*Custom charge/i);
    await userEvent.type(amountInputs[0], "250");
    const mainFreightSubtotal = screen.getByTestId("zone-subtotal-MAIN_FREIGHT");
    expect(within(mainFreightSubtotal).getByText("250.00")).toBeInTheDocument();
  });
});
