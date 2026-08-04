import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { RoadChargesPanel } from "./RoadChargesPanel";

function Harness() {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "ROAD", currency: "USD", quoteValidityUntil: null, cargo: [],
    charges: [
      { zone: null, definitionKey: "ROAD_FUEL_SURCHARGE", presetKey: null, label: "Fuel Surcharge", amount: null },
    ],
    trucking: [], warehouse: [], transit: null, dgSurchargeNote: null, termsConditions: null } });
  return <FormProvider {...form}><RoadChargesPanel /></FormProvider>;
}

describe("RoadChargesPanel", () => {
  it("renders a preset line's label read-only and binds its amount", async () => {
    render(<Harness />);

    // Preset (definitionKey set) → rendered as a plain <span>, not an editable input.
    const labelEl = screen.getByText("Fuel Surcharge");
    expect(labelEl.tagName).toBe("SPAN");
    expect(screen.queryByLabelText("Custom line label")).not.toBeInTheDocument();

    // Amount binds via setValue(..., { shouldDirty: true }).
    const amount = screen.getByLabelText(/amount.*Fuel Surcharge/i);
    await userEvent.type(amount, "450");
    expect(amount).toHaveValue(450);
  });

  it("+ Add line appends a zone: null custom row", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /add line/i }));

    // Original preset row is untouched...
    expect(screen.getByText("Fuel Surcharge")).toBeInTheDocument();
    // ...and exactly one new editable custom row (zone: null, else it wouldn't render here) appeared.
    expect(screen.getAllByDisplayValue("Custom charge").length).toBe(1);
  });
});
