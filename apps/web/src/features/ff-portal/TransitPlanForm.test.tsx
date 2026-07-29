import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { TransitPlanForm } from "./TransitPlanForm";

function Harness() {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null, cargo: [], charges: [], trucking: [], warehouse: [],
    transit: { departureDate: null, arrivalDate: null }, dgSurchargeNote: null, termsConditions: null } });
  const dep = useWatch({ control: form.control, name: "transit.departureDate" });
  return <FormProvider {...form}><TransitPlanForm /><output data-testid="dep">{dep ?? ""}</output></FormProvider>;
}

/** Harness that also exposes carrierSurcharge for branch coverage */
function HarnessWithSurcharge() {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null, cargo: [], charges: [], trucking: [], warehouse: [],
    transit: { departureDate: null, arrivalDate: null }, dgSurchargeNote: null, termsConditions: null } });
  const surcharge = useWatch({ control: form.control, name: "transit.carrierSurcharge" });
  return (
    <FormProvider {...form}>
      <TransitPlanForm />
      <output data-testid="surcharge">{surcharge ?? ""}</output>
      <output data-testid="surcharge-type">{typeof surcharge}</output>
    </FormProvider>
  );
}

describe("TransitPlanForm", () => {
  it("writes an ISO instant when a departure datetime is chosen", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText(/departure/i), "2026-08-05T10:00");
    const written = screen.getByTestId("dep").textContent ?? "";
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isFinite(new Date(written).getTime())).toBe(true);
  });

  it("writes a numeric value when carrierSurcharge is set", async () => {
    render(<HarnessWithSurcharge />);
    const surchargeInput = screen.getByLabelText(/carrier surcharge/i);
    await userEvent.clear(surchargeInput);
    await userEvent.type(surchargeInput, "150");
    expect(screen.getByTestId("surcharge").textContent).toBe("150");
    expect(screen.getByTestId("surcharge-type")).toHaveTextContent("number");
  });
});
