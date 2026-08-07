import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch, type Control } from "react-hook-form";
import type { ManifestSnapshotCargo, QuoteDraft } from "@svyft/shared";
import { CargoWeightTable } from "./CargoWeightTable";

const dgPackage: ManifestSnapshotCargo = {
  packageId: "pk1",
  packageNo: "PK-1",
  packageType: "CRATE",
  packageCount: 3,
  dimL: "120",
  dimW: "100",
  dimH: "80",
  netWt: "900",
  grossWt: "1500",
  volumeCbm: "2.5",
  tags: ["DG", "FRAGILE"],
};

const plainPackage: ManifestSnapshotCargo = {
  packageId: "pk2",
  packageNo: "PK-2",
  packageType: "BOX",
  packageCount: 10,
  dimL: "50",
  dimW: "30",
  dimH: "20",
  netWt: "50",
  grossWt: "60",
  volumeCbm: "0.03",
  tags: [],
};

const defaultDraft: QuoteDraft = {
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
  warehouse: [],
  transit: { departureDate: null, arrivalDate: null, guaranteedTransitDaysByVariant: {} },
  dgSurchargeNote: null,
  termsConditions: null,
};

function WeightDebug({ control }: { control: Control<QuoteDraft> }) {
  const chargedWeightKg = useWatch({ control, name: "chargedWeightKg" });
  return <div data-testid="weight-debug">{JSON.stringify(chargedWeightKg)}</div>;
}

function Harness({ manifest }: { manifest: ManifestSnapshotCargo[] }) {
  const form = useForm<QuoteDraft>({ defaultValues: defaultDraft });
  return (
    <FormProvider {...form}>
      <CargoWeightTable manifest={manifest} />
      <WeightDebug control={form.control} />
    </FormProvider>
  );
}

describe("CargoWeightTable", () => {
  it("renders per-package columns (SN, type, L/W/H, gross, CBM) with mono numbers", () => {
    render(<Harness manifest={[dgPackage]} />);
    const row = screen.getByText("CRATE").closest("tr")!;
    expect(within(row).getByText("1")).toBeInTheDocument(); // SN = row index + 1
    expect(within(row).getByText("120×100×80")).toBeInTheDocument(); // L/W/H (cm)
    expect(within(row).getByText("1500")).toBeInTheDocument(); // Gross (kg)
    expect(within(row).getByText("2.5000")).toBeInTheDocument(); // CBM
  });

  it("drops the per-package count and net-weight columns from the old CargoManifestTable shape", () => {
    render(<Harness manifest={[dgPackage]} />);
    expect(screen.queryByText(/^Count$/i)).toBeNull();
    expect(screen.queryByText(/^Net/i)).toBeNull();
    const row = screen.getByText("CRATE").closest("tr")!;
    expect(within(row).queryByText("3")).toBeNull(); // packageCount, dropped
    expect(within(row).queryByText("900")).toBeNull(); // netWt, dropped
  });

  it("renders read-only tag icons for a package, including DG", () => {
    render(<Harness manifest={[dgPackage]} />);
    const row = screen.getByText("CRATE").closest("tr")!;
    expect(within(row).getByLabelText("Dangerous Goods")).toBeInTheDocument();
    expect(within(row).getByLabelText("Fragile")).toBeInTheDocument();
    // read-only: no button/input controls in the tags cell itself
    expect(within(row).queryByRole("button")).toBeNull();
    expect(within(row).queryByRole("spinbutton")).toBeNull();
  });

  it("numbers multiple rows sequentially (SN) and keys rows by packageId", () => {
    render(<Harness manifest={[dgPackage, plainPackage]} />);
    const rows = screen.getAllByRole("row").slice(1); // drop header row
    // 2 package rows + Totals row + Chargeable Weight row = 4
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByText("1")).toBeInTheDocument();
    expect(within(rows[1]).getByText("2")).toBeInTheDocument();
  });

  it("renders a Totals row summing Gross and CBM across packages", () => {
    render(<Harness manifest={[dgPackage, plainPackage]} />);
    const totalsRow = screen.getByText("Totals").closest("tr")!;
    expect(within(totalsRow).getByText("1560")).toBeInTheDocument(); // Σ Gross: 1500 + 60
    expect(within(totalsRow).getByText("2.5300")).toBeInTheDocument(); // Σ CBM: 2.5 + 0.03
  });

  it("renders exactly one Chargeable Weight (kg) input, not one per package", () => {
    render(<Harness manifest={[dgPackage, plainPackage]} />);
    expect(screen.getAllByRole("spinbutton")).toHaveLength(1);
    expect(screen.getByLabelText(/chargeable weight/i)).toBeInTheDocument();
  });

  it("writes an entered value to the leg-level chargedWeightKg, not a per-package field", async () => {
    render(<Harness manifest={[dgPackage]} />);
    const input = screen.getByLabelText(/chargeable weight/i);
    await userEvent.type(input, "1200");
    expect(screen.getByTestId("weight-debug")).toHaveTextContent("1200");
    // the controlled input reflects the written form value back
    expect(input).toHaveValue(1200);
  });

  it("shows an empty state when there is no cargo, but still renders the weight input", () => {
    render(<Harness manifest={[]} />);
    expect(screen.getByText(/no cargo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/chargeable weight/i)).toBeInTheDocument();
  });
});
