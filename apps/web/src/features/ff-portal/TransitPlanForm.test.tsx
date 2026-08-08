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
    chargedWeightKg: null,
    notes: null,
    cargo: [],
    charges: [],
    trucking: [],
    seaRates: [],
    warehouse: [],
    transit: { departureDate: null, arrivalDate: null, guaranteedTransitDaysByVariant: {} },
    dgSurchargeNote: null,
    termsConditions: null,
  };
}

/** Renders TransitPlanForm inside a real RHF form, exposing `transit` via useWatch for assertions. */
function Harness({ mode, legId = "L1" }: { mode: FreightMode | null; legId?: string }) {
  const form = useForm<QuoteDraft>({ defaultValues: baseDefaults(mode) });
  const transit = useWatch({ control: form.control, name: "transit" });
  return (
    <FormProvider {...form}>
      <TransitPlanForm mode={mode} legId={legId} />
      <output data-testid="guaranteed-by-variant">
        {JSON.stringify(transit?.guaranteedTransitDaysByVariant ?? {})}
      </output>
      <output data-testid="planned-departure">{transit?.plannedDeparture ?? ""}</output>
    </FormProvider>
  );
}

describe("TransitPlanForm — Guaranteed Transit Time (mandatory, per rate-variant column)", () => {
  it("renders a single Air-labelled field for Air and for an unresolved mode (single implicit column)", () => {
    ([null, "AIR"] as const).forEach((mode) => {
      const { unmount } = render(<Harness mode={mode} />);
      expect(screen.getAllByLabelText(/guaranteed transit time/i)).toHaveLength(1);
      expect(screen.getByLabelText(/guaranteed transit time.*air/i)).toBeInTheDocument();
      unmount();
    });
  });

  it("renders two fields for Road, one per variant (Dedicated + Groupage), matching the charge matrix's columns", () => {
    render(<Harness mode="ROAD" />);
    expect(screen.getAllByLabelText(/guaranteed transit time/i)).toHaveLength(2);
    expect(screen.getByLabelText(/guaranteed transit time.*dedicated/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/guaranteed transit time.*groupage/i)).toBeInTheDocument();
  });

  it("renders two fields for Sea, one per variant (FCL + LCL), matching the charge matrix's columns", () => {
    render(<Harness mode="SEA" />);
    expect(screen.getAllByLabelText(/guaranteed transit time/i)).toHaveLength(2);
    expect(screen.getByLabelText(/guaranteed transit time.*fcl/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/guaranteed transit time.*lcl/i)).toBeInTheDocument();
  });

  it("writes a numeric value keyed by AIR_VARIANT_KEY for Air's single column", async () => {
    render(<Harness mode="AIR" />);
    const input = screen.getByLabelText(/guaranteed transit time.*air/i);
    await userEvent.type(input, "5");
    expect(JSON.parse(screen.getByTestId("guaranteed-by-variant").textContent ?? "{}")).toEqual({
      AIR: 5,
    });
  });

  it("writes independent values per variant for Road (Dedicated and Groupage don't clobber each other)", async () => {
    render(<Harness mode="ROAD" />);
    await userEvent.type(screen.getByLabelText(/guaranteed transit time.*dedicated/i), "3");
    await userEvent.type(screen.getByLabelText(/guaranteed transit time.*groupage/i), "7");
    expect(JSON.parse(screen.getByTestId("guaranteed-by-variant").textContent ?? "{}")).toEqual({
      DEDICATED: 3,
      GROUPAGE: 7,
    });
  });

  it("writes independent values per variant for Sea (FCL and LCL don't clobber each other)", async () => {
    render(<Harness mode="SEA" />);
    await userEvent.type(screen.getByLabelText(/guaranteed transit time.*fcl/i), "10");
    await userEvent.type(screen.getByLabelText(/guaranteed transit time.*lcl/i), "20");
    expect(JSON.parse(screen.getByTestId("guaranteed-by-variant").textContent ?? "{}")).toEqual({
      FCL: 10,
      LCL: 20,
    });
  });
});

describe("TransitPlanForm — leg-qualified ids (a11y, finding #4)", () => {
  it("prefixes every field id with the legId so two same-mode legs don't collide", () => {
    const { container, unmount } = render(<Harness mode="AIR" legId="LEG-A" />);
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("LEG-A-"))).toBe(true);
    unmount();
  });

  it("renders disjoint id sets for two legs of the same mode (no duplicate DOM ids)", () => {
    const { container: a } = render(<Harness mode="ROAD" legId="LEG-A" />);
    const { container: b } = render(<Harness mode="ROAD" legId="LEG-B" />);
    const aIds = new Set([...a.querySelectorAll("[id]")].map((el) => el.id));
    const bIds = [...b.querySelectorAll("[id]")].map((el) => el.id);
    expect(bIds.length).toBeGreaterThan(0);
    expect(bIds.some((id) => aIds.has(id))).toBe(false); // no shared id between the two legs
  });
});

describe("TransitPlanForm — Road", () => {
  it("renders the Road-specific Planned Pickup Date field and no Air/Sea fields", () => {
    render(<Harness mode="ROAD" />);
    expect(screen.getByLabelText(/planned pickup date/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^airline/i)).not.toBeInTheDocument();
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
          <TransitPlanForm mode="SEA" legId="L1" />
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
