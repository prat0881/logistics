import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { Paginated, QueryListRow, QueryListParams } from "@svyft/shared";

function toSearch(p: QueryListParams): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p))
    if (v !== undefined && v !== "" && v !== null) sp.set(k, String(v));
  return sp.toString();
}

export function useQueries(params: QueryListParams) {
  return useQuery({
    queryKey: ["queries", params],
    queryFn: () => fetchJson<Paginated<QueryListRow>>(`/api/queries?${toSearch(params)}`),
    placeholderData: keepPreviousData,
  });
}
