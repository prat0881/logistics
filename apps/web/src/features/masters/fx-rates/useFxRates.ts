import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FxRateCreateInput, FxRateDto } from "@svyft/shared";
import { fetchJson, postJson } from "@/lib/api";

export function useFxRatesList() {
  return useQuery({
    queryKey: ["fx-rates"],
    queryFn: () => fetchJson<FxRateDto[]>("/api/fx-rates"),
  });
}

export function useCreateFxRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FxRateCreateInput) => postJson<FxRateDto>("/api/fx-rates", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fx-rates"] }),
  });
}
