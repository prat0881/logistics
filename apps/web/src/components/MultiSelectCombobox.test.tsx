import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MultiSelectCombobox } from "./MultiSelectCombobox";

const OPTS = [
  { code: "US", name: "United States" },
  { code: "SG", name: "Singapore" },
];

describe("MultiSelectCombobox", () => {
  it("adds an option on select and renders it as a removable badge", async () => {
    const onChange = vi.fn();
    render(<MultiSelectCombobox value={[]} options={OPTS} onChange={onChange} ariaLabel="Countries" />);
    await userEvent.click(screen.getByRole("button", { name: /countries/i }));
    await userEvent.click(await screen.findByText("Singapore"));
    expect(onChange).toHaveBeenCalledWith(["SG"]);
  });

  it("shows selected values as badges and removes on X", async () => {
    const onChange = vi.fn();
    render(<MultiSelectCombobox value={["US"]} options={OPTS} onChange={onChange} ariaLabel="Countries" />);
    expect(screen.getByText("United States")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remove united states/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
