import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CargoDto } from "@svyft/shared";
import { CargoTagIcons } from "./CargoTagIcons";

const cargo = (over: Partial<CargoDto>): CargoDto => ({
  id: "c",
  rowIndex: 0,
  poReference: "PO",
  label: null,
  dimUnit: "CM",
  weightUnit: "KG",
  packages: [],
  packageCount: 0,
  grossWeightKg: "500",
  volumeCbm: "0",
  tags: [],
  chargeableWeight: null,
  ...over,
});

describe("CargoTagIcons", () => {
  it("shows each characteristic once, deduped across rows", () => {
    render(<CargoTagIcons cargo={[cargo({ tags: ["DG", "HEAVY"] }), cargo({ tags: ["DG"] })]} />);
    expect(screen.getAllByLabelText(/dangerous goods/i)).toHaveLength(1); // deduped
    expect(screen.getByLabelText(/heavy/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/fragile/i)).toBeNull();
  });

  it("renders nothing when there are no characteristics", () => {
    const { container } = render(<CargoTagIcons cargo={[cargo({})]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders Fragile icon when cargo has FRAGILE tag", () => {
    render(<CargoTagIcons cargo={[cargo({ tags: ["FRAGILE"] })]} />);
    expect(screen.getByLabelText(/fragile/i)).toBeInTheDocument();
  });

  it("renders Non stackable icon when cargo has NON_STACKABLE tag", () => {
    render(<CargoTagIcons cargo={[cargo({ tags: ["NON_STACKABLE"] })]} />);
    expect(screen.getByLabelText(/non stackable/i)).toBeInTheDocument(); // "Non Stackable"
  });

  it("renders the Out of Gauge icon when cargo has OUT_OF_GAUGE tag", () => {
    render(<CargoTagIcons cargo={[cargo({ tags: ["OUT_OF_GAUGE"] })]} />);
    expect(screen.getByLabelText(/out of gauge/i)).toBeInTheDocument();
  });
});
