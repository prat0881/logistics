import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryDetail, QuerySaveInput } from "@svyft/shared";
import { fetchJson, postJson, patchJson } from "@/lib/api";

export function useQueryDetail(id?: string) {
  return useQuery({
    queryKey: ["query", id],
    queryFn: () => fetchJson<QueryDetail>(`/api/queries/${id}`),
    enabled: !!id,
  });
}

export function useSaveQuery() {
  const qc = useQueryClient();
  return {
    create: async (input: QuerySaveInput) => {
      const d = await postJson<QueryDetail>("/api/queries", input);
      qc.setQueryData(["query", d.id], d);
      qc.invalidateQueries({ queryKey: ["queries"] });
      return d;
    },
    patch: async (id: string, input: QuerySaveInput) => {
      const d = await patchJson<QueryDetail>(`/api/queries/${id}`, input);
      qc.setQueryData(["query", id], d);
      qc.invalidateQueries({ queryKey: ["queries"] });
      return d;
    },
  };
}

export function useCreateQuery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      postJson<{ id: string; status: string }>(`/api/queries/${id}/create`),
    onSuccess: (_r, id) => qc.invalidateQueries({ queryKey: ["query", id] }),
  });
}
