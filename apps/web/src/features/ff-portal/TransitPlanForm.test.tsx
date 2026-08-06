import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch } from "react-hook-form";
import type { QuoteDraft, FreightMode } from "@svyft/shared";
import { TransitPlanForm } from "./TransitPlanForm";

function baseDefaults(mode: FreightMode | null): QuoteDraft {
  return {
    legId: "L1",
    mode,
    currency: "USD",
    quoteValidityUntil: null,
    cargo: [],
    charges: [],
    trucking: [],
    seaRates: [],
    warehouse: [],
    transit: { departureDate: null, arrivalDate: null, guaranteedTransitDays: null },
    dgSurchargeNote: null,
    termsConditions: null,
  };
}

/** Renders TransitPlanForm inside a real RHF form, exposing `transit` via useWatch for assertions. */
function Harness({ mode }: { mode: FreightMode | null }) {
  const form = useForm<QuoteDraft>({ defaultValues: baseDefaults(mode) });
  const transit = useWatch({ control: form.control, name: "transit" });
  return (
    <FormProvider {...form}>
      <TransitPlanForm mode={mode} />
      <output data-testid="guaranteed">{transit?.guaranteedTransitDays ?? ""}</output>
      <output data-testid="planned-departure">{transit?.plannedDeparture ?? ""}</output>
    </FormProvider>
  );
}

describe("TransitPlanForm — Guaranteed Transit Time (mandatory, every mode)", () => {
  it("always renders the Guaranteed Transit Time field, regardless of mode", () => {
    (["ROAD", "AIR", "SEA", null] as const).forEach((mode) => {
      const { unmount } = render(<Harness mode={mode} />);
      expect(screen.getByLabelText(/guaranteed transit time/i)).toBeInTheDocument();
      unmount();
    });
  });

  it("writes a numeric value to transit.guaranteedTransitDays", async () => {
    render(<Harness mode="AIR" />);
    const input = screen.getByLabelText(/guaranteed transit time/i);
    await userEvent.type(input, "5");
    expect(screen.getByTestId("guaranteed").textContent).toBe("5");
  });
});

describe("TransitPlanForm — Road", () => {
  it("renders the Road-specific Planned Pickup Date field and no Air/Sea fields", () => {
    render(<Harness mode="ROAD" />);
    expect(screen.getByLabelText(/planned pickup date/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/airline/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/flight number/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/shipping line/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/vessel/i)).not.toBeInTheDocument();
  });
});

describe("TransitPlanForm — Air", () => {
  it("renders airline/flightNumber/plannedDeparture/plannedArrival and no Road/Sea fields", () => {
    render(<Harness mode="AIR" />);
    expect(screen.getByLabelText(/^airline/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/flight number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/planned departure/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/planned arrival/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/planned pickup date/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/shipping line/i)).not.toBeInTheDocument();
  });

  it("writes an ISO instant to transit.plannedDeparture when a departure datetime is chosen", async () => {
    render(<Harness mode="AIR" />);
    await userEvent.type(screen.getByLabelText(/planned departure/i), "2026-08-05T10:00");
    const written = screen.getByTestId("planned-departure").textContent ?? "";
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isFinite(new Date(written).getTime())).toBe(true);
  });

  it("writes text values to airline and flightNumber", async () => {
    render(<Harness mode="AIR" />);
    await userEvent.type(screen.getByLabelText(/^airline/i), "Emirates SkyCargo");
    await userEvent.type(screen.getByLabelText(/flight number/i), "EK9701");
    expect(screen.getByLabelText(/^airline/i)).toHaveValue("Emirates SkyCargo");
    expect(screen.getByLabelText(/flight number/i)).toHaveValue("EK9701");
  });
});

describe("TransitPlanForm — Sea", () => {
  it("renders shippingLine/vesselVoyage/etd/eta and no Road/Air fields", () => {
    render(<Harness mode="SEA" />);
    expect(screen.getByLabelText(/shipping line/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/vessel \/ voyage/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^etd/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^eta/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/planned pickup date/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^airline/i)).not.toBeInTheDocument();
  });

  it("writes an ISO instant to transit.etd and text to shippingLine/vesselVoyage", async () => {
    function SeaHarness() {
      const form = useForm<QuoteDraft>({ defaultValues: baseDefaults("SEA") });
      const etd = useWatch({ control: form.control, name: "transit.etd" });
      return (
        <FormProvider {...form}>
          <TransitPlanForm mode="SEA" />
          <output data-testid="etd">{etd ?? ""}</output>
        </FormProvider>
      );
    }
    render(<SeaHarness />);
    await userEvent.type(screen.getByLabelText(/shipping line/i), "Maersk");
    await userEvent.type(screen.getByLabelText(/vessel \/ voyage/i), "MSC Anna / 123W");
    await userEvent.type(screen.getByLabelText(/^etd/i), "2026-09-01T08:00");

    expect(screen.getByLabelText(/shipping line/i)).toHaveValue("Maersk");
    expect(screen.getByLabelText(/vessel \/ voyage/i)).toHaveValue("MSC Anna / 123W");
    const written = screen.getByTestId("etd").textContent ?? "";
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
