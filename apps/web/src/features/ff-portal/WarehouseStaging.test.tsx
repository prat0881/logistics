import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { WarehouseStaging } from "./WarehouseStaging";

function baseDefaults(wh: QuoteDraft["warehouse"]): QuoteDraft {
  return {
    legId: "L1",
    mode: "AIR",
    currency: "USD",
    quoteValidityUntil: null,
    chargedWeightKg: null,
    notes: null,
    cargo: [],
    charges: [],
    trucking: [],
    seaRates: [],
    warehouse: wh,
    transit: null,
    dgSurchargeNote: null,
    termsConditions: null,
  };
}

function Harness({ wh }: { wh: QuoteDraft["warehouse"] }) {
  const form = useForm<QuoteDraft>({ defaultValues: baseDefaults(wh) });
  return (
    <FormProvider {...form}>
      <WarehouseStaging />
    </FormProvider>
  );
}

/** Same as Harness but also exposes the first row's cargoAcceptanceWindow via useWatch, for
 *  round-trip assertions on the new datetime-local field (design #9). */
function HarnessWithWatch({ wh }: { wh: QuoteDraft["warehouse"] }) {
  const form = useForm<QuoteDraft>({ defaultValues: baseDefaults(wh) });
  const window0 = useWatch({ control: form.control, name: "warehouse.0.cargoAcceptanceWindow" });
  return (
    <FormProvider {...form}>
      <WarehouseStaging />
      <output data-testid="window-0">{window0 ?? ""}</output>
    </FormProvider>
  );
}

describe("WarehouseStaging", () => {
  it("renders the row heading and an amount + acceptance-window field per warehouse endpoint", () => {
    render(
      <Harness
        wh={[
          { warehousePointId: "w1", position: "ORIGIN", label: "Origin warehouse", amount: null },
        ]}
      />,
    );
    expect(screen.getByText("Origin warehouse")).toBeInTheDocument(); // per-row heading keeps its own label
    expect(screen.getByLabelText(/^amount for warehouse$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^cargo acceptance window for warehouse$/i)).toBeInTheDocument();
  });

  it("renders nothing with no warehouse rows", () => {
    const { container } = render(<Harness wh={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("field labels drop the Origin/Destination qualifier even for a Destination row (design #8)", () => {
    render(
      <Harness
        wh={[
          {
            warehousePointId: "w2",
            position: "DESTINATION",
            label: "Destination warehouse",
            amount: null,
          },
        ]}
      />,
    );
    expect(screen.getByText("Destination warehouse")).toBeInTheDocument(); // row heading unaffected
    expect(screen.getByLabelText(/^amount for warehouse$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^cargo acceptance window for warehouse$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/destination/i)).not.toBeInTheDocument(); // no field label carries it
  });

  it("cargo acceptance window is a datetime-local input with min=now (design D3, #9/#10)", () => {
    render(
      <Harness
        wh={[
          { warehousePointId: "w1", position: "ORIGIN", label: "Origin warehouse", amount: null },
        ]}
      />,
    );
    const input = screen.getByLabelText(
      /cargo acceptance window for warehouse/i,
    ) as HTMLInputElement;
    expect(input.type).toBe("datetime-local");
    expect(input.min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(Math.abs(new Date(input.min).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("writes an ISO instant to cargoAcceptanceWindow when a datetime is chosen", async () => {
    render(
      <HarnessWithWatch
        wh={[
          { warehousePointId: "w1", position: "ORIGIN", label: "Origin warehouse", amount: null },
        ]}
      />,
    );
    await userEvent.type(
      screen.getByLabelText(/cargo acceptance window for warehouse/i),
      "2026-09-10T09:00",
    );
    const written = screen.getByTestId("window-0").textContent ?? "";
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isFinite(new Date(written).getTime())).toBe(true);
  });

  it("round-trips an existing ISO cargoAcceptanceWindow into the datetime-local value", () => {
    render(
      <Harness
        wh={[
          {
            warehousePointId: "w1",
            position: "ORIGIN",
            label: "Origin warehouse",
            amount: null,
            cargoAcceptanceWindow: "2026-09-10T09:00:00.000Z",
          },
        ]}
      />,
    );
    const input = screen.getByLabelText(
      /cargo acceptance window for warehouse/i,
    ) as HTMLInputElement;
    expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(input.value).getTime()).toBe(new Date("2026-09-10T09:00:00.000Z").getTime());
  });
});
