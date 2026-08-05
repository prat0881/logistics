import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CargoAssignmentControl } from "./CargoAssignmentControl";
import type { CargoDto, PackageDto } from "@svyft/shared";

const makePackage = (id: string, packageNo: string): PackageDto => ({
  id,
  rowIndex: 0,
  packageNo,
  packageType: "CARTON",
  dimL: "10",
  dimW: "10",
  dimH: "10",
  grossWt: "5",
  netWt: null,
  volumeCbm: "0.001",
  tags: [],
  effectiveTags: [],
  msdsFileId: null,
  items: [],
});

const makeCargo = (id: string, po: string, packages: PackageDto[]): CargoDto => ({
  id,
  rowIndex: 0,
  poReference: po,
  label: null,
  dimUnit: "CM",
  weightUnit: "KG",
  packages,
  packageCount: packages.length,
  grossWeightKg: "5",
  volumeCbm: "0.001",
  tags: [],
  chargeableWeight: null,
});

const PACKAGE_A = makePackage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "PKG-001");
const PACKAGE_B = makePackage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "PKG-002");

const CARGO_A = makeCargo("cccccccc-cccc-cccc-cccc-cccccccccccc", "PO-001", [PACKAGE_A]);
const CARGO_B = makeCargo("dddddddd-dddd-dddd-dddd-dddddddddddd", "PO-002", [PACKAGE_B]);

describe("CargoAssignmentControl", () => {
  it("shows an empty-state message when no cargo/packages exist", () => {
    render(<CargoAssignmentControl cargo={[]} value={[]} onChange={vi.fn()} />);
    expect(
      screen.getByText(/no packages yet — add them in step 3/i),
    ).toBeInTheDocument();
  });

  it("renders packages grouped under their cargo's PO/Ref, with label = packageNo", () => {
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A, CARGO_B]}
        value={[]}
        onChange={vi.fn()}
      />,
    );
    // Both group headers visible
    expect(screen.getByText("PO-001")).toBeInTheDocument();
    expect(screen.getByText("PO-002")).toBeInTheDocument();
    // Both package rows visible, labelled by packageNo
    expect(screen.getByText("PKG-001")).toBeInTheDocument();
    expect(screen.getByText("PKG-002")).toBeInTheDocument();

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
  });

  it("groups multiple packages under the SAME cargo's header", () => {
    const multiPackageCargo = makeCargo(CARGO_A.id, "PO-001", [
      PACKAGE_A,
      makePackage("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", "PKG-003"),
    ]);
    render(
      <CargoAssignmentControl
        cargo={[multiPackageCargo]}
        value={[]}
        onChange={vi.fn()}
      />,
    );
    // Exactly one group header for the one cargo row
    expect(screen.getAllByText("PO-001")).toHaveLength(1);
    // Both of its packages render as separate checkbox rows
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(screen.getByText("PKG-001")).toBeInTheDocument();
    expect(screen.getByText("PKG-003")).toBeInTheDocument();
  });

  it("falls back to the cargo label (cargoLabel) when poReference is absent", () => {
    const labelledCargo = makeCargo("ffffffff-ffff-ffff-ffff-ffffffffffff", "", [
      makePackage("11111111-1111-1111-1111-111111111111", "PKG-009"),
    ]);
    labelledCargo.poReference = null;
    labelledCargo.label = "Machinery batch";
    render(
      <CargoAssignmentControl cargo={[labelledCargo]} value={[]} onChange={vi.fn()} />,
    );
    expect(screen.getByText("Machinery batch")).toBeInTheDocument();
  });

  it("reflects checked state from value prop", () => {
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A, CARGO_B]}
        value={[PACKAGE_A.id]}
        onChange={vi.fn()}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox");
    // First package is checked
    expect(checkboxes[0]).toHaveAttribute("aria-checked", "true");
    // Second package is not checked
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

    expect(onChange).toHaveBeenCalledWith([PACKAGE_A.id]);
  });

  it("calls onChange with id removed when a checked box is toggled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <CargoAssignmentControl
        cargo={[CARGO_A, CARGO_B]}
        value={[PACKAGE_A.id, PACKAGE_B.id]}
        onChange={onChange}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);

    expect(onChange).toHaveBeenCalledWith([PACKAGE_B.id]);
  });

  it("shows the D7 hint about assigning at least one package", () => {
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A]}
        value={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/assign at least one package/i)).toBeInTheDocument();
  });

  it("disables an unchecked package that is already on a parallel leg and names that leg", () => {
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A, CARGO_B]}
        value={[]}
        onChange={vi.fn()}
        conflicts={new Map([[PACKAGE_A.id, "L1"]])}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeDisabled(); // PACKAGE_A conflicts → disabled
    expect(checkboxes[1]).not.toBeDisabled(); // PACKAGE_B is free
    expect(screen.getByText(/already on L1/i)).toBeInTheDocument();
  });

  it("does not fire onChange when a disabled (conflicting) package is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A]}
        value={[]}
        onChange={onChange}
        conflicts={new Map([[PACKAGE_A.id, "L1"]])}
      />,
    );
    await user.click(screen.getByRole("checkbox"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a conflicting package enabled if it is already checked here (so it can be removed)", () => {
    render(
      <CargoAssignmentControl
        cargo={[CARGO_A]}
        value={[PACKAGE_A.id]}
        onChange={vi.fn()}
        conflicts={new Map([[PACKAGE_A.id, "L1"]])}
      />,
    );
    expect(screen.getByRole("checkbox")).not.toBeDisabled();
  });

  it("does not render a group header/checkboxes for a cargo row with zero packages", () => {
    const emptyCargo = makeCargo("22222222-2222-2222-2222-222222222222", "PO-EMPTY", []);
    render(
      <CargoAssignmentControl cargo={[CARGO_A, emptyCargo]} value={[]} onChange={vi.fn()} />,
    );
    expect(screen.queryByText("PO-EMPTY")).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });
});
