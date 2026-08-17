import { useState } from "react";
import type { LegComparisonDto, OfferDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { NegotiateDialog } from "./NegotiateDialog";

export interface MakerPanelProps {
  queryId: string;
  leg: LegComparisonDto;
}

/**
 * MakerPanel — what is left of the Executive's per-leg award panel after S5.7 T4.
 *
 * S5.6 shipped this as three stacked sections: a shortlist `RadioGroup`, a separate
 * `Send for approval` box, and per-forwarder Negotiate buttons. The first two are gone — shortlist
 * and send now happen together in `ShortlistDialog`, opened from a `Select` button on the offer
 * itself in either grid orientation. That is not a cosmetic merge: the radio held a *candidate*
 * pick that a grid header click could move, while `POST /send-for-approval` carries no offer
 * identity and re-reads the PERSISTED shortlist server-side, so Send could silently submit a
 * different offer than the one on screen (the S5.6 whole-sub-build review's Critical, patched in
 * `354236e` by the `unsavedPick` guard this task deletes). One dialog acting on one offer removes
 * the second piece of state, so the guard has nothing left to guard; its regression coverage is
 * ported (see `ShortlistDialog.tsx`'s doc comment for exactly where).
 *
 * What deliberately stayed:
 *   - the `DRAFT` + `rejectionReason` alert — a rejected leg comes back as DRAFT carrying the
 *     checker's reason, and without this the maker's only clue is the timeline at the very bottom
 *     of the panel (final review I2);
 *   - both locked-state messages, `PENDING_APPROVAL` vs `APPROVED`, which are genuinely different
 *     dead-ends (final review I1) — see below;
 *   - the per-forwarder Negotiate buttons, which S5.7 T5 moves to the leg level. Removing them here
 *     would leave no negotiate path at all in between.
 */
export function MakerPanel({ queryId, leg }: MakerPanelProps) {
  const pricedOffers = leg.offers.filter((o) => o.priced);

  const status = leg.decision?.status;
  // A rejected leg comes back as DRAFT carrying the checker's reason. `REJECTED` is never persisted:
  // `reject()` writes DRAFT + `rejectionReason` in a single update (award.service.ts:319-331,
  // design §9.5 "REJECTED -> back to DRAFT"), so a rejected leg is an editable DRAFT.
  const returnedReason = status === "DRAFT" ? leg.decision?.rejectionReason : null;

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

      <NegotiateSection queryId={queryId} leg={leg} pricedOffers={pricedOffers} />
    </div>
  );
}

function NegotiateSection({
  queryId,
  leg,
  pricedOffers,
}: {
  queryId: string;
  leg: LegComparisonDto;
  pricedOffers: OfferDto[];
}) {
  const [negotiating, setNegotiating] = useState<{
    quoteId: string;
    freightForwarderName: string;
  } | null>(null);

  // One button per forwarder, not per offer column — a Road FF pricing both Dedicated and
  // Groupage still submitted a single Quote (see `ComparisonGrid`'s own `groupByForwarder` doc
  // comment), so two variant rows would otherwise open the identical negotiation twice.
  const seen = new Set<string>();
  const negotiableGroups = pricedOffers.filter((o) => {
    if (seen.has(o.freightForwarderId)) return false;
    seen.add(o.freightForwarderId);
    return true;
  });

  if (negotiableGroups.length === 0) return null;

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Negotiate
      </h3>
      <div className="flex flex-wrap gap-2">
        {negotiableGroups.map((o) => (
          <Button
            key={o.freightForwarderId}
            type="button"
            variant="outline"
            size="sm"
            disabled={o.quoteStatus === "REQUOTED"}
            data-testid={`negotiate-${o.freightForwarderId}`}
            onClick={() =>
              setNegotiating({ quoteId: o.quoteId, freightForwarderName: o.freightForwarderName })
            }
          >
            Negotiate — {o.freightForwarderName}
          </Button>
        ))}
      </div>

      <NegotiateDialog
        open={negotiating != null}
        onOpenChange={(v) => !v && setNegotiating(null)}
        queryId={queryId}
        legId={leg.legId}
        quoteId={negotiating?.quoteId ?? ""}
        freightForwarderName={negotiating?.freightForwarderName ?? ""}
      />
    </div>
  );
}
