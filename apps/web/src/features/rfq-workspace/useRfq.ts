import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  QueryRfqStateDto,
  FreightForwarderDto,
  DistributeInput,
  DistributeResult,
} from "@svyft/shared";
import { fetchJson, postJson, putJson } from "@/lib/api";

export function useRfqState(queryId?: string) {
  return useQuery({
    queryKey: ["rfq-state", queryId],
    queryFn: () => fetchJson<QueryRfqStateDto>(`/api/queries/${queryId}/rfq-state`),
    enabled: !!queryId,
  });
}

export function useEligibleFfs(queryId: string, legId: string, broaden: boolean, enabled = true) {
  return useQuery({
    queryKey: ["eligible-ffs", queryId, legId, broaden],
    queryFn: () =>
      fetchJson<FreightForwarderDto[]>(
        `/api/queries/${queryId}/legs/${legId}/eligible-ffs?broaden=${broaden}`,
      ),
    enabled: enabled && !!queryId && !!legId,
  });
}

export function useSetFfSelection(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ffIds: string[]) =>
      putJson<{ selected: string[] }>(`/api/queries/${queryId}/legs/${legId}/ff-selection`, { ffIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rfq-state", queryId] }),
  });
}

export function useDistributeLeg(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DistributeInput) =>
      postJson<DistributeResult>(`/api/queries/${queryId}/legs/${legId}/distribute`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rfq-state", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
      qc.invalidateQueries({ queryKey: ["eligible-ffs", queryId, legId] });
    },
  });
}

export function useDistributeAll(queryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DistributeInput) =>
      postJson<DistributeResult>(`/api/queries/${queryId}/distribute-all`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rfq-state", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
    },
  });
}
