import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch } from "react-hook-form";
import type { QuoteDraft, FfPortalEndpoint } from "@svyft/shared";
import { TruckingBlocks } from "./TruckingBlocks";

const endpoints: FfPortalEndpoint[] = [
  { pointId: "p1", type: "PICKUP", name: "Mumbai DC", country: "IN", warehousePosition: null },
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
      trucking: [
        { legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: null },
      ],
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

/** Extended harness that exposes truckingType via an <output> for branch coverage */
function HarnessWithOutput() {
  const form = useForm<QuoteDraft>({
    defaultValues: {
      legId: "L1",
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: null,
      cargo: [],
      charges: [],
      trucking: [
        { legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: null },
      ],
      warehouse: [],
      transit: null,
      dgSurchargeNote: null,
      termsConditions: null,
    },
  });

  function WatchOutput() {
    const truckingType = useWatch({ control: form.control, name: "trucking.0.truckingType" });
    return <output data-testid="tt-output">{truckingType}</output>;
  }

  return (
    <FormProvider {...form}>
      <TruckingBlocks endpoints={endpoints} />
      <WatchOutput />
    </FormProvider>
  );
}

describe("TruckingBlocks", () => {
  it("renders one block per endpoint with type/basis/amount/remarks and NO add button", () => {
    render(<Harness />);
    expect(screen.getByText("Mumbai DC")).toBeInTheDocument();
    expect(screen.getByLabelText(/amount.*Mumbai DC/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/remarks.*Mumbai DC/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add charge/i })).toBeNull();
  });

  it("changing trucking-type Select updates form value", async () => {
    render(<HarnessWithOutput />);

    // Initially DEDICATED
    expect(screen.getByTestId("tt-output")).toHaveTextContent("DEDICATED");

    // Open the Radix Select trigger for truckingType
    const trigger = screen.getByRole("combobox", { name: /trucking type.*Mumbai DC/i });
    await userEvent.click(trigger);

    // Click the GROUPAGE option
    const groupageOption = screen.getByRole("option", { name: /groupage/i });
    await userEvent.click(groupageOption);

    // Form value should now be GROUPAGE
    expect(screen.getByTestId("tt-output")).toHaveTextContent("GROUPAGE");
  });
});
