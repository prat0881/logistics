import { useState } from "react";
import type { DistributeResult } from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { useQueryDetail } from "@/features/query-wizard/useQueryDetail";
import { Button } from "@/components/ui/button";
import { useRfqState, useDistributeAll } from "./useRfq";
import { QueryOverviewHeader } from "./QueryOverviewHeader";
import { LegPanel } from "./LegPanel";
import { RouteDiagram } from "@/features/query-wizard/steps/legs/RouteDiagram";

const SKIP_REASON_LABEL: Record<string, string> = {
  "nothing-selected": "nothing selected",
  "already-distributed": "already distributed",
};
function skipLabel(reason: string): string {
  return SKIP_REASON_LABEL[reason] ?? reason.replace(/_/g, " ").toLowerCase();
}

export function RfqWorkspace({ queryId }: { queryId: string }) {
  const query = useQueryDetail(queryId);
  const rfqState = useRfqState(queryId);
  const distributeAll = useDistributeAll(queryId);
  const [allResult, setAllResult] = useState<DistributeResult | null>(null);
  const [allError, setAllError] = useState<string | null>(null);

  if (query.isLoading || rfqState.isLoading) return <p className="text-sm text-muted-foreground">Loading workspace…</p>;
  if (query.isError || !query.data) return <p className="text-sm text-destructive">Failed to load the query.</p>;

  const q = query.data;
  const quotes = rfqState.data?.quotes ?? [];
  const referencedFfs = rfqState.data?.freightForwarders ?? [];
  const legCodeById = new Map(q.legs.map((l) => [l.id, l.legCode]));

  async function runDistributeAll() {
    setAllError(null);
    try {
      setAllResult(await distributeAll.mutateAsync({}));
    } catch (err) {
      setAllError(err instanceof ApiError ? err.message : "Distribute all failed.");
    }
  }

  return (
    <div className="space-y-5">
      <QueryOverviewHeader query={q} />

      <section aria-label="Route overview" className="rounded-lg border border-border bg-card p-4 sm:p-6">
        <h2 className="mb-3 font-display text-sm font-semibold text-muted-foreground">Route overview</h2>
        <RouteDiagram detail={q} findings={[]} />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">RFQ distribution</h2>
        <Button variant="secondary" onClick={runDistributeAll} disabled={distributeAll.isPending}>
          {distributeAll.isPending ? "Distributing…" : "Distribute All"}
        </Button>
      </div>

      {allError && <p role="alert" className="text-sm text-destructive">{allError}</p>}
      {allResult && (
        <div className="rounded-md border border-border bg-card p-3 text-sm">
          {allResult.distributedLegIds.length > 0 && (
            <p className="text-success">Distributed {allResult.distributedLegIds.length} leg(s).</p>
          )}
          {allResult.skipped.map((s) => (
            <p key={s.legId} className="text-muted-foreground">
              {legCodeById.get(s.legId) ?? s.legId}: skipped — {skipLabel(s.reason)}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {q.legs.map((leg) => (
          <LegPanel
            key={leg.id}
            queryId={queryId}
            leg={leg}
            points={q.points}
            cargo={q.cargo}
            legQuotes={quotes.filter((qt) => qt.legId === leg.id)}
            referencedFfs={referencedFfs}
          />
        ))}
        {q.legs.length === 0 && (
          <p className="text-sm text-muted-foreground">This query has no legs yet — add legs in the Create stage first.</p>
        )}
      </div>
    </div>
  );
}
