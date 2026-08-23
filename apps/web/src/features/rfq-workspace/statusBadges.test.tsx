import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LegStatusBadge, ForwarderStatusBadge } from "./statusBadges";

describe("status badges", () => {
  it("renders a human leg status label", () => {
    render(<LegStatusBadge status="RFQ_SENT" />);
    expect(screen.getByText("RFQ Sent")).toBeInTheDocument();
  });
  it("maps forwarder (quote) status to the spec label", () => {
    render(<ForwarderStatusBadge status="SELECT" />);
    expect(screen.getByText("Select")).toBeInTheDocument();
  });
  // S5.9.2 Q4 — REQUOTED reads "RFQ-Resent", never "Requoted": the state is pending (we are
  // waiting on the forwarder), and it must read alongside RFQ_SENT's "RFQ Sent".
  it("labels a REQUOTED forwarder RFQ-Resent, not Requoted", () => {
    render(<ForwarderStatusBadge status="REQUOTED" />);
    expect(screen.getByText("RFQ-Resent")).toBeInTheDocument();
    expect(screen.queryByText("Requoted")).not.toBeInTheDocument();
  });
});
