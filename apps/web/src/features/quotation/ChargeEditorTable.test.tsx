import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PricedLeg } from "@svyft/shared";
import { ChargeEditorTable } from "./ChargeEditorTable";

/**
 * `LEG` fixture, margin 20% (`clientAmount(costUsd, 20) = costUsd * 1.2`):
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

describe("ChargeEditorTable", () => {
  it("collapses groups by default — group totals show, lines don't — and expanding reveals only that group's lines", async () => {
    render(<ChargeEditorTable leg={LEG} marginPct={20} onCommitOverride={vi.fn()} />);

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
    render(<ChargeEditorTable leg={LEG} marginPct={20} onCommitOverride={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^freight$/i }));

    const row = screen.getByTestId("line-l1-FREIGHT:0");
    expect(within(row).getByText("$50.00")).toBeInTheDocument();
    expect(within(row).getByDisplayValue("60")).toBeInTheDocument();
  });

  it("renders the pinned badge purely from line.overridden, even when the value equals the formula result", async () => {
    render(<ChargeEditorTable leg={LEG} marginPct={20} onCommitOverride={vi.fn()} />);
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

  it("commits the typed value on blur when it differs from the formula", async () => {
    const onCommitOverride = vi.fn();
    render(<ChargeEditorTable leg={LEG} marginPct={20} onCommitOverride={onCommitOverride} />);
    await userEvent.click(screen.getByRole("button", { name: /^freight$/i }));

    const input = within(screen.getByTestId("line-l1-FREIGHT:0")).getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "75");
    await userEvent.tab();

    expect(onCommitOverride).toHaveBeenCalledWith("l1", "FREIGHT:0", 75);
  });

  it("releases an already-pinned line when the typed value matches the formula", async () => {
    // Starts from what the server would actually hand back for a pinned line — clientUsd 75,
    // overridden true — rather than re-editing the same static fixture twice in one render, which
    // would never see `line.overridden` flip (that only happens via a fresh prop from the server).
    const pinnedLeg: PricedLeg = {
      ...LEG,
      groups: LEG.groups.map((g) =>
        g.group !== "FREIGHT"
          ? g
          : { ...g, lines: [{ ...g.lines[0], clientUsd: 75, overridden: true }], clientUsd: 75 },
      ),
    };
    const onCommitOverride = vi.fn();
    render(<ChargeEditorTable leg={pinnedLeg} marginPct={20} onCommitOverride={onCommitOverride} />);
    await userEvent.click(screen.getByRole("button", { name: /^freight$/i }));

    const input = within(screen.getByTestId("line-l1-FREIGHT:0")).getByRole("spinbutton");
    // clientAmount(50, 20) === 60 — typing the formula's own value back releases the pin.
    await userEvent.clear(input);
    await userEvent.type(input, "60");
    await userEvent.tab();

    expect(onCommitOverride).toHaveBeenCalledWith("l1", "FREIGHT:0", undefined);
  });

  it("does not commit anything when a field is blurred without its value changing", async () => {
    // The regression this guards: `userEvent.tab()`/a click elsewhere blurs whichever field last
    // had focus. Without this guard, simply tabbing past an UNTOUCHED field (still showing the
    // formula value, never edited) fires a full-map PATCH anyway — pure waste at best, and a race
    // against a genuine edit's own PATCH at worst (this is exactly how it was first caught: an
    // integration test tabbing from an edited line towards the margin input blurred an untouched
    // sibling on the way, which fired a second, spurious commit).
    const onCommitOverride = vi.fn();
    render(<ChargeEditorTable leg={LEG} marginPct={20} onCommitOverride={onCommitOverride} />);
    await userEvent.click(screen.getByRole("button", { name: /^freight$/i }));

    const input = within(screen.getByTestId("line-l1-FREIGHT:0")).getByRole("spinbutton");
    await userEvent.click(input);
    await userEvent.tab();

    expect(onCommitOverride).not.toHaveBeenCalled();
  });
});
