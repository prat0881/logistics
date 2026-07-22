import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { QueriesToolbar } from "./QueriesToolbar";

afterEach(() => vi.unstubAllGlobals());

/** Shared auth mock used by every date-range test */
function authMockFetch() {
  return mockFetch((url: string) => {
    if (url.includes("/api/auth/me"))
      return { status: 200, body: { user: { id: "u1", name: "U", email: "u@x.com", role: "ADMINISTRATOR" } } };
    return { status: 200, body: {} };
  });
}

/**
 * Return day buttons scoped to the rendered calendar.
 * Scoping via `data-slot="calendar"` + `within(...)` makes a missing
 * data-day attribute fail with a clear "no elements found" error instead of
 * a cryptic `undefined[N]` crash that the global getAllByRole approach produces.
 */
function getDayButtons() {
  // calendar.tsx Root renders <div data-slot="calendar"> — scope to it so we
  // don't accidentally pick up navigation buttons or other toolbar buttons.
  const calendarEl = document.querySelector('[data-slot="calendar"]') as HTMLElement | null;
  if (!calendarEl) throw new Error('Calendar root ([data-slot="calendar"]) not found in the document');
  return within(calendarEl).getAllByRole("button").filter((b) => b.getAttribute("data-day"));
}

describe("QueriesToolbar — date-range popup", () => {
  it("does not emit a date filter until both endpoints are picked", async () => {
    vi.stubGlobal("fetch", authMockFetch());
    const onChange = vi.fn();
    renderWithProviders(<QueriesToolbar onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Date range picker" }));

    // react-day-picker v10 emits { from: day, to: day } on the FIRST click
    // (addToRange returns to=date when min===0). We gate on from !== to so
    // a "partial" first click is not treated as a completed range.
    const dayButtons = getDayButtons();
    await user.click(dayButtons[10]);
    expect(onChange.mock.calls.every(([p]) => p.dateFrom === undefined)).toBe(true);

    // Re-query after first click — calendar re-renders with the highlight, so stale
    // references would fail. Pick a second different day to complete the range.
    const dayButtons2 = getDayButtons();
    await user.click(dayButtons2[15]);
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.dateFrom).toBeTruthy();
    expect(last.dateTo).toBeTruthy();
  });

  it("closes the popover after the second (completing) click", async () => {
    vi.stubGlobal("fetch", authMockFetch());
    const onChange = vi.fn();
    renderWithProviders(<QueriesToolbar onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Date range picker" }));

    // Popover is open: calendar is visible
    expect(document.querySelector('[data-slot="calendar"]')).toBeInTheDocument();

    const dayButtons = getDayButtons();
    await user.click(dayButtons[10]); // first click — stays open
    expect(document.querySelector('[data-slot="calendar"]')).toBeInTheDocument();

    const dayButtons2 = getDayButtons();
    await user.click(dayButtons2[15]); // second click — should close
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("emits dateFrom: undefined when Clear is clicked after a completed range", async () => {
    vi.stubGlobal("fetch", authMockFetch());
    const onChange = vi.fn();
    renderWithProviders(<QueriesToolbar onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Date range picker" }));

    // Complete a range first
    const dayButtons = getDayButtons();
    await user.click(dayButtons[10]);
    const dayButtons2 = getDayButtons();
    await user.click(dayButtons2[15]);
    const afterRange = onChange.mock.calls.at(-1)![0];
    expect(afterRange.dateFrom).toBeTruthy(); // sanity: range was emitted

    // Re-open the popover (it closed after the completing click) to access the Clear button
    await user.click(screen.getByRole("button", { name: "Date range picker" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));

    const afterClear = onChange.mock.calls.at(-1)![0];
    expect(afterClear.dateFrom).toBeUndefined();
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
