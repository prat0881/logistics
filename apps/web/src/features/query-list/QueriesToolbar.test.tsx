import { describe, it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { QueriesToolbar } from "./QueriesToolbar";

afterEach(() => vi.unstubAllGlobals());

describe("QueriesToolbar — date-range popup", () => {
  it("does not emit a date filter until both endpoints are picked", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "U", email: "u@x.com", role: "ADMINISTRATOR" } } };
        return { status: 200, body: {} };
      }),
    );
    const onChange = vi.fn();
    renderWithProviders(<QueriesToolbar onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Date range"));
    // In this repo's Calendar (react-day-picker v10), data-day is on <button> elements
    // (DayButton), not on the <td> gridcells. Re-query after each click because the
    // calendar re-renders and stale references fail.
    const dayButtons = screen.getAllByRole("button").filter((b) => b.getAttribute("data-day"));
    // pick a start day → still open, no dateFrom emitted yet
    // (v10 range mode emits { from: day, to: day } on first click, which we gate as
    // "not a real range yet" since from === to)
    await user.click(dayButtons[10]);
    expect(onChange.mock.calls.every(([p]) => p.dateFrom === undefined)).toBe(true);
    // Re-query after first click (calendar re-renders with the selection highlighted)
    const dayButtons2 = screen.getAllByRole("button").filter((b) => b.getAttribute("data-day"));
    // pick an end day → emits both + closes
    await user.click(dayButtons2[15]);
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.dateFrom).toBeTruthy();
    expect(last.dateTo).toBeTruthy();
  });
});

describe("QueriesToolbar — All clears the facet", () => {
  it("emits status: undefined when 'All statuses' is chosen", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "U", email: "u@x.com", role: "ADMINISTRATOR" } } };
        return { status: 200, body: {} };
      }),
    );
    const onChange = vi.fn();
    renderWithProviders(<QueriesToolbar onChange={onChange} />);
    const user = userEvent.setup();

    // Step 1: select a specific status first so the trigger no longer shows "All statuses".
    // This avoids the jsdom/Radix issue where "All statuses" appears in both the trigger
    // and the dropdown simultaneously, causing findByText to find multiple elements.
    await user.click(screen.getByLabelText("Status filter"));
    await user.click(await screen.findByText("DRAFT"));

    // Step 2: now open the select again and choose "All statuses".
    // The trigger now shows "DRAFT", so "All statuses" is unique in the dropdown.
    await user.click(screen.getByLabelText("Status filter"));
    await user.click(await screen.findByText("All statuses"));

    const last = onChange.mock.calls.at(-1)![0];
    expect(last).toHaveProperty("status", undefined);
  });
});
