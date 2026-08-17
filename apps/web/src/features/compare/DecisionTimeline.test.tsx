import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AwardDecisionEventDto } from "@svyft/shared";
import { DecisionTimeline } from "./DecisionTimeline";

const EVENT: AwardDecisionEventDto = {
  id: "ev1",
  legId: "leg-1",
  type: "SHORTLIST",
  quoteId: "quote-1",
  variant: "DEDICATED",
  reason: null,
  actorId: "u1",
  at: "2026-08-14T08:00:00.000Z",
};

describe("DecisionTimeline", () => {
  it("renders nothing crashy and a muted message for an empty timeline", () => {
    render(<DecisionTimeline timeline={[]} />);
    expect(screen.queryByTestId("decision-timeline")).not.toBeInTheDocument();
    expect(screen.getByText(/no decisions yet/i)).toBeInTheDocument();
  });

  it("maps known event types to human labels", () => {
    render(
      <DecisionTimeline
        timeline={[
          EVENT,
          { ...EVENT, id: "ev2", type: "SEND_FOR_APPROVAL" },
          { ...EVENT, id: "ev3", type: "APPROVE" },
          { ...EVENT, id: "ev4", type: "REJECT", reason: "Price too high." },
          { ...EVENT, id: "ev5", type: "GENERATE" },
          { ...EVENT, id: "ev6", type: "REOPEN" },
          { ...EVENT, id: "ev7", type: "REQUEST_REQUOTE" },
        ]}
      />,
    );

    expect(screen.getByText(/shortlisted/i)).toBeInTheDocument();
    expect(screen.getByText(/sent for approval/i)).toBeInTheDocument();
    expect(screen.getByText(/^approved$/i)).toBeInTheDocument();
    expect(screen.getByText(/^rejected$/i)).toBeInTheDocument();
    expect(screen.getByText(/price too high/i)).toBeInTheDocument();
    expect(screen.getByText(/generated/i)).toBeInTheDocument();
    expect(screen.getByText(/reopened/i)).toBeInTheDocument();
    expect(screen.getByText(/re-quote requested/i)).toBeInTheDocument();
  });

  it("falls back to the raw type string for an unmapped event type without crashing", () => {
    render(<DecisionTimeline timeline={[{ ...EVENT, type: "SOME_FUTURE_EVENT" }]} />);
    expect(screen.getByText("SOME_FUTURE_EVENT")).toBeInTheDocument();
  });
});
