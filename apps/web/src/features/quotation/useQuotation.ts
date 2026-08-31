import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QuotationDto, QuotationIssue, QuotationPatch } from "@svyft/shared";
import { ApiError, fetchJson, patchJson, postJson } from "@/lib/api";

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

/**
 * `POST /api/queries/:id/quotation/issue` (S5.8 Task 6). Body is exactly `quotationIssueSchema`
 * — `recipientEmail` + optional `subject` + optional `bodyText`. As of S5.9.3 Task 1 (P1), both
 * `subject` and `bodyText` are manager-editable overrides of the server-rendered template default
 * (`QuotationDto.previewSubject`/`previewBody`); see `QuotationPreviewDialog`'s doc comment for
 * what that trade-off does and doesn't affect (the grand total stays server-priced regardless).
 *
 * Issuing moves the query to `AWAITING_CLIENT_DECISION` (Task 4), which `QueryOverviewHeader`'s
 * status pill and `StageRail`'s stage-enablement both read straight off `QueryDetail.status` — so
 * on success this invalidates BOTH `["quotation", queryId]` (T6 ambiguity resolution #4) so this
 * page's own read picks up the just-issued row (read-only from here), AND `["query", queryId]` so
 * the shell around it (header/rail) picks up the new query status too. `setQueryData` on the
 * quotation key mirrors `usePatchQuotation`'s own pattern, so the UI reflects ISSUED immediately
 * rather than waiting on the round trip the invalidate's background refetch will also do.
 *
 * 🔴 S5.9.3 final review, IMPORTANT #1 — the body now carries `expectedUpdatedAt`, the server's
 * optimistic-concurrency token (see `quotationIssueSchema`). A 409 means this browser's cached
 * quotation was repriced elsewhere while the preview was open, so the FIRST thing that has to
 * happen is getting rid of the stale cache: `onError` invalidates `["quotation", queryId]` on 409
 * specifically, which refetches the current pricing and — through `QuotationPreviewDialog`'s
 * re-seed/conflict logic — puts the correct letter in front of the manager. Without this the
 * dialog would sit on the same stale `previewBody` and re-send the same doomed `expectedUpdatedAt`
 * on every retry, turning a recoverable conflict into a dead end. Scoped to 409 because that is
 * the only status where refetching is part of the remedy; a 403/500 refetch would just be noise.
 */
export function useIssueQuotation(queryId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: QuotationIssue) =>
      postJson<QuotationDto>(`/api/queries/${queryId}/quotation/issue`, body),
    onSuccess: (data) => {
      qc.setQueryData(["quotation", queryId], data);
      qc.invalidateQueries({ queryKey: ["quotation", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        qc.invalidateQueries({ queryKey: ["quotation", queryId] });
      }
    },
  });
}

/**
 * `POST /api/queries/:id/quotation/revise` (S5.8 Task 6) — no body. Clones the latest ISSUED
 * quotation into a fresh, editable DRAFT at `version + 1` (Task 4); the query's own status is
 * untouched by revise itself, so only `["quotation", queryId]` needs invalidating.
 */
export function useReviseQuotation(queryId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<QuotationDto>(`/api/queries/${queryId}/quotation/revise`),
    onSuccess: (data) => {
      qc.setQueryData(["quotation", queryId], data);
      qc.invalidateQueries({ queryKey: ["quotation", queryId] });
    },
  });
}
