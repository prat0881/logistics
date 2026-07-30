import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CargoDto } from "@svyft/shared";
import { CargoTagIcons } from "./CargoTagIcons";

const cargo = (over: Partial<CargoDto>): CargoDto => ({
  id: "c",
  rowIndex: 0,
  poReference: "PO",
  productName: "P",
  referenceTags: [],
  isDangerous: false,
  hsCode: null,
  msdsFileId: null,
  packageType: "BOX",
  qty: 1,
  dimL: "100",
  dimW: "100",
  dimH: "100",
  netWt: null,
  grossWt: "500",
  volumeCbm: null,
  ...over,
});

describe("CargoTagIcons", () => {
  it("shows each characteristic once, deduped across rows", () => {
    render(
      <CargoTagIcons
        cargo={[
          cargo({ isDangerous: true, referenceTags: ["HEAVY"] }),
          cargo({ isDangerous: true }),
        ]}
      />,
    );
    expect(screen.getAllByLabelText(/dangerous goods/i)).toHaveLength(1); // deduped
    expect(screen.getByLabelText(/heavy/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/fragile/i)).toBeNull();
  });

  it("renders nothing when there are no characteristics", () => {
    const { container } = render(<CargoTagIcons cargo={[cargo({})]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders Fragile icon when cargo has FRAGILE tag", () => {
    render(<CargoTagIcons cargo={[cargo({ referenceTags: ["FRAGILE"] })]} />);
    expect(screen.getByLabelText(/fragile/i)).toBeInTheDocument();
  });

  it("renders Non-stackable icon when cargo has NON_STACKABLE tag", () => {
    render(<CargoTagIcons cargo={[cargo({ referenceTags: ["NON_STACKABLE"] })]} />);
    expect(screen.getByLabelText(/non-stackable/i)).toBeInTheDocument();
  });
});
