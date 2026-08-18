import { useParams } from "react-router-dom";
import { useQueryDetail } from "@/features/query-wizard/useQueryDetail";
import { StageRail, isRfqStageEnabled, isQuotesStageEnabled, isAwardStageEnabled } from "./StageRail";
import { RfqWorkspace } from "./RfqWorkspace";

export function QueryWorkspaceHub() {
  const { id } = useParams<{ id: string }>();
  const { data: query, isLoading, isError } = useQueryDetail(id);

  if (!id) return <p className="text-sm text-destructive">Missing query id.</p>;
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError || !query) return <p className="text-sm text-destructive">Failed to load the query.</p>;

  return (
    <div className="space-y-4">
      {/* 🔴 Final review CRITICAL #2 — this rail passed ONLY `rfqEnabled`, so both later steps
          rendered with `to: undefined`: from the RFQ workspace there was no way forward to Compare
          Quotes, and none at all to the S5.8 Client Quotation builder. Every consumer of
          `StageRail` must thread all three gates or the steps it doesn't pass are dead links. */}
      <StageRail
        queryId={id}
        active="rfq"
        rfqEnabled={isRfqStageEnabled(query.status)}
        quotesEnabled={isQuotesStageEnabled(query.status)}
        awardEnabled={isAwardStageEnabled(query.status)}
      />
      <RfqWorkspace queryId={id} />
    </div>
  );
}
