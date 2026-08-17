import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AwardDecisionDto,
  RejectInput,
  RequestRequoteInput,
  SendForApprovalInput,
  ShortlistInput,
} from "@svyft/shared";
import { postJson, putJson } from "@/lib/api";

/**
 * Maker-half mutations for the Compare Quotes screen (S5.6 Task 4 — design §9 steps 1+3 and
 * §10.1 negotiation). Each just re-invalidates the read model it changed; none of the resolved
 * values are consumed directly by the UI (`MakerPanel` relies on the refetched `ComparisonDto`
 * for its next render, matching the T2/T3 hooks' own invalidate-only convention in
 * `useComparison.ts`/`useRfq.ts`).
 */
export function useShortlist(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ShortlistInput) =>
      putJson<AwardDecisionDto>(`/api/queries/${queryId}/legs/${legId}/shortlist`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comparison", queryId] }),
  });
}

// sendForApproval also invalidates `["query", queryId]`: moving a leg's decision to
// PENDING_APPROVAL is a query-level workflow milestone (the checker step gating QUOTING_CLIENT),
// so anything reading `useQueryDetail` (StageRail, the header) should re-derive alongside the
// comparison read model rather than only refreshing on next navigation.
export function useSendForApproval(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SendForApprovalInput) =>
      postJson<AwardDecisionDto>(`/api/queries/${queryId}/legs/${legId}/send-for-approval`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comparison", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
    },
  });
}

export function useRequestRequote(queryId: string, legId: string, quoteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RequestRequoteInput) =>
      postJson(`/api/queries/${queryId}/legs/${legId}/quotes/${quoteId}/request-requote`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comparison", queryId] }),
  });
}

// ── Checker-half mutations (S5.6 Task 5, design §9 steps 2+4) ──────────────────────────────────
// approve/reject/generate all move query-level workflow state (a leg's decision leaving
// PENDING_APPROVAL, or the query rolling to QUOTING_CLIENT) — same both-keys invalidation as
// `useSendForApproval` above, not just `useShortlist`'s comparison-only invalidate.

export function useApprove(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<AwardDecisionDto>(`/api/queries/${queryId}/legs/${legId}/approve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comparison", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
    },
  });
}

export function useReject(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RejectInput) =>
      postJson<AwardDecisionDto>(`/api/queries/${queryId}/legs/${legId}/reject`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comparison", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
    },
  });
}

// No :legId — query-scoped, the terminal "freeze the award + roll to QUOTING_CLIENT" action
// (design §16 O4: Manager+ gated on the controller, deliberately NO four-eyes here).
export function useGenerateClientQuote(queryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postJson(`/api/queries/${queryId}/generate-client-quote`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comparison", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
    },
  });
}

// S5.6 Task 6 — the reverse of generate: unfreeze the award and go back to a live comparison.
// Query-scoped like generate, no body, Executive+ (award.controller.ts's `reopenComparison` has
// no `@Roles`, same auth-only convention as shortlist/send-for-approval — reopening just undoes
// the freeze, it isn't itself a fresh checker-level decision). Same both-keys invalidation as
// generate/approve/reject: reopening flips `query.status` back off QUOTING_CLIENT, so `["query",
// queryId]` (StageRail/header) needs to re-derive alongside the comparison read model.
export function useReopenComparison(queryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postJson(`/api/queries/${queryId}/reopen-comparison`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comparison", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
    },
  });
}
