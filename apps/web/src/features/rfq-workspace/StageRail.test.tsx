import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StageRail, isRfqStageEnabled, isQuotesStageEnabled, isAwardStageEnabled } from "./StageRail";

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

  it("computes Quotes-stage enablement from status rank (S5.6)", () => {
    expect(isQuotesStageEnabled("DRAFT")).toBe(false);
    expect(isQuotesStageEnabled("RFQ_READY")).toBe(false);
    expect(isQuotesStageEnabled("RFQ_SENT")).toBe(true);
    expect(isQuotesStageEnabled("QUOTED")).toBe(true);
    // QUOTING_CLIENT was the RANK entry this task added (previously missing, which misranked
    // any past-comparison query) — assert it lands on the enabled side of the gate.
    expect(isQuotesStageEnabled("QUOTING_CLIENT")).toBe(true);
  });

  it("computes Award-stage enablement from the status VALUE, not the RANK threshold (S5.8)", () => {
    // The trap this guards: RANK.QUOTING_CLIENT === RANK.QUOTED === 4 (a spec-literal collision,
    // S5.7 T2 M2). A `(RANK[status] ?? 0) >= RANK.QUOTING_CLIENT` implementation would ALSO enable
    // Award for a merely-QUOTED query — before the award has even been frozen — because it shares
    // QUOTING_CLIENT's rank. Award must not be reachable there.
    expect(isAwardStageEnabled("QUOTED")).toBe(false);
    expect(isAwardStageEnabled("RFQ_SENT")).toBe(false);
    expect(isAwardStageEnabled("NO_RESPONSE")).toBe(false);

    expect(isAwardStageEnabled("QUOTING_CLIENT")).toBe(true);
    expect(isAwardStageEnabled("AWAITING_CLIENT_DECISION")).toBe(true);
    expect(isAwardStageEnabled("WON")).toBe(true);
    expect(isAwardStageEnabled("LOST")).toBe(true);
    expect(isAwardStageEnabled("CLOSED")).toBe(true);
  });

  it("links the Award step to /quotation when awardEnabled, and leaves it a non-navigable placeholder otherwise", () => {
    const { rerender } = render(
      <MemoryRouter>
        <StageRail queryId="q1" active="quotes" rfqEnabled quotesEnabled awardEnabled />
      </MemoryRouter>,
    );
    const awardLink = screen.getByRole("link", { name: /award/i });
    expect(awardLink).toHaveAttribute("href", "/queries/q1/quotation");

    rerender(
      <MemoryRouter>
        <StageRail queryId="q1" active="quotes" rfqEnabled quotesEnabled awardEnabled={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /award/i })).not.toBeInTheDocument();
    expect(screen.getByText("Award")).toBeInTheDocument();
  });

  it("renders the Award stage as current when active, with every earlier stage done", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="award" rfqEnabled quotesEnabled awardEnabled />
      </MemoryRouter>,
    );
    const awardLink = screen.getByRole("link", { name: /award/i });
    expect(awardLink).toHaveAttribute("aria-current", "step");
    // Create/RFQ/Quotes all read as done (checkmarks) now that Award is active.
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.queryByText("2")).toBeNull();
    expect(screen.queryByText("3")).toBeNull();
  });

  it("renders the Quotes stage as current and links it to /compare when enabled, with earlier stages done", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="quotes" rfqEnabled quotesEnabled />
      </MemoryRouter>,
    );
    const quotesLink = screen.getByRole("link", { name: /quotes/i });
    expect(quotesLink).toHaveAttribute("href", "/queries/q1/compare");
    expect(quotesLink).toHaveAttribute("aria-current", "step");

    // Create + RFQ read as done (checkmarks, not "1"/"2") now that Quotes is the active step —
    // the index-based state derivation this task introduced, not just the two original steps.
    expect(screen.getByRole("link", { name: /create/i })).toHaveAttribute("href", "/queries/q1");
    expect(screen.getByRole("link", { name: /rfq/i })).toHaveAttribute(
      "href",
      "/queries/q1/workspace",
    );
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.queryByText("2")).toBeNull();
    expect(screen.getByText("3")).toBeInTheDocument(); // Quotes (current) shows its index
    expect(screen.getByText("4")).toBeInTheDocument(); // Award (upcoming) shows its index
  });

  it("renders all four steps; links Create + RFQ when enabled", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="rfq" rfqEnabled />
      </MemoryRouter>,
    );
    for (const label of ["Create", "RFQ", "Quotes", "Award"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: /create/i })).toHaveAttribute("href", "/queries/q1");
    expect(screen.getByRole("link", { name: /rfq/i })).toHaveAttribute("href", "/queries/q1/workspace");
    // Quotes/Award are non-navigable placeholders
    expect(screen.queryByRole("link", { name: /quotes/i })).toBeNull();
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
    expect(screen.getByText("3")).toBeInTheDocument(); // Quotes (upcoming)
    expect(screen.getByText("4")).toBeInTheDocument(); // Award (upcoming)
    expect(screen.queryByText("1")).toBeNull();        // Create is done → checkmark, not "1"
  });
});
