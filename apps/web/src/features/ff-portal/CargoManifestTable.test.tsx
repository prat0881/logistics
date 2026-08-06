import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ManifestSnapshotCargo } from "@svyft/shared";
import { CargoManifestTable } from "./CargoManifestTable";

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

describe("CargoManifestTable", () => {
  it("renders per-package columns (SN, count, type, L/W/H, net, gross, CBM) with mono numbers", () => {
    render(<CargoManifestTable cargo={[dgPackage]} />);
    const row = screen.getByText("CRATE").closest("tr")!;
    expect(within(row).getByText("1")).toBeInTheDocument(); // SN = row index + 1
    expect(within(row).getByText("3")).toBeInTheDocument(); // Count
    expect(within(row).getByText("120×100×80")).toBeInTheDocument(); // L/W/H (cm)
    expect(within(row).getByText("900")).toBeInTheDocument(); // Net (kg)
    expect(within(row).getByText("1500")).toBeInTheDocument(); // Gross (kg)
    expect(within(row).getByText("2.5000")).toBeInTheDocument(); // CBM
  });

  it("drops PO/product/HS/qty columns from the old shape", () => {
    render(<CargoManifestTable cargo={[dgPackage]} />);
    expect(screen.queryByText(/PO \/ Ref/i)).toBeNull();
    expect(screen.queryByText(/Product/i)).toBeNull();
    expect(screen.queryByText(/^HS$/i)).toBeNull();
  });

  it("renders read-only tag icons for a package, including DG", () => {
    render(<CargoManifestTable cargo={[dgPackage]} />);
    const row = screen.getByText("CRATE").closest("tr")!;
    expect(within(row).getByLabelText("Dangerous Goods")).toBeInTheDocument();
    expect(within(row).getByLabelText("Fragile")).toBeInTheDocument();
    // read-only: no button/input controls in the tags cell
    expect(within(row).queryByRole("button")).toBeNull();
    expect(within(row).queryByRole("checkbox")).toBeNull();
  });

  it("renders no tag icons for a package with no tags", () => {
    render(<CargoManifestTable cargo={[plainPackage]} />);
    const row = screen.getByText("BOX").closest("tr")!;
    expect(within(row).queryByLabelText("Dangerous Goods")).toBeNull();
  });

  it("numbers multiple rows sequentially (SN) and keys rows by packageId", () => {
    render(<CargoManifestTable cargo={[dgPackage, plainPackage]} />);
    const rows = screen.getAllByRole("row").slice(1); // drop header row
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("1")).toBeInTheDocument();
    expect(within(rows[1]).getByText("2")).toBeInTheDocument();
  });

  it("shows an empty state", () => {
    render(<CargoManifestTable cargo={[]} />);
    expect(screen.getByText(/no cargo/i)).toBeInTheDocument();
  });
});
