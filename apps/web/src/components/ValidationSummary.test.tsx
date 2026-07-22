import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Finding } from "@svyft/shared";
import { ValidationSummary } from "./ValidationSummary";

const findings: Finding[] = [
  { rule: "F1", severity: "blocking", scope: { type: "query", id: "q" }, message: "Client is required" },
  { rule: "F1", severity: "blocking", scope: { type: "field", id: "incoterms" }, message: "Incoterms is required" },
  { rule: "F7", severity: "blocking", scope: { type: "field", id: "notes" }, message: "Internal notes are required" },
];

describe("ValidationSummary", () => {
  it("returns null when there are no findings", () => {
    const { container } = render(<ValidationSummary findings={[]} onNavigate={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
  it("groups findings under their tab and navigates on click", async () => {
    const onNavigate = vi.fn();
    render(<ValidationSummary findings={findings} onNavigate={onNavigate} />);
    expect(screen.getByText("Client is required")).toBeInTheDocument();
    // group headings by tab label
    expect(screen.getByText(/Client & Query/i)).toBeInTheDocument();
    expect(screen.getByText(/Shipment/i)).toBeInTheDocument();
    expect(screen.getByText(/Notes & Checklist/i)).toBeInTheDocument();
    await userEvent.click(screen.getByText("Incoterms is required"));
    expect(onNavigate).toHaveBeenCalledWith("shipment");
  });
});
