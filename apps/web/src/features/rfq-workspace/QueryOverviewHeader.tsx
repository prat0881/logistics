import type { QueryDetail, QueryStatus } from "@svyft/shared";
import { Badge } from "@/components/ui/badge";
import { CargoTagIcons } from "./CargoTagIcons";

const QUERY_STATUS_LABEL: Record<QueryStatus, string> = {
  DRAFT: "Draft",
  CREATED: "Created",
  RFQ_READY: "RFQ Ready",
  RFQ_SENT: "RFQ Sent",
  QUOTED: "Quoted",
  NO_RESPONSE: "No Response",
  AWAITING_CLIENT_DECISION: "Awaiting Client Decision",
  WON: "Won",
  LOST: "Lost",
  CLOSED: "Closed",
};

function queryStatusVariant(s: string) {
  if (s === "DRAFT") return "pending" as const;
  if (s === "CREATED") return "secondary" as const;
  if (s === "RFQ_READY") return "default" as const;
  if (s === "RFQ_SENT") return "accent" as const;
  if (s === "QUOTED" || s === "WON") return "success" as const;
  if (s === "NO_RESPONSE") return "warning" as const;
  return "outline" as const;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

export function QueryOverviewHeader({ query }: { query: QueryDetail }) {
  const totals = query.legs.reduce(
    (a, l) => ({
      pkg: a.pkg + l.rollup.totalPackages,
      cbm: a.cbm + l.rollup.totalCbm,
      gross: a.gross + l.rollup.totalGrossWt,
    }),
    { pkg: 0, cbm: 0, gross: 0 },
  );
  const statusLabel = QUERY_STATUS_LABEL[query.status as QueryStatus] ?? query.status;

  return (
    <section aria-label="Query overview" className="rounded-lg border border-border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <h1 className="font-display text-xl font-semibold tracking-tight">
          <span className="font-mono tabular-nums text-primary">{query.queryCode}</span>
        </h1>
        <dl className="flex flex-1 flex-wrap items-start gap-x-8 gap-y-4">
          <Field label="Incoterms">{query.incoterms ?? "—"}</Field>
          <Field label="Totals">
            <div>{totals.pkg} pkg · {totals.cbm} CBM · {totals.gross} kg</div>
          </Field>
          <Field label="Reference Tags">
            <CargoTagIcons cargo={query.cargo} />
          </Field>
        </dl>
        <Badge variant={queryStatusVariant(query.status)}>{statusLabel}</Badge>
      </div>
    </section>
  );
}
