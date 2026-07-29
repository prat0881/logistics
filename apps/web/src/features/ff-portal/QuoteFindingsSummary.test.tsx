import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Finding } from "@svyft/shared";
import { QuoteFindingsSummary } from "./QuoteFindingsSummary";

const findings: Finding[] = [
  { rule: "Q4", severity: "blocking", scope: { type: "field", id: "currency" }, message: "Currency is required" },
  { rule: "Q2", severity: "blocking", scope: { type: "cargo", id: "c1" }, message: "Freight density is required for every cargo row" },
];

describe("QuoteFindingsSummary", () => {
  it("renders blocking findings and calls onNavigate on click", async () => {
    const onNavigate = vi.fn();
    render(<QuoteFindingsSummary findings={findings} legId="L1" onNavigate={onNavigate} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Currency is required"));
    expect(onNavigate).toHaveBeenCalledWith("rfq");
  });

  it("returns null with no blocking findings", () => {
    const { container } = render(<QuoteFindingsSummary findings={[]} legId="L1" onNavigate={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not render non-blocking (warning) findings", () => {
    const warningFindings: Finding[] = [
      { rule: "Q4", severity: "warning", scope: { type: "field", id: "currency" }, message: "Currency warning only" },
    ];
    const { container } = render(<QuoteFindingsSummary findings={warningFindings} legId="L1" onNavigate={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Currency warning only")).not.toBeInTheDocument();
  });
});
