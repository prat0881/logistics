// apps/web/src/components/CountryCombobox.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CountryCombobox } from "./CountryCombobox";

describe("CountryCombobox", () => {
  it("shows the selected country's name on the trigger", () => {
    render(<CountryCombobox value="GB" onChange={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("United Kingdom");
  });

  it("shows a placeholder on the trigger when no value is set", () => {
    render(<CountryCombobox value={undefined} onChange={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("Select country…");
  });

  it("lists country options (name + code) when opened", async () => {
    render(<CountryCombobox value={undefined} onChange={() => {}} />);
    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByText(/United Kingdom \(GB\)/)).toBeInTheDocument();
  });

  it("searches by name and calls onChange with the ISO CODE on select", async () => {
    const onChange = vi.fn();
    render(<CountryCombobox value={undefined} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByPlaceholderText(/search country/i), "United Kingdom");
    await userEvent.click(await screen.findByText(/United Kingdom \(GB\)/));
    expect(onChange).toHaveBeenCalledWith("GB");
  });

  it("is also searchable by ISO code", async () => {
    render(<CountryCombobox value={undefined} onChange={() => {}} />);
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByPlaceholderText(/search country/i), "GB");
    expect(await screen.findByText(/United Kingdom \(GB\)/)).toBeInTheDocument();
  });

  it("a legacy non-code value still shows on the trigger (no crash, no blank)", async () => {
    render(<CountryCombobox value="Legacyland" onChange={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("Legacyland");
    // Still present/selectable as its own row in the open list (distinct from the
    // trigger's own "Legacyland" text) so the user can move to a proper code.
    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByText(/Legacyland \(Legacyland\)/)).toBeInTheDocument();
  });

  it("respects a custom ariaLabel on the trigger", () => {
    render(<CountryCombobox value={undefined} onChange={() => {}} ariaLabel="Country" />);
    expect(screen.getByRole("button", { name: "Country" })).toBeInTheDocument();
  });
});
