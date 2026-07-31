import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const RANK: Record<string, number> = {
  DRAFT: 0, CREATED: 1, RFQ_READY: 2, RFQ_SENT: 3, QUOTED: 4,
  AWAITING_CLIENT_DECISION: 5, WON: 6, LOST: 6, CLOSED: 7,
};

export function isRfqStageEnabled(status: string): boolean {
  return (RANK[status] ?? 0) >= RANK.RFQ_READY;
}

type StepState = "done" | "current" | "upcoming";

interface StageRailProps {
  queryId: string;
  active: "create" | "rfq";
  rfqEnabled: boolean;
}

export function StageRail({ queryId, active, rfqEnabled }: StageRailProps) {
  const steps: Array<{ key: string; label: string; to?: string; state: StepState }> = [
    { key: "create", label: "Create", to: `/queries/${queryId}`, state: active === "create" ? "current" : "done" },
    { key: "rfq", label: "RFQ", to: rfqEnabled ? `/queries/${queryId}/workspace` : undefined, state: active === "rfq" ? "current" : "upcoming" },
    { key: "quotes", label: "Quotes", state: "upcoming" },
    { key: "award", label: "Award", state: "upcoming" },
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
