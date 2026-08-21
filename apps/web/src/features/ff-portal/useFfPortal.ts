// useFfPortal.ts — TanStack Query hooks for the FF Portal.
// Deliberately uses portalClient (not lib/api) so portal 401s never trigger the app's global logout.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FfPortalRfqDto, QuoteDraft } from "@svyft/shared";
import { portalGet, portalPatch, portalPost } from "./portalClient";

export function useFfRfq(token: string) {
  return useQuery({
    queryKey: ["ff-rfq", token],
    queryFn: () => portalGet<FfPortalRfqDto>(`/api/ff/rfq/${token}`),
    retry: false,
  });
}

export function useSaveDraft(token: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draft: QuoteDraft) => portalPatch(`/api/ff/rfq/${token}/quotes/${legId}`, draft),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ff-rfq", token] }),
  });
}

export function useSubmit(token: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    // `version` must come from the FfPortalLegDto the form is currently rendering (never cached
    // elsewhere) — it's the stale-page guard's whole point (S5.9 D10): echo back exactly what
    // this open page believes the basis is.
    mutationFn: (version: string) =>
      portalPost<{ quoteId: string; status: string }>(
        `/api/ff/rfq/${token}/quotes/${legId}/submit`,
        { version },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ff-rfq", token] }),
  });
}
