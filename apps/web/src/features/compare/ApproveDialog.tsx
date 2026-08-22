import type { LegComparisonDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { offerKey } from "./comparisonRowModel";
import { useApprove } from "./useAwardActions";
import { errorMessage } from "./errorMessage";

export interface ApproveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryId: string;
  leg: LegComparisonDto;
}

/**
 * ApproveDialog — the checker's confirmation before approving a leg's shortlisted offer (S5.9.1
 * Task 2, product item 3: "confirmation box appear to check with message as Are you sure to
 * approve with Vendor name with 'Ok' and 'Cancel' button"). Opening this dialog never fires
 * `useApprove` — only OK does, and only once — mirroring `SendForApprovalDialog`'s
 * open-does-not-submit contract.
 *
 * **Naming the forwarder.** The confirmed offer is resolved by matching
 * `decision.shortlistedQuoteId`/`shortlistedVariant` against `leg.offers` via the SAME `offerKey`
 * identity the grid, `ChargeBreakdownDialog` and `SendForApprovalDialog` already key their own
 * cells by — one function, so "which offer is this" can't disagree between screens. If the
 * shortlisted offer can't be found in the current read model (a stale/partial fetch, or a decision
 * whose named offer has since dropped out of `leg.offers`), the dialog says so plainly and disables
 * OK rather than approving something it cannot name — this task's own explicit requirement, not an
 * edge case to special-case away.
 *
 * `CompareLegPanel`'s action bar is the only place this is reachable from, and only once four-eyes
 * (`decision.sentByUserId === user.id`) has already cleared the Approve button enabled — so this
 * dialog itself does not re-check `isSelf`; the server's independent 403 `SELF_APPROVAL` guard is
 * still the ultimate authority, surfaced inline below like every other mutation error on this
 * screen.
 */
export function ApproveDialog({ open, onOpenChange, queryId, leg }: ApproveDialogProps) {
  const approve = useApprove(queryId, leg.legId);
  const pending = approve.isPending;

  const decision = leg.decision;
  const shortlistedKey =
    decision?.shortlistedQuoteId != null
      ? offerKey(decision.shortlistedQuoteId, decision.shortlistedVariant)
      : undefined;
  const shortlisted =
    shortlistedKey != null
      ? leg.offers.find((o) => offerKey(o.quoteId, o.variant) === shortlistedKey)
      : undefined;

  // Radix funnels Escape / overlay click / the corner X through here too — blocked mid-flight so a
  // half-finished approval can't lose its own error message (same guard as `SendForApprovalDialog`).
  function handleOpenChange(next: boolean) {
    if (!next && pending) return;
    onOpenChange(next);
  }

  function handleApprove() {
    if (pending || !shortlisted) return;
    approve.mutate(undefined, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve {leg.legCode}?</DialogTitle>
          <DialogDescription>
            {shortlisted ? (
              <>
                Are you sure you want to approve{" "}
                <strong className="font-semibold text-foreground">
                  {shortlisted.freightForwarderName} — {shortlisted.variantLabel}
                </strong>{" "}
                for {leg.legCode}?
              </>
            ) : (
              "The shortlisted offer could not be identified from the current comparison — refresh and try again."
            )}
          </DialogDescription>
        </DialogHeader>

        {approve.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(approve.error, "Failed to approve this leg.")}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={pending || !shortlisted} onClick={handleApprove}>
            {pending ? "Approving…" : "OK"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
