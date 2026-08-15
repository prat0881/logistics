import { useQuery } from "@tanstack/react-query";
import type { ComparisonDto } from "@svyft/shared";
import { fetchJson } from "@/lib/api";

/** The Compare Quotes read model for one query (S5.2/S5.6 — per-leg offers + maker/checker
 *  decision + timeline). Re-GET only; mutations (shortlist/approve/…) land in later tasks and
 *  invalidate this same `["comparison", queryId]` key. */
export function useComparison(queryId?: string) {
  return useQuery({
    queryKey: ["comparison", queryId],
    queryFn: () => fetchJson<ComparisonDto>(`/api/queries/${queryId}/comparison`),
    enabled: !!queryId,
  });
}
