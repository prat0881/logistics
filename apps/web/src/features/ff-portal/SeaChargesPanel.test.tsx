import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch, type Control } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { SeaChargesPanel } from "./SeaChargesPanel";

const seaRatesDefaults: QuoteDraft["seaRates"] = [
  { rateVariant: "FCL", containerSize: null, amount: null },
  { rateVariant: "LCL", containerSize: null, amount: null },
];

const defaultValues: QuoteDraft = {
  legId: "L1",
  mode: "SEA",
  currency: "USD",
  quoteValidityUntil: null,
  cargo: [],
  charges: [],
  trucking: [],
  seaRates: seaRatesDefaults,
  warehouse: [],
  transit: null,
  dgSurchargeNote: null,
  termsConditions: null,
};

function Harness() {
  const form = useForm<QuoteDraft>({ defaultValues });
  return (
    <FormProvider {...form}>
      <SeaChargesPanel />
    </FormProvider>
  );
}

// Debug probe on RHF form state — mirrors the pattern in HeavyWeightCalcRow.test.tsx.
function SeaRatesDebug({ control }: { control: Control<QuoteDraft> }) {
  const rows = useWatch({ control, name: "seaRates" });
  return <div data-testid="sea-rates-debug">{JSON.stringify(rows)}</div>;
}

function HarnessWithDebug() {
  const form = useForm<QuoteDraft>({ defaultValues });
  return (
    <FormProvider {...form}>
      <SeaChargesPanel />
      <SeaRatesDebug control={form.control} />
    </FormProvider>
  );
}

describe("SeaChargesPanel", () => {
  it("renders two rows headed FCL and LCL; only FCL has a container-size Select", () => {
    render(<Harness />);

    expect(screen.getByText("FCL")).toBeInTheDocument();
    expect(screen.getByText("LCL")).toBeInTheDocument();

    // Both rows carry Amount + Remarks
    expect(screen.getByLabelText(/amount for fcl/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/remarks for fcl/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/amount for lcl/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/remarks for lcl/i)).toBeInTheDocument();

    // Container-size Select only on the FCL row — LCL has none
    expect(screen.getByRole("combobox", { name: /container size for fcl/i })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /container size for lcl/i })).toBeNull();

    // The two rows are fixed (seeded by draftFromDto) — no add/remove control
    expect(screen.queryByRole("button", { name: /add/i })).toBeNull();
  });

  it("entering an amount writes seaRates[i].amount", async () => {
    render(<HarnessWithDebug />);
    const debug = screen.getByTestId("sea-rates-debug");
    expect(debug).toHaveTextContent(/"amount":null.*"amount":null/);

    await userEvent.type(screen.getByLabelText(/amount for fcl/i), "900");
    expect(debug).toHaveTextContent(/"rateVariant":"FCL","containerSize":null,"amount":900/);

    await userEvent.type(screen.getByLabelText(/amount for lcl/i), "450");
    expect(debug).toHaveTextContent(/"rateVariant":"LCL","containerSize":null,"amount":450/);
  });

  it("selecting a container writes seaRates[0].containerSize", async () => {
    render(<HarnessWithDebug />);
    const debug = screen.getByTestId("sea-rates-debug");
    expect(debug).toHaveTextContent(/"rateVariant":"FCL","containerSize":null/);

    const trigger = screen.getByRole("combobox", { name: /container size for fcl/i });
    await userEvent.click(trigger);

    const option = screen.getByRole("option", { name: "20'" });
    await userEvent.click(option);

    expect(debug).toHaveTextContent(/"rateVariant":"FCL","containerSize":"TWENTY"/);
  });
});
