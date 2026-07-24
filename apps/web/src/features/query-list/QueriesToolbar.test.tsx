import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
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

// Pin "today" so the calendar always renders June 2026 — makes day targeting
// deterministic and the test hermetic (no dependence on the real clock/month).
const FIXED_NOW = "2026-06-15T12:00:00";
// Two real, mid-month, distinct + ordered June days. Targeting by ISO date
// (below) instead of a positional index into the re-rendering 2-month grid is
// what makes the two endpoints unambiguous — the old `dayButtons[10]/[15]`
// approach flaked when the completing click raced the first pick's re-render.
const DAY_FROM = "2026-06-10";
const DAY_TO = "2026-06-20";

/**
 * Click the calendar day for an ISO date. react-day-picker sets
 * `data-day="YYYY-MM-DD"` on the `role="gridcell"` wrapper; the clickable
 * DayButton is inside it. Querying fresh by the stable ISO selector (never a
 * cached node or positional index) sidesteps re-render staleness.
 */
async function clickDay(user: ReturnType<typeof userEvent.setup>, iso: string) {
  const cell = document.querySelector(`[role="gridcell"][data-day="${iso}"]`) as HTMLElement | null;
  if (!cell) throw new Error(`Calendar day cell for ${iso} not found`);
  await user.click(within(cell).getByRole("button"));
}

/** Wait until the calendar reflects a day as selected (the controlled `selected`
 *  prop has flushed) — so a following click can't race the previous re-render. */
async function waitForDaySelected(iso: string) {
  await waitFor(() =>
    expect(
      document.querySelector(`[role="gridcell"][data-day="${iso}"]`),
    ).toHaveAttribute("data-selected", "true"),
  );
}

describe("QueriesToolbar — date-range popup", () => {
  // Fake ONLY Date (not setTimeout) so the calendar month is fixed while
  // userEvent's real-timer behaviour is untouched.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FIXED_NOW));
  });
  afterEach(() => vi.useRealTimers());

  it("does not emit a date filter until both endpoints are picked", async () => {
    vi.stubGlobal("fetch", authMockFetch());
    const onChange = vi.fn();
    renderWithProviders(<QueriesToolbar onChange={onChange} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Date range picker" }));

    // First endpoint only — react-day-picker v10 `addToRange` returns
    // { from: day, to: day } on the first click (min === 0), which the toolbar
    // gates as "partial" (from === to), so NO completed range is emitted yet.
    await clickDay(user, DAY_FROM);
    expect(onChange.mock.calls.every(([p]) => p.dateFrom === undefined)).toBe(true);
    await waitForDaySelected(DAY_FROM);

    // Second, later endpoint completes the range (from !== to) → emit.
    await clickDay(user, DAY_TO);
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.dateFrom).toBeTruthy();
    expect(last.dateTo).toBeTruthy();
  });

  it("closes the popover after the second (completing) click", async () => {
    vi.stubGlobal("fetch", authMockFetch());
    const onChange = vi.fn();
    renderWithProviders(<QueriesToolbar onChange={onChange} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Date range picker" }));

    // Popover is open: calendar is visible
    expect(document.querySelector('[data-slot="calendar"]')).toBeInTheDocument();

    await clickDay(user, DAY_FROM); // first click — stays open
    await waitForDaySelected(DAY_FROM);
    expect(document.querySelector('[data-slot="calendar"]')).toBeInTheDocument();

    await clickDay(user, DAY_TO); // second click — completes the range → closes
    await waitFor(() =>
      expect(document.querySelector('[data-slot="calendar"]')).not.toBeInTheDocument(),
    );
  });

  it("emits dateFrom: undefined when Clear is clicked after a completed range", async () => {
    vi.stubGlobal("fetch", authMockFetch());
    const onChange = vi.fn();
    renderWithProviders(<QueriesToolbar onChange={onChange} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Date range picker" }));

    // Complete a range first
    await clickDay(user, DAY_FROM);
    await waitForDaySelected(DAY_FROM);
    await clickDay(user, DAY_TO);
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
