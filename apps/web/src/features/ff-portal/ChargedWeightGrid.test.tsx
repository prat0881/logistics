import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch, type Control } from "react-hook-form";
import type { QuoteDraft, ManifestSnapshotCargo } from "@svyft/shared";
import { ChargedWeightGrid } from "./ChargedWeightGrid";

const cargo: ManifestSnapshotCargo[] = [
  {
    packageId: "pk1", packageNo: "PK-1", packageType: "CRATE", packageCount: 1,
    dimL: "100", dimW: "100", dimH: "100", netWt: "1400", grossWt: "1500", volumeCbm: "2.5", tags: [],
  },
];

const defaultDraft: QuoteDraft = {
  legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null,
  cargo: [{ packageId: "pk1", grossWtKg: 1500, cbm: 2.5, chargedWeightKg: null }],
  charges: [], trucking: [], seaRates: [], warehouse: [],
  transit: { departureDate: null, arrivalDate: null, guaranteedTransitDays: null },
  dgSurchargeNote: null, termsConditions: null,
};

function CargoDebug({ control }: { control: Control<QuoteDraft> }) {
  const rows = useWatch({ control, name: "cargo" });
  return <div data-testid="cargo-debug">{JSON.stringify(rows)}</div>;
}

function Harness() {
  const form = useForm<QuoteDraft>({ defaultValues: defaultDraft });
  return (
    <FormProvider {...form}>
      <ChargedWeightGrid cargo={cargo} />
      <CargoDebug control={form.control} />
    </FormProvider>
  );
}

describe("ChargedWeightGrid", () => {
  it("renders one editable Charged Wt (kg) field per package, labeled by package number", () => {
    render(<Harness />);
    expect(screen.getByLabelText(/charged wt.*pk-1/i)).toBeInTheDocument();
  });

  it("shows read-only Gross (kg) and CBM for reference", () => {
    render(<Harness />);
    expect(screen.getByText("1500")).toBeInTheDocument(); // Gross (kg)
    expect(screen.getByText("2.5000")).toBeInTheDocument(); // CBM
  });

  it("writes an entered value to cargo[i].chargedWeightKg", async () => {
    render(<Harness />);
    const input = screen.getByLabelText(/charged wt.*pk-1/i);
    await userEvent.type(input, "1200");
    expect(screen.getByTestId("cargo-debug")).toHaveTextContent(/"chargedWeightKg":1200/);
    // the controlled input reflects the written form value back
    expect(input).toHaveValue(1200);
  });

  it("does not render any density/chargeable-weight UI", () => {
    render(<Harness />);
    expect(screen.queryByText(/density/i)).toBeNull();
    expect(screen.queryByText(/chargeable/i)).toBeNull();
  });
});
