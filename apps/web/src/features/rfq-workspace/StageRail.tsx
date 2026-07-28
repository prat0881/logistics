import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

const RANK: Record<string, number> = {
  DRAFT: 0, CREATED: 1, RFQ_READY: 2, RFQ_SENT: 3, QUOTED: 4,
  AWAITING_CLIENT_DECISION: 5, WON: 6, LOST: 6, CLOSED: 7,
};

export function isRfqStageEnabled(status: string): boolean {
  return (RANK[status] ?? 0) >= RANK.RFQ_READY;
}

interface StageRailProps {
  queryId: string;
  active: "create" | "rfq";
  rfqEnabled: boolean;
}

export function StageRail({ queryId, active, rfqEnabled }: StageRailProps) {
  const base = "rounded-md px-3 py-1.5 text-sm font-medium transition-colors";
  const on = "bg-primary text-primary-foreground";
  const off = "text-muted-foreground hover:bg-muted";
  return (
    <nav aria-label="Query stages" className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
      <Link to={`/queries/${queryId}`} className={cn(base, active === "create" ? on : off)}>
        Create
      </Link>
      {rfqEnabled ? (
        <Link to={`/queries/${queryId}/workspace`} className={cn(base, active === "rfq" ? on : off)}>
          RFQ
        </Link>
      ) : (
        <span className={cn(base, "cursor-not-allowed text-muted-foreground/50")} aria-disabled="true">
          RFQ
        </span>
      )}
      <span className={cn(base, "cursor-not-allowed text-muted-foreground/40")} aria-disabled="true">Quotes</span>
      <span className={cn(base, "cursor-not-allowed text-muted-foreground/40")} aria-disabled="true">Award</span>
    </nav>
  );
}
