import type { AwardDecisionEventDto } from "@svyft/shared";
import { formatDateTime } from "@/lib/dates";

// The full set of `AwardDecisionEvent.type` values actually emitted by AwardService/
// NegotiationService (award.service.ts + negotiation.service.ts) as of S5.5/S5.6 Task 4. `type`
// stays a plain string on the DTO (see award.ts's doc comment) since the event log is
// append-only/additive — an unmapped future type falls back to the raw string below rather than
// crashing.
const EVENT_LABEL: Record<string, string> = {
  SHORTLIST: "Shortlisted",
  SEND_FOR_APPROVAL: "Sent for approval",
  APPROVE: "Approved",
  REJECT: "Rejected",
  GENERATE: "Client quote generated",
  REOPEN: "Reopened",
  REQUEST_REQUOTE: "Re-quote requested",
};

export interface DecisionTimelineProps {
  timeline: AwardDecisionEventDto[];
}

/**
 * DecisionTimeline — the leg's maker-checker audit trail (S5.6 Task 5, ambiguity resolution #3).
 * Renders in EVERY mode (Executive and Manager+ alike — the maker sees the checker's rejection
 * reasons and vice versa), straight off `leg.timeline` with no client-side inference. Empty
 * timeline (nothing has happened yet on this leg) renders a muted note instead of an empty card.
 */
export function DecisionTimeline({ timeline }: DecisionTimelineProps) {
  if (timeline.length === 0) {
    return <p className="text-sm text-muted-foreground">No decisions yet.</p>;
  }

  return (
    <div
      data-testid="decision-timeline"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Decision timeline
      </h3>
      <ul className="space-y-2">
        {timeline.map((ev) => (
          <li key={ev.id} className="border-l-2 border-border pl-3 text-sm">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{EVENT_LABEL[ev.type] ?? ev.type}</span>
              <span className="text-xs text-muted-foreground">{formatDateTime(ev.at)}</span>
            </div>
            {ev.reason && <p className="text-xs text-muted-foreground">{ev.reason}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
