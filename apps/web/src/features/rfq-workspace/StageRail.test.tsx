import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StageRail, isRfqStageEnabled } from "./StageRail";

describe("StageRail", () => {
  it("computes RFQ-stage enablement from status rank", () => {
    expect(isRfqStageEnabled("DRAFT")).toBe(false);
    expect(isRfqStageEnabled("CREATED")).toBe(false);
    expect(isRfqStageEnabled("RFQ_READY")).toBe(true);
    expect(isRfqStageEnabled("RFQ_SENT")).toBe(true);
    expect(isRfqStageEnabled("QUOTED")).toBe(true);
  });

  it("links Create to the wizard and RFQ to the workspace when enabled", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="create" rfqEnabled />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /create/i })).toHaveAttribute("href", "/queries/q1");
    expect(screen.getByRole("link", { name: /rfq/i })).toHaveAttribute("href", "/queries/q1/workspace");
  });

  it("disables the RFQ stage (no link) when not enabled", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="create" rfqEnabled={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /rfq/i })).not.toBeInTheDocument();
    expect(screen.getByText(/rfq/i)).toBeInTheDocument();
  });
});
