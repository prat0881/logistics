// apps/web/src/components/TimezoneCombobox.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimezoneCombobox } from "./TimezoneCombobox";

describe("TimezoneCombobox", () => {
  it("shows the selected zone + offset on the trigger", () => {
    render(<TimezoneCombobox value="Asia/Kolkata" onChange={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("Asia/Kolkata (GMT+05:30)");
  });
  it("searches by city and selects (type 'Singapore')", async () => {
    const onChange = vi.fn();
    render(<TimezoneCombobox value={undefined} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByPlaceholderText(/search timezone/i), "Singapore");
    await userEvent.click(await screen.findByText(/Asia\/Singapore \(GMT\+08:00\)/));
    expect(onChange).toHaveBeenCalledWith("Asia/Singapore");
  });
  it("finds Asia/Calcutta via the 'kolkata' alias keyword", async () => {
    render(<TimezoneCombobox value={undefined} onChange={() => {}} />);
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByPlaceholderText(/search timezone/i), "kolkata");
    expect(await screen.findByText(/Asia\/(Calcutta|Kolkata) \(GMT\+05:30\)/)).toBeInTheDocument();
  });
});
