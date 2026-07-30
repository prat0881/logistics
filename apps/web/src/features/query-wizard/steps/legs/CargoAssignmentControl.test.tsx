import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CargoAssignmentControl } from "./CargoAssignmentControl";
import type { CargoDto } from "@svyft/shared";

const makeCargo = (id: string, po: string, name: string): CargoDto => ({
  id,
  rowIndex: 0,
  poReference: po,
  productName: name,
  referenceTags: [],
  hsCode: null,
  packageType: "Carton",
  isDangerous: false,
  msdsFileId: null,
  qty: 1,
  dimL: "10",
  dimW: "10",
  dimH: "10",
  netWt: null,
  grossWt: "5",
  volumeCbm: null,
  dimUnit: "CM",
  weightUnit: "KG",
});

const CARGO_A = makeCargo(
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "PO-001",
  "Widget A",
);
const CARGO_B = makeCargo(
  "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  "PO-002",
  "Gadget B",
);

describe("CargoAssignmentControl", () => {
  it("shows an empty-state message when no cargo rows exist", () => {
    render(
      <CargoAssignmentControl cargo={[]} value={[]} onChange={vi.fn()} />,
    );
    expect(
      screen.getByText(/no cargo yet — add rows in step 3/i),
    ).toBeInTheDocument();
  });

  it("renders one checkbox row per cargo item with label = poReference + productName", () => {
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A, CARGO_B]}
        value={[]}
        onChange={vi.fn()}
      />,
    );
    // Both items visible
    expect(screen.getByText(/PO-001/)).toBeInTheDocument();
    expect(screen.getByText(/Widget A/)).toBeInTheDocument();
    expect(screen.getByText(/PO-002/)).toBeInTheDocument();
    expect(screen.getByText(/Gadget B/)).toBeInTheDocument();

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
  });

  it("reflects checked state from value prop", () => {
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A, CARGO_B]}
        value={[CARGO_A.id]}
        onChange={vi.fn()}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox");
    // First cargo is checked
    expect(checkboxes[0]).toHaveAttribute("aria-checked", "true");
    // Second cargo is not checked
    expect(checkboxes[1]).toHaveAttribute("aria-checked", "false");
  });

  it("calls onChange with id added when an unchecked box is toggled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <CargoAssignmentControl
        cargo={[CARGO_A, CARGO_B]}
        value={[]}
        onChange={onChange}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);

    expect(onChange).toHaveBeenCalledWith([CARGO_A.id]);
  });

  it("calls onChange with id removed when a checked box is toggled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <CargoAssignmentControl
        cargo={[CARGO_A, CARGO_B]}
        value={[CARGO_A.id, CARGO_B.id]}
        onChange={onChange}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);

    expect(onChange).toHaveBeenCalledWith([CARGO_B.id]);
  });

  it("shows the D7 hint about assigning at least one cargo row", () => {
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A]}
        value={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/assign at least one cargo row/i)).toBeInTheDocument();
  });

  it("disables an unchecked cargo that is already on a parallel leg and names that leg", () => {
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A, CARGO_B]}
        value={[]}
        onChange={vi.fn()}
        conflicts={new Map([[CARGO_A.id, "L1"]])}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeDisabled(); // CARGO_A conflicts → disabled
    expect(checkboxes[1]).not.toBeDisabled(); // CARGO_B is free
    expect(screen.getByText(/already on L1/i)).toBeInTheDocument();
  });

  it("does not fire onChange when a disabled (conflicting) cargo is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A]}
        value={[]}
        onChange={onChange}
        conflicts={new Map([[CARGO_A.id, "L1"]])}
      />,
    );
    await user.click(screen.getByRole("checkbox"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a conflicting cargo enabled if it is already checked here (so it can be removed)", () => {
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A]}
        value={[CARGO_A.id]}
        onChange={vi.fn()}
        conflicts={new Map([[CARGO_A.id, "L1"]])}
      />,
    );
    expect(screen.getByRole("checkbox")).not.toBeDisabled();
  });
});
