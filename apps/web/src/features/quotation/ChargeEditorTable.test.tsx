import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PricedLeg } from "@svyft/shared";
import { ChargeEditorTable } from "./ChargeEditorTable";

/**
 * `LEG` fixture. The quotation it came from is at margin 20% (`clientAmount(costUsd, 20) =
 * costUsd * 1.2`) — stated for the reader only: this component no longer takes `marginPct` at all,
 * which is the structural half of the final review's IMPORTANT #4 fix (nothing here can compare a
 * typed value against the formula, because nothing here knows the formula).
 *  - ORIGIN:0  cost 100, client 120, overridden TRUE  — a pin that happens to equal the formula
 *              value (`clientAmount(100, 20) === 120`), the exact edge case Task 2's report flagged
 *              as the only case that can tell key-presence semantics apart from value-comparison.
 *  - ORIGIN:1  cost 100, client 120, overridden FALSE — numerically identical to ORIGIN:0's client
 *              price, so a badge driven by "does clientUsd differ from the formula" would show it
 *              here too. It must not: the badge is driven by `line.overridden` alone.
 *  - FREIGHT:0 cost 50,  client 60,  overridden FALSE — used for the edit/blur commit tests.
 */
const LEG: PricedLeg = {
  legId: "l1",
  legCode: "LEG-1",
  forwarderName: "TCI Freight",
  variantLabel: "Dedicated",
  groups: [
    {
      group: "ORIGIN",
      label: "Origin charges",
      lines: [
        {
          id: "ORIGIN:0",
          group: "ORIGIN",
          label: "Origin handling",
          costNative: 100,
          costUsd: 100,
          clientUsd: 120,
          overridden: true,
        },
        {
          id: "ORIGIN:1",
          group: "ORIGIN",
          label: "Origin documentation",
          costNative: 100,
          costUsd: 100,
          clientUsd: 120,
          overridden: false,
        },
      ],
      costUsd: 200,
      clientUsd: 240,
    },
    {
      group: "FREIGHT",
      label: "Freight",
      lines: [
        {
          id: "FREIGHT:0",
          group: "FREIGHT",
          label: "Ocean freight",
          costNative: 50,
          costUsd: 50,
          clientUsd: 60,
          overridden: false,
        },
      ],
      costUsd: 50,
      clientUsd: 60,
    },
  ],
  costUsd: 250,
  clientUsd: 300,
};

/** `LEG` with its single FREIGHT line replaced — the shape the server hands back for a pinned
 *  line, rather than re-editing one static fixture twice in a single render (which would never
 *  see `line.overridden` flip; that only happens via a fresh prop from the server). */
function withFreightLine(over: { clientUsd: number; overridden: boolean }): PricedLeg {
  return {
    ...LEG,
    groups: LEG.groups.map((g) =>
      g.group !== "FREIGHT"
        ? g
        : { ...g, lines: [{ ...g.lines[0], ...over }], clientUsd: over.clientUsd },
    ),
  };
}

describe("ChargeEditorTable", () => {
  it("collapses groups by default — group totals show, lines don't — and expanding reveals only that group's lines", async () => {
    render(<ChargeEditorTable leg={LEG} onCommitOverride={vi.fn()} />);

    // Group-level cost/client totals are visible before anything is expanded (ambiguity
    // resolution #1 — a group row shows its own totals whether collapsed or open).
    expect(screen.getByText("$200.00")).toBeInTheDocument(); // ORIGIN group cost
    expect(screen.getByText("$240.00")).toBeInTheDocument(); // ORIGIN group client
    expect(screen.queryByTestId("line-l1-ORIGIN:0")).not.toBeInTheDocument();
    expect(screen.queryByTestId("line-l1-ORIGIN:1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("line-l1-FREIGHT:0")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /origin charges/i }));

    expect(screen.getByTestId("line-l1-ORIGIN:0")).toBeInTheDocument();
    expect(screen.getByTestId("line-l1-ORIGIN:1")).toBeInTheDocument();
    // FREIGHT was never clicked — it stays collapsed independently of ORIGIN.
    expect(screen.queryByTestId("line-l1-FREIGHT:0")).not.toBeInTheDocument();
  });

  it("shows both the forwarder cost and the client price for a line once its group is expanded", async () => {
    render(<ChargeEditorTable leg={LEG} onCommitOverride={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^freight$/i }));

    const row = screen.getByTestId("line-l1-FREIGHT:0");
    expect(within(row).getByText("$50.00")).toBeInTheDocument();
    expect(within(row).getByDisplayValue("60")).toBeInTheDocument();
  });

  it("renders the pinned badge purely from line.overridden, even when the value equals the formula result", async () => {
    render(<ChargeEditorTable leg={LEG} onCommitOverride={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /origin charges/i }));

    // Both lines display the SAME client price (120.00 === clientAmount(100, 20)) — only
    // line.overridden distinguishes them. A badge computed from "clientUsd differs from the
    // formula" would show on neither or both; only reading the prop gets ORIGIN:0 right and
    // ORIGIN:1 wrong-if-it-showed.
    expect(within(screen.getByTestId("line-l1-ORIGIN:0")).getByText(/pinned/i)).toBeInTheDocument();
    expect(
      within(screen.getByTestId("line-l1-ORIGIN:1")).queryByText(/pinned/i),
    ).not.toBeInTheDocument();
  });

  it("commits the typed value on blur", async () => {
    const onCommitOverride = vi.fn();
    render(<ChargeEditorTable leg={LEG} onCommitOverride={onCommitOverride} />);
    await userEvent.click(screen.getByRole("button", { name: /^freight$/i }));

    const input = within(screen.getByTestId("line-l1-FREIGHT:0")).getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "75");
    await userEvent.tab();

    expect(onCommitOverride).toHaveBeenCalledWith("l1", "FREIGHT:0", 75);
  });

  // 🔴 Final review IMPORTANT #4. This test previously asserted the OPPOSITE — that typing the
  // formula's own value RELEASED the pin — which encoded a divergence from the server's semantics
  // as a requirement, so the suite itself protected the bug. The server treats `overridden` as KEY
  // PRESENCE (`priceQuotation`: `key in overrides`), and Task 2's fix round exists precisely to
  // support "pinned at the value the formula would also have produced". That state has to be
  // reachable — and survivable — from the UI too.
  it("keeps the line pinned when the user types the formula's own value into it", async () => {
    const onCommitOverride = vi.fn();
    // Pinned at 75; clientAmount(50, 20) === 60, so 60 is "the formula's own value".
    render(
      <ChargeEditorTable
        leg={withFreightLine({ clientUsd: 75, overridden: true })}
        onCommitOverride={onCommitOverride}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^freight$/i }));

    const input = within(screen.getByTestId("line-l1-FREIGHT:0")).getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "60");
    await userEvent.tab();

    // 60 as an OVERRIDE — never `undefined`, which would have deleted the key and released the pin.
    expect(onCommitOverride).toHaveBeenCalledWith("l1", "FREIGHT:0", 60);
  });

  // 🔴 The worst shape of IMPORTANT #4: a line pinned at a value that LATER coincides with the
  // formula (pinned at 60; the margin then moves to 20%, where clientAmount(50, 20) is also 60) was
  // silently unpinned by nothing more than clicking into the field and tabbing out, because the
  // release (`undefined`) sailed past the no-op guard — `undefined !== 60`.
  it("never releases a pin whose value coincides with the formula, on focus/blur or on retyping it", async () => {
    const onCommitOverride = vi.fn();
    render(
      <ChargeEditorTable
        leg={withFreightLine({ clientUsd: 60, overridden: true })}
        onCommitOverride={onCommitOverride}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^freight$/i }));
    const input = within(screen.getByTestId("line-l1-FREIGHT:0")).getByRole("spinbutton");

    // (a) focused and blurred, never edited.
    await userEvent.click(input);
    await userEvent.tab();
    expect(onCommitOverride).not.toHaveBeenCalled();

    // (b) genuinely retyped, to the same number it already holds — still a no-op, not a release.
    await userEvent.clear(input);
    await userEvent.type(input, "60");
    await userEvent.tab();
    expect(onCommitOverride).not.toHaveBeenCalled();
  });

  // Releasing a pin is an EXPLICIT act now that typing the formula's value no longer does it.
  // Without this per-line control, the page-wide "Reset overrides" — which clears every pin on the
  // whole quotation — would be the only way to undo one line.
  it("releases a pin through the per-line clear control, which only pinned lines have", async () => {
    const onCommitOverride = vi.fn();
    render(<ChargeEditorTable leg={LEG} onCommitOverride={onCommitOverride} />);
    await userEvent.click(screen.getByRole("button", { name: /origin charges/i }));

    // ORIGIN:1 isn't pinned — no clear control at all.
    expect(
      within(screen.getByTestId("line-l1-ORIGIN:1")).queryByRole("button", { name: /clear/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      within(screen.getByTestId("line-l1-ORIGIN:0")).getByRole("button", { name: /clear/i }),
    );
    expect(onCommitOverride).toHaveBeenCalledWith("l1", "ORIGIN:0", undefined);
  });

  // S5.8 Task 6, ambiguity resolution #3 — an ISSUED quotation's charge editor "must render
  // read-only — no editable prices". `QuotationPage` passes `readOnly` for any non-DRAFT status.
  it("renders client prices as plain text, with no inputs and no clear controls, when readOnly", async () => {
    render(<ChargeEditorTable leg={LEG} onCommitOverride={vi.fn()} readOnly />);
    await userEvent.click(screen.getByRole("button", { name: /^freight$/i }));
    await userEvent.click(screen.getByRole("button", { name: /origin charges/i }));

    const row = screen.getByTestId("line-l1-FREIGHT:0");
    expect(within(row).getByText("$60.00")).toBeInTheDocument();
    expect(within(row).queryByRole("spinbutton")).not.toBeInTheDocument();
    // The badge is a historical fact about how the line was priced, so it stays; the control that
    // would change it must not.
    const pinnedRow = screen.getByTestId("line-l1-ORIGIN:0");
    expect(within(pinnedRow).getByText(/pinned/i)).toBeInTheDocument();
    expect(within(pinnedRow).queryByRole("button", { name: /clear/i })).not.toBeInTheDocument();
  });

  it("does not commit anything when a field is blurred without its value changing", async () => {
    // The regression this guards: `userEvent.tab()`/a click elsewhere blurs whichever field last
    // had focus. Without this guard, simply tabbing past an UNTOUCHED field (still showing the
    // formula value, never edited) fires a full-map PATCH anyway — pure waste at best, and a race
    // against a genuine edit's own PATCH at worst (this is exactly how it was first caught: an
    // integration test tabbing from an edited line towards the margin input blurred an untouched
    // sibling on the way, which fired a second, spurious commit).
    const onCommitOverride = vi.fn();
    render(<ChargeEditorTable leg={LEG} onCommitOverride={onCommitOverride} />);
    await userEvent.click(screen.getByRole("button", { name: /^freight$/i }));

    const input = within(screen.getByTestId("line-l1-FREIGHT:0")).getByRole("spinbutton");
    await userEvent.click(input);
    await userEvent.tab();

    expect(onCommitOverride).not.toHaveBeenCalled();
  });
});
