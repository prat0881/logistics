import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch, type Control } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { HeavyWeightCalcRow } from "./HeavyWeightCalcRow";

const LABEL = "Heavy Weight Surcharge";

const defaultDraft: QuoteDraft = {
  legId: "L1",
  mode: "AIR",
  currency: "USD",
  quoteValidityUntil: null,
  cargo: [],
  charges: [
    {
      zone: "MAIN_FREIGHT",
      definitionKey: "AIR_MAIN_HEAVY_WEIGHT",
      presetKey: null,
      label: LABEL,
      amount: null,
      pieceWeightKg: null,
      airlineLimitKg: null,
      ratePerExcessKg: null,
    },
  ],
  trucking: [],
  seaRates: [],
  warehouse: [],
  transit: { departureDate: null, arrivalDate: null, guaranteedTransitDays: null },
  dgSurchargeNote: null,
  termsConditions: null,
};

// Debug probe on RHF form state — mirrors the pattern in ChargedWeightGrid.test.tsx.
function ChargesDebug({ control }: { control: Control<QuoteDraft> }) {
  const rows = useWatch({ control, name: "charges" });
  return <div data-testid="charges-debug">{JSON.stringify(rows)}</div>;
}

function Harness() {
  const form = useForm<QuoteDraft>({ defaultValues: defaultDraft });
  return (
    <FormProvider {...form}>
      <HeavyWeightCalcRow index={0} label={LABEL} />
      <ChargesDebug control={form.control} />
    </FormProvider>
  );
}

const pieceInput = () => screen.getByLabelText(new RegExp(`piece weight.*${LABEL}`, "i"));
const limitInput = () => screen.getByLabelText(new RegExp(`airline limit.*${LABEL}`, "i"));
const rateInput = () => screen.getByLabelText(new RegExp(`rate per excess kg.*${LABEL}`, "i"));

describe("HeavyWeightCalcRow", () => {
  it("renders the 3 labeled inputs for the charge line", () => {
    render(<Harness />);
    expect(pieceInput()).toBeInTheDocument();
    expect(limitInput()).toBeInTheDocument();
    expect(rateInput()).toBeInTheDocument();
  });

  it("shows — until all 3 inputs are filled", () => {
    render(<Harness />);
    expect(screen.getByTestId("hwc-amount-0")).toHaveTextContent("—");
  });

  it("computes and shows 400 for piece=1200, limit=1000, rate=2", async () => {
    render(<Harness />);
    await userEvent.type(pieceInput(), "1200");
    await userEvent.type(limitInput(), "1000");
    await userEvent.type(rateInput(), "2");
    expect(screen.getByTestId("hwc-amount-0")).toHaveTextContent("400.00");
  });

  it("computes 0 (clamped, not negative) for piece=800, limit=1000, rate=2", async () => {
    render(<Harness />);
    await userEvent.type(pieceInput(), "800");
    await userEvent.type(limitInput(), "1000");
    await userEvent.type(rateInput(), "2");
    expect(screen.getByTestId("hwc-amount-0")).toHaveTextContent("0.00");
  });

  it("writes the 3 typed inputs onto charges.0 in RHF form state", async () => {
    render(<Harness />);
    await userEvent.type(pieceInput(), "1200");
    await userEvent.type(limitInput(), "1000");
    await userEvent.type(rateInput(), "2");
    const debug = screen.getByTestId("charges-debug");
    expect(debug).toHaveTextContent(/"pieceWeightKg":1200/);
    expect(debug).toHaveTextContent(/"airlineLimitKg":1000/);
    expect(debug).toHaveTextContent(/"ratePerExcessKg":2/);
  });

  it("never writes `amount` — the engine derives it from the 3 inputs at submit", async () => {
    render(<Harness />);
    await userEvent.type(pieceInput(), "1200");
    await userEvent.type(limitInput(), "1000");
    await userEvent.type(rateInput(), "2");
    expect(screen.getByTestId("charges-debug")).toHaveTextContent(/"amount":null/);
  });
});
