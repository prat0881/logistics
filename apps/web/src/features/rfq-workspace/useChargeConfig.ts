import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChargeLineDefinitionDto } from "@svyft/shared";
import { fetchJson, patchJson } from "@/lib/api";

export function useChargeCatalogue() {
  return useQuery({
    queryKey: ["charge-catalogue"],
    queryFn: () => fetchJson<ChargeLineDefinitionDto[]>("/api/charge-line-definitions"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSetChargeSelection(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chargeLineDefinitionIds: string[]) =>
      patchJson(`/api/queries/${queryId}/legs/${legId}`, { chargeLineDefinitionIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["query", queryId] }),
  });
}

export function useSetWarehouseHandling(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (warehouseHandlingIncluded: boolean) =>
      patchJson(`/api/queries/${queryId}/legs/${legId}`, { warehouseHandlingIncluded }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["query", queryId] }),
  });
}
