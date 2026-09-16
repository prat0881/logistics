import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { WarehouseVehicleUpsert } from "@svyft/shared";
import { VehiclesSection } from "./VehiclesSection";

function Harness({ initial = [] as WarehouseVehicleUpsert[] }: { initial?: WarehouseVehicleUpsert[] }) {
  const [value, setValue] = useState<WarehouseVehicleUpsert[]>(initial);
  return <VehiclesSection value={value} onChange={setValue} />;
}

const fiveTonner: WarehouseVehicleUpsert = {
  id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  tonnage: "T_5",
  quantity: 3,
};

describe("VehiclesSection", () => {
  it("has no per-row action buttons — the row itself is the control", () => {
    render(<Harness initial={[fiveTonner]} />);
    // Scoped to the row itself: this proves the row holds exactly one control, and that
    // control is the tonnage button. A count taken from the whole document (e.g. counting
    // /^edit/i buttons page-wide) could be fooled by a regression that reverts the row
    // button's label to plain text while adding a separate, genuinely distinct Edit action
    // button elsewhere in the row — the counts could coincidentally still match. Scoping to
    // the row and counting *all* buttons within it closes that gap.
    const row = screen.getByRole("row", { name: /5 t/i });
    expect(within(row).getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^remove/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /5 t/i })).toBeInTheDocument();
  });

  it("adds a vehicle through the dialog", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /add vehicle/i }));
    await userEvent.selectOptions(screen.getByLabelText(/tonnage/i), "T_9");
    await userEvent.type(screen.getByLabelText(/quantity/i), "2");
    await userEvent.click(screen.getByRole("button", { name: /save vehicle/i }));

    const table = screen.getByRole("table", { name: /vehicles/i });
    expect(within(table).getByText(/9 t/i)).toBeInTheDocument();
    expect(within(table).getByText("2")).toBeInTheDocument();
  });

  it("opens the dialog prefilled when a row is selected", async () => {
    render(<Harness initial={[fiveTonner]} />);
    await userEvent.click(screen.getByRole("button", { name: /5 t/i }));
    expect(screen.getByLabelText(/tonnage/i)).toHaveValue("T_5");
    expect(screen.getByLabelText(/quantity/i)).toHaveValue(3);
  });

  it("removes from inside the dialog, not from the row", async () => {
    render(<Harness initial={[fiveTonner]} />);
    await userEvent.click(screen.getByRole("button", { name: /5 t/i }));
    await userEvent.click(screen.getByRole("button", { name: /remove vehicle/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i })); // confirm
    expect(screen.queryByRole("table", { name: /vehicles/i })).not.toBeInTheDocument();
  });

  it("offers no Remove when adding a new vehicle", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /add vehicle/i }));
    expect(screen.queryByRole("button", { name: /remove vehicle/i })).not.toBeInTheDocument();
  });

  it("never calls fetch — every mutation is draft-only until the parent saves", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<Harness initial={[fiveTonner]} />);
    await userEvent.click(screen.getByRole("button", { name: /add vehicle/i }));
    await userEvent.selectOptions(screen.getByLabelText(/tonnage/i), "T_12");
    await userEvent.type(screen.getByLabelText(/quantity/i), "5");
    await userEvent.click(screen.getByRole("button", { name: /save vehicle/i }));

    // Not just "fetch wasn't called" — the save must have actually landed in the draft, or this
    // test would also pass if validation silently swallowed the submission.
    const table = screen.getByRole("table", { name: /vehicles/i });
    expect(within(table).getByText(/12 t/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("styles the tonnage as a link so it reads as clickable", () => {
    render(<Harness initial={[fiveTonner]} />);
    const tonnageButton = screen.getByRole("button", { name: /^edit /i });
    expect(tonnageButton).toHaveClass("text-primary");
  });
});
