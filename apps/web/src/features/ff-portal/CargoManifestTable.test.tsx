import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CargoManifestTable } from "./CargoManifestTable";

const cargo = [{ cargoItemId: "c1", poReference: "PO-1", productName: "Pumps", hsCode: "8413",
  packageType: "Crate", isDangerous: true, qty: 3, dimL: "1.2", dimW: "1.0", dimH: "0.8",
  netWt: "900", grossWt: "1500", volumeCbm: "2.5" }] as never;

describe("CargoManifestTable", () => {
  it("renders cargo with a DG badge and mono numbers", () => {
    render(<CargoManifestTable cargo={cargo} />);
    expect(screen.getByText("PO-1")).toBeInTheDocument();
    expect(screen.getByText("Pumps")).toBeInTheDocument();
    // Scope DG badge assertion to the data row, avoiding collision with the "DG" column header
    const dgRow = screen.getByText("Pumps").closest("tr")!;
    expect(within(dgRow).getByText("DG")).toBeInTheDocument();
    expect(screen.getByText("1500")).toBeInTheDocument();
  });
  it("shows an empty state", () => {
    render(<CargoManifestTable cargo={[]} />);
    expect(screen.getByText(/no cargo/i)).toBeInTheDocument();
  });
  it("does NOT render a DG badge for non-dangerous cargo", () => {
    const safeCargo = [{ cargoItemId: "c2", poReference: "PO-2", productName: "Books", hsCode: null,
      packageType: "Box", isDangerous: false, qty: 10, dimL: "0.5", dimW: "0.3", dimH: "0.2",
      netWt: "50", grossWt: "60", volumeCbm: "0.03" }] as never;
    render(<CargoManifestTable cargo={safeCargo} />);
    // Scope to the data row — "DG" must not appear as a badge in this row
    const plainRow = screen.getByText("Books").closest("tr")!;
    expect(within(plainRow).queryByText("DG")).toBeNull();
    // Shows placeholder dash for non-DG in data cell
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
