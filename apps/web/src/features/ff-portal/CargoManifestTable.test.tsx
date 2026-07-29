import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CargoManifestTable } from "./CargoManifestTable";

const cargo = [{ cargoItemId: "c1", poReference: "PO-1", productName: "Pumps", hsCode: "8413",
  packageType: "Crate", isDangerous: true, qty: 3, dimL: "1.2", dimW: "1.0", dimH: "0.8",
  netWt: "900", grossWt: "1500", volumeCbm: "2.5" }] as never;

describe("CargoManifestTable", () => {
  it("renders cargo with a DG badge and mono numbers", () => {
    render(<CargoManifestTable cargo={cargo} />);
    expect(screen.getByText("PO-1")).toBeInTheDocument();
    expect(screen.getByText("Pumps")).toBeInTheDocument();
    // "DG" appears in both the column header and the warning badge
    expect(screen.getAllByText("DG").length).toBeGreaterThanOrEqual(2);
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
    const { container } = render(<CargoManifestTable cargo={safeCargo} />);
    // The "DG" column header exists but no Badge cell should contain "DG"
    const badges = container.querySelectorAll('[class*="bg-warning"]');
    expect(badges).toHaveLength(0);
    // Shows placeholder dash for non-DG in data cell
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
