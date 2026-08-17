import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { LegComparisonDto } from "@svyft/shared";
import { shortlistSchema } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  buildComparisonRowModel,
  offerKey,
  STALE_OFFER_LABEL,
  type OfferCell,
} from "./comparisonRowModel";
import { fmtUsd } from "./money";
import { useSendForApproval, useShortlist } from "./useAwardActions";
import { errorMessage } from "./errorMessage";

export interface ShortlistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryId: string;
  leg: LegComparisonDto;
  /** The ONE offer this dialog acts on — the cell whose grid `Select` was clicked, straight out of
   *  `buildComparisonRowModel`. There is deliberately no "currently picked offer" state in here or
   *  above: see the component doc comment. */
  cell: OfferCell;
}

/**
 * ShortlistDialog — the maker's single "shortlist this offer (and optionally send it for approval)"
 * step (S5.7 T4), opened from a priced cell's `Select` button in either grid orientation.
 *
 * **Why one dialog instead of the two stacked sections it replaces.** S5.6 shipped a shortlist
 * radio group and a separate Send-for-approval box. `POST /send-for-approval` carries no offer
 * identity — `award.service.ts` re-reads `legAwardDecision.shortlistedQuoteId` and submits THAT —
 * while the radio tracked a *candidate* pick that a mere grid-header click (opening a rival's
 * charge breakdown) could move. Sending in that state silently awarded the previously-saved
 * forwarder under a UI showing a different one: the Critical the S5.6 whole-sub-build review caught,
 * patched in `354236e` by an `unsavedPick` guard that disabled Send whenever the two disagreed.
 *
 * This component removes the root cause rather than guarding it: it is handed exactly one
 * `OfferCell` and every request it issues names that cell's offer, so there is no second piece of
 * state for the persisted decision to drift from. `Save & send for approval` is therefore SEQUENTIAL
 * and fail-safe — the shortlist PUT re-points the decision at this offer first, and the send POST is
 * only fired from its `onSuccess`, so the identity-less send can never submit a stale (or absent)
 * shortlist. The `unsavedPick` guard's three regression tests are ported, not deleted: two live in
 * `ShortlistDialog.test.tsx`'s "the offer submitted is the offer whose Select was clicked" block,
 * the third (the grid→dialog seam) in `ComparisonGrid.test.tsx`.
 */
export function ShortlistDialog({ open, onOpenChange, queryId, leg, cell }: ShortlistDialogProps) {
  const shortlist = useShortlist(queryId, leg.legId);
  const sendForApproval = useSendForApproval(queryId, leg.legId);

  // Both sides of this comparison come from `offerKey` (via the row model), never hand-rolled
  // string concatenation — the same helper the grid keys its cells by, so "is this the
  // recommendation?" can't disagree with the tint the maker just looked at. `locked: false` because
  // this dialog is never reachable while the award is locked (`CompareLegPanel` withholds the
  // Select affordance entirely), and the A2 override rule is about the engine's recommendation,
  // which `locked` only SUPPRESSES for display.
  const { recommendedKey } = buildComparisonRowModel(leg, false);
  const overrideRequired = cell.key !== recommendedKey;

  // Prefill only when the leg's PERSISTED shortlist is this very offer — a saved reason belongs to
  // the offer it was written for, and keying the prefill on `offerKey` (not on
  // `decision.overrideReason` alone) keeps a rival offer's justification from being submitted for
  // this one.
  const savedKey = leg.decision?.shortlistedQuoteId
    ? offerKey(leg.decision.shortlistedQuoteId, leg.decision.shortlistedVariant)
    : undefined;
  const savedReason = savedKey === cell.key ? (leg.decision?.overrideReason ?? undefined) : undefined;

  const form = useForm<{ overrideReason?: string }>({
    // `shortlistSchema`'s `overrideReason` is `.trim().min(1).max(2000).optional()` — `.optional()`
    // accepts `undefined`, NOT "". A `""` default therefore makes zodResolver reject every submit of
    // the RECOMMENDED offer (the common path, and the one case that never renders the textarea at
    // all, so nothing on screen explains the dead button). This exact bug shipped in S5.6 Task 4;
    // `ShortlistDialog.test.tsx`'s "posts the recommended offer with the override box never touched"
    // is mutation-proved against re-introducing it.
    resolver: zodResolver(shortlistSchema.pick({ overrideReason: true })),
    defaultValues: { overrideReason: savedReason },
  });

  // A9 (design §9) — an in-flight re-quote means the recommendation deliberately excludes an offer,
  // so sending for approval needs an explicit confirm + reason. Local state, not RHF: it isn't part
  // of `shortlistSchema` and it gates only the SEND half of this dialog, never Save shortlist.
  const [proceed, setProceed] = useState(false);
  const [proceedReason, setProceedReason] = useState("");
  const [proceedError, setProceedError] = useState<string | null>(null);

  const pending = shortlist.isPending || sendForApproval.isPending;
  const overrideId = `override-reason-${leg.legId}`;
  const proceedId = `proceed-reason-${leg.legId}`;

  /**
   * `mode: "save"` stops after the shortlist PUT; `mode: "send"` chains the send POST from its
   * `onSuccess` and ONLY from there — a failed shortlist must never be followed by a send (the
   * server would otherwise submit whatever the decision still holds). Nothing is optimistic; both
   * hooks invalidate `["comparison", queryId]` (and send also `["query", queryId]`) themselves.
   */
  function run(values: { overrideReason?: string }, mode: "save" | "send") {
    if (pending) return;
    const reason = values.overrideReason?.trim();

    // `overrideReason` is `.optional()` in the schema (A2 is enforced server-side at send time), so
    // the resolver cannot express "required for a non-recommended pick" — this is the client-side
    // half, surfaced as a field error rather than a silently-disabled button.
    if (overrideRequired && !reason) {
      form.setError("overrideReason", {
        type: "manual",
        message: "A reason is required — this offer is not the recommended one.",
      });
      return;
    }

    if (mode === "send" && leg.awaitingReQuote && (!proceed || !proceedReason.trim())) {
      setProceedError(
        "Tick “Proceed without waiting” and give a reason before sending this leg for approval.",
      );
      return;
    }
    setProceedError(null);

    shortlist.mutate(
      {
        quoteId: cell.offer.quoteId,
        variant: cell.offer.variant,
        overrideReason: overrideRequired ? reason : undefined,
      },
      {
        onSuccess: () => {
          if (mode === "save") {
            onOpenChange(false);
            return;
          }
          sendForApproval.mutate(
            leg.awaitingReQuote
              ? { proceedWithoutWaiting: true, proceedReason: proceedReason.trim() }
              : {},
            { onSuccess: () => onOpenChange(false) },
          );
        },
      },
    );
  }

  // Radix funnels Escape / overlay click / the corner X through here — blocked while a request is
  // in flight so a half-finished save & send can't lose its own error message.
  function handleOpenChange(next: boolean) {
    if (!next && pending) return;
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Shortlist {cell.offer.freightForwarderName} — {cell.offer.variantLabel}
          </DialogTitle>
          <DialogDescription>
            {leg.legCode} · {leg.origin} → {leg.destination} · {fmtUsd(cell.offer.usdTotal)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* A REQUOTED offer is still shortlistable (the server's A1 guard checks `priced` only,
              award.service.ts:91-96) but its price is stale — the engine drops it from the ranking
              and the grid badges it. The S5.6 shortlist radio said so inline (final review M2);
              this is where that warning lives now that the radio is gone. */}
          {cell.stale && (
            <p className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm">
              {STALE_OFFER_LABEL} — this forwarder's price is stale until they respond.
            </p>
          )}

          {overrideRequired && (
            <div className="space-y-1">
              <Label htmlFor={overrideId}>Override reason</Label>
              <Textarea
                id={overrideId}
                {...form.register("overrideReason", {
                  // A cleared textarea reads back "" from the DOM, which the same `.optional()`
                  // mismatch above would reject — coerce back to `undefined` (mirrors
                  // `FxRatesPage.tsx`'s `note` field).
                  setValueAs: (v: string) => (v === "" ? undefined : v),
                })}
              />
              <p className="text-xs text-muted-foreground">
                Required — this offer differs from the recommended one.
              </p>
              {form.formState.errors.overrideReason && (
                <p role="alert" className="text-sm text-destructive">
                  {form.formState.errors.overrideReason.message}
                </p>
              )}
            </div>
          )}

          {leg.awaitingReQuote && (
            <div className="space-y-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm">
              <p>
                This leg has an in-flight re-quote — the recommendation excludes it until the
                forwarder responds. Confirm to send for approval anyway.
              </p>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={proceed}
                  onCheckedChange={(v) => setProceed(v === true)}
                  aria-label="Proceed without waiting"
                />
                Proceed without waiting
              </label>
              {proceed && (
                <div className="space-y-1">
                  <Label htmlFor={proceedId}>Reason</Label>
                  <Textarea
                    id={proceedId}
                    value={proceedReason}
                    onChange={(e) => setProceedReason(e.target.value)}
                  />
                </div>
              )}
              {proceedError && (
                <p role="alert" className="text-sm text-destructive">
                  {proceedError}
                </p>
              )}
            </div>
          )}

          {/* Progress lives on its own line rather than in the button labels: both buttons run the
              same shortlist PUT first, so a per-button "Saving…"/"Sending…" swap would either lie
              about which one is in flight or need a third piece of state to say. */}
          {pending && <p className="text-sm text-muted-foreground">Saving…</p>}

          {shortlist.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(shortlist.error, "Failed to shortlist this offer.")}
            </p>
          )}
          {sendForApproval.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(sendForApproval.error, "Failed to send this leg for approval.")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={form.handleSubmit((v) => run(v, "save"))}
          >
            Save shortlist
          </Button>
          <Button type="button" disabled={pending} onClick={form.handleSubmit((v) => run(v, "send"))}>
            Save &amp; send for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
