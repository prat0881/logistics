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
  chargedWeightKg: null,
  notes: null,
  cargo: [],
  charges: [
    {
      zone: "MAIN_FREIGHT",
      definitionKey: "AIR_MAIN_HEAVY_WEIGHT",
      presetKey: null,
      label: LABEL,
      amount: null,
      rateVariant: null, // Air's single implicit column
      pieceWeightKg: null,
      airlineLimitKg: null,
      ratePerExcessKg: null,
    },
  ],
  trucking: [],
  seaRates: [],
  warehouse: [],
  transit: { departureDate: null, arrivalDate: null, guaranteedTransitDaysByVariant: {} },
  dgSurchargeNote: null,
  termsConditions: null,
};

// Debug probe on RHF form state — mirrors the pattern in ChargedWeightGrid.test.tsx.
function ChargesDebug({ control }: { control: Control<QuoteDraft> }) {
  const rows = useWatch({ control, name: "charges" });
  return <div data-testid="charges-debug">{JSON.stringify(rows)}</div>;
}

// totalGrossWtKg defaults generously high so the pre-existing calc-only tests below (piece 800 /
// 1200) never trip the new D4 piece-vs-gross check unless a test deliberately passes a lower one.
function Harness({ totalGrossWtKg = 5000 }: { totalGrossWtKg?: number } = {}) {
  const form = useForm<QuoteDraft>({ defaultValues: defaultDraft });
  return (
    <FormProvider {...form}>
      <HeavyWeightCalcRow index={0} label={LABEL} totalGrossWtKg={totalGrossWtKg} />
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

// ── design D4 / finding #11: piece weight can't exceed the leg's total cargo gross weight — the
// client mirror of quote-engine.ts's Q_PIECE_WEIGHT (`c.pieceWeightKg > Σ draft.cargo[].grossWtKg`,
// strict >). The leg total is passed in as a prop (ChargeMatrix computes it from `draft.cargo`)
// rather than read off the form here, since HeavyWeightCalcRow only has its OWN charge index in
// scope, not the whole draft.
describe("HeavyWeightCalcRow — piece weight vs. the leg's total cargo gross weight (design D4/#11)", () => {
  it("shows an inline error when piece weight exceeds the leg's total cargo gross weight", async () => {
    render(<Harness totalGrossWtKg={1000} />);
    await userEvent.type(pieceInput(), "1200");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("1200");
    expect(alert).toHaveTextContent("1000");
    expect(alert).toHaveTextContent(/cannot exceed/i);
  });

  it("does not show an error when piece weight is within the leg's total cargo gross weight", async () => {
    render(<Harness totalGrossWtKg={1000} />);
    await userEvent.type(pieceInput(), "800");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not error exactly at the total gross weight (strict >, matches the engine's Q_PIECE_WEIGHT)", async () => {
    render(<Harness totalGrossWtKg={1000} />);
    await userEvent.type(pieceInput(), "1000");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the error once the piece weight is corrected back within range", async () => {
    render(<Harness totalGrossWtKg={1000} />);
    await userEvent.type(pieceInput(), "1200");
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await userEvent.clear(pieceInput());
    await userEvent.type(pieceInput(), "900");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still writes the over-limit piece weight into RHF form state (surfaces, not silently drops, the bad value so the submit gate can also catch it)", async () => {
    render(<Harness totalGrossWtKg={1000} />);
    await userEvent.type(pieceInput(), "1200");
    expect(screen.getByTestId("charges-debug")).toHaveTextContent(/"pieceWeightKg":1200/);
  });

  it("shows no error while piece weight is unset, regardless of the gross-weight limit", () => {
    render(<Harness totalGrossWtKg={0} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
