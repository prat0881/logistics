import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const RANK: Record<string, number> = {
  DRAFT: 0, CREATED: 1, RFQ_READY: 2, RFQ_SENT: 3, QUOTED: 4, NO_RESPONSE: 4, QUOTING_CLIENT: 4,
  AWAITING_CLIENT_DECISION: 5, WON: 6, LOST: 6, CLOSED: 7,
};

export function isRfqStageEnabled(status: string): boolean {
  return (RANK[status] ?? 0) >= RANK.RFQ_READY;
}

/** The Compare Quotes screen (S5.6) becomes reachable once the RFQ has gone out. */
export function isQuotesStageEnabled(status: string): boolean {
  return (RANK[status] ?? 0) >= RANK.RFQ_SENT;
}

// S5.8 T5 — statuses that are "QUOTING_CLIENT or later". Deliberately NOT
// `(RANK[status] ?? 0) >= RANK.QUOTING_CLIENT`: QUOTING_CLIENT shares rank 4 with QUOTED (a
// spec-literal value recorded as a parked minor in S5.7 T2 M2, precisely so nobody builds a
// threshold on it) — that comparison would also enable Award for a query that's merely QUOTED,
// before the award has even been frozen. Enumerating the exact statuses and comparing the status
// value directly sidesteps RANK's collision entirely.
const AWARD_ENABLED_STATUSES = new Set([
  "QUOTING_CLIENT",
  "AWAITING_CLIENT_DECISION",
  "WON",
  "LOST",
  "CLOSED",
]);

/** The Client Quotation builder (S5.8) becomes reachable once the award has been frozen and the
 *  query is quoting the client (or has moved past that point). */
export function isAwardStageEnabled(status: string): boolean {
  return AWARD_ENABLED_STATUSES.has(status);
}

type StepState = "done" | "current" | "upcoming";

interface StageRailProps {
  queryId: string;
  active: "create" | "rfq" | "quotes" | "award";
  rfqEnabled: boolean;
  /** Mirrors `rfqEnabled` for the "quotes" step — pass `isQuotesStageEnabled(query.status)`. */
  quotesEnabled?: boolean;
  /** Mirrors `rfqEnabled` for the "award" step — pass `isAwardStageEnabled(query.status)`. */
  awardEnabled?: boolean;
}

// Canonical step order, used to derive each step's state from its index relative to `active`'s
// index — earlier steps are "done", the active one is "current", later ones are "upcoming". This
// generalizes what used to be two hand-written ternaries (correct only for active="create"|"rfq")
// so a step further right — "quotes" — also correctly marks the steps before it as done instead of
// leaving them stuck on "upcoming".
const STEP_KEYS = ["create", "rfq", "quotes", "award"] as const;

export function StageRail({ queryId, active, rfqEnabled, quotesEnabled, awardEnabled }: StageRailProps) {
  const activeIndex = STEP_KEYS.indexOf(active);
  const stateAt = (index: number): StepState =>
    index === activeIndex ? "current" : index < activeIndex ? "done" : "upcoming";

  const steps: Array<{ key: string; label: string; to?: string; state: StepState }> = [
    { key: "create", label: "Create", to: `/queries/${queryId}`, state: stateAt(0) },
    { key: "rfq", label: "RFQ", to: rfqEnabled ? `/queries/${queryId}/workspace` : undefined, state: stateAt(1) },
    { key: "quotes", label: "Quotes", to: quotesEnabled ? `/queries/${queryId}/compare` : undefined, state: stateAt(2) },
    { key: "award", label: "Award", to: awardEnabled ? `/queries/${queryId}/quotation` : undefined, state: stateAt(3) },
  ];

  return (
    <nav aria-label="Query stages" className="flex items-center rounded-lg border border-border bg-card p-3 sm:p-4">
      {steps.map((step, i) => (
        <div key={step.key} className="flex flex-1 items-center last:flex-none">
          <Step index={i} label={step.label} to={step.to} state={step.state} />
          {i < steps.length - 1 && (
            <span aria-hidden className={cn("mx-2 h-0.5 flex-1 rounded", step.state === "done" ? "bg-primary" : "bg-border")} />
          )}
        </div>
      ))}
    </nav>
  );
}

function Step({ index, label, to, state }: { index: number; label: string; to?: string; state: StepState }) {
  const dot = (
    <span
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold",
        state === "done" && "border-primary bg-primary text-primary-foreground",
        state === "current" && "border-primary bg-card text-primary ring-4 ring-primary/15",
        state === "upcoming" && "border-border bg-card text-muted-foreground",
      )}
    >
      {state === "done" ? <Check className="h-3.5 w-3.5" /> : index + 1}
    </span>
  );
  const text = (
    <span className={cn("text-sm font-medium", state === "upcoming" ? "text-muted-foreground" : "text-foreground")}>
      {label}
    </span>
  );
  const body = <span className="flex items-center gap-2">{dot}{text}</span>;
  const current = state === "current" ? "step" : undefined;
  return to
    ? <Link to={to} aria-current={current} className="rounded-md px-1 py-0.5 transition-opacity hover:opacity-80">{body}</Link>
    : <span className="px-1 py-0.5 cursor-not-allowed" aria-disabled="true" aria-current={current}>{body}</span>;
}
