import { useParams } from "react-router-dom";
import { useQueryDetail } from "@/features/query-wizard/useQueryDetail";
import { StageRail, isRfqStageEnabled } from "./StageRail";
import { RfqWorkspace } from "./RfqWorkspace";

export function QueryWorkspaceHub() {
  const { id } = useParams<{ id: string }>();
  const { data: query, isLoading, isError } = useQueryDetail(id);

  if (!id) return <p className="text-sm text-destructive">Missing query id.</p>;
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError || !query) return <p className="text-sm text-destructive">Failed to load the query.</p>;

  return (
    <div className="space-y-4">
      <StageRail queryId={id} active="rfq" rfqEnabled={isRfqStageEnabled(query.status)} />
      <RfqWorkspace queryId={id} />
    </div>
  );
}
