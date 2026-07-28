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
});
