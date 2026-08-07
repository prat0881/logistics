import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch } from "react-hook-form";
import type { QuoteDraft, FfPortalEndpoint } from "@svyft/shared";
import { TruckingBlocks } from "./TruckingBlocks";

const endpoints: FfPortalEndpoint[] = [
  { pointId: "p1", type: "PICKUP", name: "Mumbai DC", country: "IN", warehousePosition: null },
];

const truckingDefaults: QuoteDraft["trucking"] = [
  {
    legEndpointPointId: "p1",
    truckingType: "DEDICATED",
    basis: "PER_TRUCK",
    amount: null,
    rateVariant: "DEDICATED",
    tonnage: null,
  },
  {
    legEndpointPointId: "p1",
    truckingType: "GROUPAGE",
    basis: "PER_TRUCK",
    amount: null,
    rateVariant: "GROUPAGE",
    tonnage: null,
  },
];

function Harness() {
  const form = useForm<QuoteDraft>({
    defaultValues: {
      legId: "L1",
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: null,
      cargo: [],
      charges: [],
      trucking: truckingDefaults,
      warehouse: [],
      transit: null,
      dgSurchargeNote: null,
      termsConditions: null,
    },
  });
  return (
    <FormProvider {...form}>
      <TruckingBlocks endpoints={endpoints} />
    </FormProvider>
  );
}

/** Extended harness that exposes trucking.0.tonnage via an <output> for branch coverage */
function HarnessWithOutput() {
  const form = useForm<QuoteDraft>({
    defaultValues: {
      legId: "L1",
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: null,
      cargo: [],
      charges: [],
      trucking: truckingDefaults,
      warehouse: [],
      transit: null,
      dgSurchargeNote: null,
      termsConditions: null,
    },
  });

  function WatchOutput() {
    const tonnage = useWatch({ control: form.control, name: "trucking.0.tonnage" });
    return <output data-testid="tonnage-output">{tonnage ?? "NULL"}</output>;
  }

  return (
    <FormProvider {...form}>
      <TruckingBlocks endpoints={endpoints} />
      <WatchOutput />
    </FormProvider>
  );
}

describe("TruckingBlocks", () => {
  it("renders one block per trucking row, headed by the rate variant, with a tonnage Select on Dedicated only", () => {
    render(<Harness />);

    expect(screen.getByText("Dedicated")).toBeInTheDocument();
    expect(screen.getByText("Groupage")).toBeInTheDocument();

    // Both rows carry Amount + Remarks
    expect(screen.getByLabelText(/amount for dedicated/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/remarks for dedicated/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/amount for groupage/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/remarks for groupage/i)).toBeInTheDocument();

    // Tonnage Select only on the Dedicated row — Groupage has no tonnage
    expect(screen.getByRole("combobox", { name: /tonnage for dedicated/i })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /tonnage for groupage/i })).toBeNull();

    // The two rows are fixed (seeded by draftFromDto) — no add/remove control
    expect(screen.queryByRole("button", { name: /add charge/i })).toBeNull();
  });

  it("changing the tonnage Select updates trucking.0.tonnage", async () => {
    render(<HarnessWithOutput />);

    expect(screen.getByTestId("tonnage-output")).toHaveTextContent("NULL");

    const trigger = screen.getByRole("combobox", { name: /tonnage for dedicated/i });
    await userEvent.click(trigger);

    const option = screen.getByRole("option", { name: "5 T" });
    await userEvent.click(option);

    expect(screen.getByTestId("tonnage-output")).toHaveTextContent("T_5");
  });
});
