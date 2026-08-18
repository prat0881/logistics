import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QuotationDto, QuotationPatch } from "@svyft/shared";
import { fetchJson, patchJson } from "@/lib/api";

/**
 * The Client Quotation builder's read model (S5.8 Task 5). `GET .../quotation` creates the DRAFT
 * on first call and is idempotent afterwards (Task 3), so a plain re-GET is all this needs — no
 * separate "create" mutation.
 *
 * `enabled` lets the Manager+-only `QuotationPage` defer the request until the viewer's role has
 * actually resolved to ADMINISTRATOR/MANAGER, mirroring the controller's own
 * `@Roles(ADMINISTRATOR, MANAGER)` gate on both GET and PATCH (task-3 report) — an EXECUTIVE
 * viewer should never even issue this request, not just fail to render whatever comes back.
 */
export function useQuotation(queryId?: string, enabled = true) {
  return useQuery({
    queryKey: ["quotation", queryId],
    queryFn: () => fetchJson<QuotationDto>(`/api/queries/${queryId}/quotation`),
    enabled: !!queryId && enabled,
  });
}

/**
 * `PATCH .../quotation` — margin and/or overrides, both optional (Task 2's `quotationPatchSchema`).
 *
 * 🔴 `overrides`, when present in the body, REPLACES the stored map wholesale — it is never merged
 * server-side (task-5 brief; task-3 report judgment call 3). This hook does not paper over that:
 * callers are responsible for composing the FULL map they want to end up with (see
 * `QuotationPage.onCommitOverride`, which seeds from the last-known `quotation.overrides` before
 * adding/removing the edited key) before calling `.mutate({ overrides })`. Omitting the field
 * entirely (e.g. a margin-only PATCH) leaves the stored map untouched.
 */
export function usePatchQuotation(queryId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: QuotationPatch) =>
      patchJson<QuotationDto>(`/api/queries/${queryId}/quotation`, body),
    onSuccess: (data) => {
      qc.setQueryData(["quotation", queryId], data);
      qc.invalidateQueries({ queryKey: ["quotation", queryId] });
    },
  });
}
