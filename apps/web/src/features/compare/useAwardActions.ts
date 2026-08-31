import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AwardDecisionDto,
  RejectInput,
  ReopenComparisonInput,
  SendForApprovalInput,
} from "@svyft/shared";
import { postJson } from "@/lib/api";
import { errorMessage } from "./errorMessage";

/**
 * Maker-half mutations for the Compare Quotes screen (S5.6 Task 4 — design §9 steps 1+3 and
 * §10.1 negotiation). Each just re-invalidates the read model it changed; none of the resolved
 * values are consumed directly by the UI (`MakerPanel` relies on the refetched `ComparisonDto`
 * for its next render, matching the T2/T3 hooks' own invalidate-only convention in
 * `useComparison.ts`/`useRfq.ts`).
 */
// S5.9 Task 3 retired the standalone `ShortlistInput` type and its `PUT .../shortlist` route —
// shortlist + send-for-approval are now ONE call, `SendForApprovalInput`, naming the offer it acts
// on directly. `useShortlist` (which targeted the retired route) is gone as of S5.9 Task 9, along
// with `ShortlistDialog`'s two-call sequence that called it; `SendForApprovalDialog` drives this
// hook alone.
//
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

// ── S5.7 T5 — leg-level multi-forwarder negotiate ──────────────────────────────────────────────
// `useRequestRequote` (single quoteId bound at hook level, so it could never be looped over a
// selection) is gone — nothing imports it once `NegotiateDialog` moved from a per-forwarder
// button to one leg-level dialog. `RequoteTarget`/`RequoteResult` live here, next to the hook that
// produces/consumes them, and `NegotiateDialog` imports both.

/** One forwarder's re-quote request, already resolved to its (deduplicated) `quoteId` — see
 *  `NegotiateDialog`'s eligibility-building doc comment for why selection is per FORWARDER, not
 *  per offer. */
export interface RequoteTarget {
  quoteId: string;
  freightForwarderName: string;
  comment: string;
}

/** One target's outcome. `error` is only set on failure — already reduced to a display string via
 *  `errorMessage`, since each result renders straight into the dialog with no further ApiError
 *  unwrapping at the call site. */
export interface RequoteResult {
  quoteId: string;
  freightForwarderName: string;
  ok: boolean;
  error?: string;
}

/**
 * `useRequestRequoteBatch` — fires one `POST .../quotes/:quoteId/request-requote` per target,
 * SEQUENTIALLY (`for…of`, not `Promise.all`) and with NO transaction: the server has no batch
 * endpoint, so three successes followed by one failure is a real, reachable outcome, not a bug to
 * guard against. `run` therefore never throws — every target's failure is caught and folded into
 * its own `RequoteResult` — and the caller gets the full per-target list back to render, rather
 * than one combined error that would hide which forwarders actually got re-notified.
 *
 * Invalidation happens exactly ONCE, after the whole loop settles, regardless of outcome: the
 * successful calls among a partial failure already reissued that forwarder's FF-portal token and
 * reset their RFQ deadline server-side (not rolled back), so the read model needs refreshing even
 * when `run` reports failures.
 *
 * BOTH keys, like every other non-shortlist mutation in this file (final review MINOR #7). A
 * re-quote is not comparison-local: `negotiation.service.ts` fires `REOPEN_AWARD` and moves the
 * quote's status, which rolls up into the LEG's status — and `LegStatusBadge` on the leg card is
 * fed by `useQueryDetail` (`["query", queryId]`), not by the comparison read model. Invalidating
 * only `["comparison"]` left that badge stale; the batch made it worse by staleing N legs at once.
 */
export function useRequestRequoteBatch(queryId: string, legId: string) {
  const qc = useQueryClient();
  const [isPending, setIsPending] = useState(false);

  async function run(targets: RequoteTarget[]): Promise<RequoteResult[]> {
    setIsPending(true);
    const results: RequoteResult[] = [];
    try {
      for (const target of targets) {
        try {
          await postJson(
            `/api/queries/${queryId}/legs/${legId}/quotes/${target.quoteId}/request-requote`,
            { comment: target.comment },
          );
          results.push({
            quoteId: target.quoteId,
            freightForwarderName: target.freightForwarderName,
            ok: true,
          });
        } catch (error) {
          results.push({
            quoteId: target.quoteId,
            freightForwarderName: target.freightForwarderName,
            ok: false,
            error: errorMessage(error, "Failed to request a re-quote."),
          });
        }
      }
    } finally {
      setIsPending(false);
      qc.invalidateQueries({ queryKey: ["comparison", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
    }
    return results;
  }

  return { run, isPending };
}

// ── Checker-half mutations (S5.6 Task 5, design §9 steps 2+4) ──────────────────────────────────
// approve/reject/generate all move query-level workflow state (a leg's decision leaving
// PENDING_APPROVAL, or the query rolling to QUOTING_CLIENT) — same both-keys invalidation as
// `useSendForApproval` above.

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
// Query-scoped like generate. CORRECTED at S5.9.5 (design D6): this used to be described as
// "no body, Executive+ … reopening just undoes the freeze, it isn't itself a fresh checker-level
// decision". Both halves changed. `award.controller.ts`'s `reopenComparison` now carries
// `@Roles(Role.ADMINISTRATOR, Role.MANAGER)` — it supersedes an ISSUED client quotation and
// deletes a DRAFT one, which IS a checker-tier act — and validates a required `{reason}` body with
// `ZodValidationPipe(reopenComparisonSchema)`, stored on every leg's `REOPEN` audit event.
// `ReopenDialog` collects that reason. Same both-keys invalidation as generate/approve/reject:
// reopening flips `query.status` back off QUOTING_CLIENT, so `["query", queryId]` (StageRail/
// header) needs to re-derive alongside the comparison read model.
export function useReopenComparison(queryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReopenComparisonInput) =>
      postJson(`/api/queries/${queryId}/reopen-comparison`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comparison", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
    },
  });
}
