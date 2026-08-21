import type { LegComparisonDto } from "@svyft/shared";

export interface MakerPanelProps {
  leg: LegComparisonDto;
}

/**
 * MakerPanel — what is left of the Executive's per-leg award panel after S5.7 T4.
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
 * What deliberately stayed:
 *   - the `DRAFT` + `rejectionReason` alert — a rejected leg comes back as DRAFT carrying the
 *     checker's reason, and without this the maker's only clue is the timeline at the very bottom
 *     of the panel (final review I2);
 *   - both locked-state messages, `PENDING_APPROVAL` vs `APPROVED`, which are genuinely different
 *     dead-ends (final review I1) — see below;
 *   - the per-forwarder Negotiate buttons are GONE — S5.7 T5 moved negotiation to one leg-level
 *     "Negotiate…" button + multi-forwarder dialog, wired in `CompareLegPanel` itself (it already
 *     owns the leg's decision status the button disables on, and it sits above both MakerPanel and
 *     CheckerPanel rather than belonging to either).
 */
export function MakerPanel({ leg }: MakerPanelProps) {
  const status = leg.decision?.status;
  // A rejected leg comes back as DRAFT carrying the checker's reason. `REJECTED` is never persisted:
  // `reject()` writes DRAFT + `rejectionReason` in a single update (award.service.ts:319-331,
  // design §9.5 "REJECTED -> back to DRAFT"), so a rejected leg is an editable DRAFT.
  const returnedReason = status === "DRAFT" ? leg.decision?.rejectionReason : null;
  const isLocked = status === "PENDING_APPROVAL" || status === "APPROVED";

  // Plain DRAFT, not locked, no rejection reason — every leg's default state — leaves nothing
  // below for this panel to show. Render nothing rather than an empty bordered card (visual-
  // acceptance fix, S5.7).
  if (!returnedReason && !isLocked) {
    return null;
  }

  return (
    <div data-testid="maker-panel" className="space-y-5 rounded-lg border border-border bg-card p-4">
      {returnedReason && (
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
      )}

      {/* Two genuinely different dead-ends, so two messages (final review I1). PENDING_APPROVAL is
          recoverable: a checker's Reject writes the decision back to DRAFT and clears
          `sentByUserId`, restoring the grid's Select affordance. APPROVED is NOT — `reject` 409s on
          anything that isn't PENDING_APPROVAL (`requireDecidable`) and Reopen only clears the
          query's award snapshot, deliberately leaving every leg APPROVED (`reopenComparison`).
          Telling the user to "reject or reopen" there pointed at two impossible actions. */}
      {status === "PENDING_APPROVAL" && (
        <p className="text-sm text-muted-foreground">
          Locked while this leg is pending approval — a checker has to reject it (which returns it
          to draft) before the shortlist can change.
        </p>
      )}
      {status === "APPROVED" && (
        <p className="text-sm text-muted-foreground">
          This leg is approved — its shortlist is final here. Revising the award needs a change
          request or a fresh negotiation with the forwarder.
        </p>
      )}
    </div>
  );
}
