import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StageRail, isRfqStageEnabled, isQuotesStageEnabled, isQuotationStageEnabled } from "./StageRail";

describe("StageRail", () => {
  it("computes RFQ-stage enablement from status rank", () => {
    expect(isRfqStageEnabled("DRAFT")).toBe(false);
    expect(isRfqStageEnabled("CREATED")).toBe(false);
    expect(isRfqStageEnabled("RFQ_READY")).toBe(true);
    expect(isRfqStageEnabled("RFQ_SENT")).toBe(true);
    expect(isRfqStageEnabled("QUOTED")).toBe(true);
    // NO_RESPONSE (Task 12) is a sibling outcome of the same FULLY_QUOTED leg-rollup gate as
    // QUOTED — the RFQ was still fully sent/resolved, just with no live quote at the end.
    expect(isRfqStageEnabled("NO_RESPONSE")).toBe(true);
  });

  it("computes Quotes-gate enablement from status rank (S5.6) — still the earlier of the two gates that jointly drive the merged Quotation step (S5.9.3 P5)", () => {
    expect(isQuotesStageEnabled("DRAFT")).toBe(false);
    expect(isQuotesStageEnabled("RFQ_READY")).toBe(false);
    expect(isQuotesStageEnabled("RFQ_SENT")).toBe(true);
    expect(isQuotesStageEnabled("QUOTED")).toBe(true);
    // QUOTING_CLIENT was the RANK entry this task added (previously missing, which misranked
    // any past-comparison query) — assert it lands on the enabled side of the gate.
    expect(isQuotesStageEnabled("QUOTING_CLIENT")).toBe(true);
  });

  it("computes Quotation-gate enablement from the status VALUE, not the RANK threshold (S5.8)", () => {
    // The trap this guards: RANK.QUOTING_CLIENT === RANK.QUOTED === 4 (a spec-literal collision,
    // S5.7 T2 M2). A `(RANK[status] ?? 0) >= RANK.QUOTING_CLIENT` implementation would ALSO enable
    // the client-quotation gate for a merely-QUOTED query — before the award has even been frozen
    // — because it shares QUOTING_CLIENT's rank. It must not be reachable there.
    expect(isQuotationStageEnabled("QUOTED")).toBe(false);
    expect(isQuotationStageEnabled("RFQ_SENT")).toBe(false);
    expect(isQuotationStageEnabled("NO_RESPONSE")).toBe(false);

    expect(isQuotationStageEnabled("QUOTING_CLIENT")).toBe(true);
    expect(isQuotationStageEnabled("AWAITING_CLIENT_DECISION")).toBe(true);
    expect(isQuotationStageEnabled("WON")).toBe(true);
    expect(isQuotationStageEnabled("LOST")).toBe(true);
    expect(isQuotationStageEnabled("CLOSED")).toBe(true);
  });

  // ── S5.9.3 P5 — the merged rail: Create → RFQ → Quotation → Award ──────────────────────────

  it("renders exactly four steps, in order: Create, RFQ, Quotation, Award", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="rfq" rfqEnabled />
      </MemoryRouter>,
    );
    const rail = screen.getByRole("navigation", { name: /query stages/i });
    const labels = within(rail)
      .getAllByText(/^(Create|RFQ|Quotation|Award)$/)
      .map((el) => el.textContent);
    expect(labels).toEqual(["Create", "RFQ", "Quotation", "Award"]);
    // The old standalone "Quotes" label no longer exists anywhere in the rail.
    expect(within(rail).queryByText("Quotes")).toBeNull();
  });

  it("links the merged Quotation step to Compare Quotes once the earlier gate opens, before the client-quotation builder is reachable", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="quotation" rfqEnabled quotesEnabled quotationEnabled={false} />
      </MemoryRouter>,
    );
    const quotationLink = screen.getByRole("link", { name: /quotation/i });
    expect(quotationLink).toHaveAttribute("href", "/queries/q1/compare");
    expect(quotationLink).toHaveAttribute("aria-current", "step");
  });

  it("switches the merged Quotation step's link to the client-quotation builder once that gate opens", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="quotation" rfqEnabled quotesEnabled quotationEnabled />
      </MemoryRouter>,
    );
    const quotationLink = screen.getByRole("link", { name: /quotation/i });
    expect(quotationLink).toHaveAttribute("href", "/queries/q1/quotation");
    expect(quotationLink).toHaveAttribute("aria-current", "step");
  });

  it("leaves the Quotation step a non-navigable placeholder when neither gate has opened", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="rfq" rfqEnabled />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /quotation/i })).not.toBeInTheDocument();
    expect(screen.getByText("Quotation")).toBeInTheDocument();
  });

  it("renders the Quotation stage as current when active, with every earlier stage done", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="quotation" rfqEnabled quotesEnabled quotationEnabled />
      </MemoryRouter>,
    );
    const quotationLink = screen.getByRole("link", { name: /quotation/i });
    expect(quotationLink).toHaveAttribute("aria-current", "step");
    // Create/RFQ both read as done (checkmarks) now that Quotation is active — so their numeric
    // indices ("1", "2") are gone.
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.queryByText("2")).toBeNull();
    // Award (upcoming, index 3) still shows its number.
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  // ── Award — always disabled in Stage 5 (D5: legitimate only because it names a FUTURE stage) ──

  it("renders Award with no link and disabled, at every reachable Stage-5 status/active combination", () => {
    const cases: Array<{ active: "create" | "rfq" | "quotation"; quotesEnabled?: boolean; quotationEnabled?: boolean }> = [
      { active: "create" },
      { active: "rfq", quotesEnabled: false, quotationEnabled: false },
      { active: "quotation", quotesEnabled: true, quotationEnabled: false },
      { active: "quotation", quotesEnabled: true, quotationEnabled: true },
    ];
    for (const c of cases) {
      const { unmount } = render(
        <MemoryRouter>
          <StageRail
            queryId="q1"
            active={c.active}
            rfqEnabled
            quotesEnabled={c.quotesEnabled}
            quotationEnabled={c.quotationEnabled}
          />
        </MemoryRouter>,
      );
      expect(screen.queryByRole("link", { name: /award/i })).not.toBeInTheDocument();
      const awardStep = screen.getByText("Award").closest("span[aria-disabled]");
      expect(awardStep).toHaveAttribute("aria-disabled", "true");
      expect(awardStep).not.toHaveAttribute("aria-current", "step");
      unmount();
    }
  });

  // Guards against Award ever being accidentally wired to an enabling prop (e.g.
  // `quotationEnabled ? ".../award" : undefined`, the shape every OTHER step in this file has) —
  // mutation-proven in task-3-report.md.
  it("stays disabled even when every other stage's gate is fully open", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="quotation" rfqEnabled quotesEnabled quotationEnabled />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /award/i })).not.toBeInTheDocument();
  });

  it("renders all four steps; links Create + RFQ when enabled", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="rfq" rfqEnabled />
      </MemoryRouter>,
    );
    for (const label of ["Create", "RFQ", "Quotation", "Award"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: /create/i })).toHaveAttribute("href", "/queries/q1");
    expect(screen.getByRole("link", { name: /rfq/i })).toHaveAttribute("href", "/queries/q1/workspace");
    // Quotation/Award are non-navigable placeholders
    expect(screen.queryByRole("link", { name: /quotation/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /award/i })).toBeNull();
  });

  it("disables the RFQ stage (no link) when not enabled", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="create" rfqEnabled={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /rfq/i })).not.toBeInTheDocument();
    expect(screen.getByText("RFQ")).toBeInTheDocument();
  });

  it("renders numbered indices and marks earlier steps done", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="rfq" rfqEnabled />
      </MemoryRouter>,
    );
    expect(screen.getByText("2")).toBeInTheDocument(); // RFQ (current) shows its index
    expect(screen.getByText("3")).toBeInTheDocument(); // Quotation (upcoming)
    expect(screen.getByText("4")).toBeInTheDocument(); // Award (upcoming)
    expect(screen.queryByText("1")).toBeNull();        // Create is done → checkmark, not "1"
  });

  // 🔴 S5.9.3 final review — `active` used to admit "award" while a comment in the same file said
  // no caller may pass it. It is not a harmless spare literal: `Step` puts `aria-current="step"`
  // on whichever step is active, disabled span included, so a caller passing it would have the
  // app announce a *current* stage named "Award" — the exact 2026-08-19 D5 mistake, reachable
  // through a type the component itself permitted. The type is the guard now.
  //
  // This assertion is compile-time, enforced by `pnpm run typecheck` (vitest transpiles without
  // type-checking, so it proves nothing at runtime and deliberately renders nothing). Mutation
  // proof: put `| "award"` back in `StageRailProps["active"]` and `tsc` fails right here with
  // "Unused '@ts-expect-error' directive" — the directive reddens on the widening, which is the
  // regression this is guarding against.
  it("refuses active=\"award\" at the type level — D5: 'Award' may name only the future, disabled stage", () => {
    const railWithAwardActive = () => (
      <MemoryRouter>
        {/* @ts-expect-error "award" is not an assignable `active` value — see StageRailProps. */}
        <StageRail queryId="q1" active="award" rfqEnabled />
      </MemoryRouter>
    );
    expect(typeof railWithAwardActive).toBe("function");
  });
});
