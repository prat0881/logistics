import { useState } from "react";
import { useParams } from "react-router-dom";
import { Role } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { useQueryDetail } from "@/features/query-wizard/useQueryDetail";
import { StageRail, isRfqStageEnabled, isQuotesStageEnabled } from "@/features/rfq-workspace/StageRail";
import { QueryOverviewHeader } from "@/features/rfq-workspace/QueryOverviewHeader";
import { RouteDiagram } from "@/features/query-wizard/steps/legs/RouteDiagram";
import { useComparison } from "./useComparison";
import { CompareLegPanel } from "./CompareLegPanel";
import { GenerateGate } from "./GenerateGate";
import { QuotingClientPanel } from "./QuotingClientPanel";

/**
 * CompareQuotesPage — the Compare Quotes screen (`/queries/:id/compare`, S5.6 §12). Reuses the
 * Stage-4 executive shell: `StageRail` (active="quotes") + `QueryOverviewHeader` + `RouteDiagram`
 * + a controlled single-open leg accordion, exactly like `rfq-workspace`'s `QueryWorkspaceHub` +
 * `RfqWorkspace` pairing — folded into one component here since this page has no distribution
 * sub-flow of its own (yet). `CompareLegPanel` bodies are placeholders; Task 3 fills them with the
 * (FF × variant) comparison grid.
 */
export function CompareQuotesPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canCheck = user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER;
  const query = useQueryDetail(id);
  const comparison = useComparison(id);
  const [openLegId, setOpenLegId] = useState<string | null>(null);

  if (!id) return <p role="alert" className="text-sm text-destructive">Missing query id.</p>;
  if (query.isLoading || comparison.isLoading)
    return <p className="text-sm text-muted-foreground">Loading comparison…</p>;
  if (query.isError || !query.data)
    return <p role="alert" className="text-sm text-destructive">Failed to load the query.</p>;
  if (comparison.isError || !comparison.data)
    return <p role="alert" className="text-sm text-destructive">Failed to load the comparison.</p>;

  const q = query.data;
  const legs = comparison.data.legs;
  const statusByLegId = new Map(q.legs.map((l) => [l.id, l.status]));
  // S5.6 Task 6, ambiguity resolution #1 — snapshot-presence IS the QUOTING_CLIENT signal
  // (`query-status.projector.ts` derives `query.status` off this same column). Computed ONCE
  // here and threaded down as a single boolean, per resolution #2, rather than re-derived by
  // each child.
  const awardSnapshot = comparison.data.awardSnapshot;
  const locked = awardSnapshot != null;

  function jumpToLeg(legId: string) {
    setOpenLegId(legId);
    requestAnimationFrame(() =>
      document
        .getElementById(`legcard-${legId}`)
        ?.scrollIntoView?.({ behavior: "smooth", block: "center" }),
    );
  }

  return (
    <div className="space-y-4">
      <StageRail
        queryId={id}
        active="quotes"
        rfqEnabled={isRfqStageEnabled(q.status)}
        quotesEnabled={isQuotesStageEnabled(q.status)}
      />

      <div className="space-y-5">
        <QueryOverviewHeader query={q} />

        <section
          aria-label="Route overview"
          className="rounded-lg border border-border bg-card p-4 sm:p-6"
        >
          <h2 className="mb-3 font-display text-sm font-semibold text-muted-foreground">
            Route overview
          </h2>
          <RouteDiagram
            detail={q}
            findings={[]}
            selectedLegId={openLegId ?? undefined}
            onSelectLeg={jumpToLeg}
          />
        </section>

        <h2 className="font-display text-lg font-semibold">Compare quotes</h2>

        <div className="space-y-3">
          {legs.map((leg) => (
            <CompareLegPanel
              key={leg.legId}
              queryId={id}
              leg={leg}
              legStatus={statusByLegId.get(leg.legId)}
              open={openLegId === leg.legId}
              onToggle={() => setOpenLegId((cur) => (cur === leg.legId ? null : leg.legId))}
              locked={locked}
            />
          ))}
          {legs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No legs to compare yet — quotes will appear here once forwarders respond.
            </p>
          )}
        </div>

        {awardSnapshot ? (
          <QuotingClientPanel
            queryId={id}
            snapshot={awardSnapshot}
            legs={legs}
            fxAsOf={comparison.data.fxAsOf}
          />
        ) : (
          canCheck && <GenerateGate queryId={id} legs={legs} />
        )}
      </div>
    </div>
  );
}
