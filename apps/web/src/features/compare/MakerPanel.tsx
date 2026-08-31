import type { LegComparisonDto } from "@svyft/shared";

export interface MakerPanelProps {
  leg: LegComparisonDto;
}

/**
 * MakerPanel — what is left of the Executive's per-leg award panel after S5.7 T4 and S5.9 T10.
 *
 * S5.6 shipped this as three stacked sections: a shortlist `RadioGroup`, a separate
 * `Send for approval` box, and per-forwarder Negotiate buttons. The first two are gone — shortlist
 * and send now happen together in one dialog opened below the whole grid (`ShortlistDialog`,
 * S5.7 T4, opened from a per-offer `Select` button that lived IN the grid; retired and replaced by
 * `SendForApprovalDialog` at S5.9 T9, which lists every priced offer itself rather than acting on
 * a single grid-clicked cell — the in-grid `Select` affordance is gone too). That original merge was
 * not cosmetic: the old shortlist radio held a *candidate* pick that a grid header click could move,
 * while `POST /send-for-approval` carries no offer identity and re-reads the PERSISTED shortlist
 * server-side, so Send could silently submit a different offer than the one on screen (the S5.6
 * whole-sub-build review's Critical, patched in `354236e` by the `unsavedPick` guard that merge
 * deleted). Naming the offer directly in the one call removes the second piece of state, so the
 * guard has nothing left to guard; its regression coverage is ported (see
 * `SendForApprovalDialog.test.tsx`'s "submits the offer that is selected in the dialog" block).
 *
 * S5.9 T10 (product item 7) moved BOTH locked-state paragraphs (`PENDING_APPROVAL` vs `APPROVED`)
 * off this panel entirely and onto the leg header's decision chip as a hover tooltip
 * (`CompareLegPanel`'s `decisionBadge`/`DecisionChip`) — the PO didn't want a standing box telling
 * the maker something they can't act on. S5.9.1 (product item 4) then removed that chip entirely —
 * leg status now carries the approval-flow states itself, so the two hints simply have no home to
 * move to any more and are gone, not relocated again. What stayed here, and why:
 *   - the `DRAFT` + `rejectionReason` alert — a rejected leg comes back as DRAFT carrying the
 *     checker's reason, and without this the maker's only clue is the timeline at the very bottom
 *     of the panel (final review I2). This is the ONE thing left that this panel renders: it is the
 *     maker's only on-screen cue that rework is needed, and burying it behind a hover was the exact
 *     defect an earlier review already caught once (S5.6 final review, finding I2) — it must stay a
 *     standing, visible alert, never a tooltip. S5.9.2 Q7 (PO ruling) went further and moved
 *     `CompareLegPanel`'s render of this panel to the very TOP of the expanded leg body — above the
 *     comparison table and the action bar — because a standing alert buried below both was still
 *     found last, not first; this component itself is unchanged, only where its caller mounts it;
 *   - the per-forwarder Negotiate buttons are GONE — S5.7 T5 moved negotiation to one leg-level
 *     "Negotiate…" button + multi-forwarder dialog, wired in `CompareLegPanel` itself (it already
 *     owns the leg's decision status the button disables on, and — since S5.9.1 Task 2 — the same
 *     action bar also owns the checker's Approve/Reject, so the button belongs to the shared bar
 *     rather than to either role's own panel).
 *
 * So this panel now renders only the rejection alert, or `null`.
 */
export function MakerPanel({ leg }: MakerPanelProps) {
  const status = leg.decision?.status;
  // A rejected leg comes back as DRAFT carrying the checker's reason. `REJECTED` is never persisted:
  // `reject()` writes DRAFT + `rejectionReason` in a single update (award.service.ts:319-331,
  // design §9.5 "REJECTED -> back to DRAFT"), so a rejected leg is an editable DRAFT.
  const returnedReason = status === "DRAFT" ? leg.decision?.rejectionReason : null;

  if (!returnedReason) return null;

  return (
    <div data-testid="maker-panel" className="rounded-lg border border-border bg-card p-4">
      <div
        role="alert"
        data-testid="rejection-notice"
        className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
      >
        <p className="font-medium text-destructive">
          Returned by the checker — revise this shortlist
        </p>
        <p className="text-foreground">{returnedReason}</p>
      </div>
    </div>
  );
}
