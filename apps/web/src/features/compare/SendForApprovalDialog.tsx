import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { LegComparisonDto } from "@svyft/shared";
import { sendForApprovalSchema } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
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
  EXPIRED_OFFER_LABEL,
  STALE_OFFER_LABEL,
  type OfferCell,
} from "./comparisonRowModel";
import { useSendForApproval } from "./useAwardActions";
import { errorMessage } from "./errorMessage";
import { fmtUsd } from "./money";

export interface SendForApprovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryId: string;
  leg: LegComparisonDto;
}

/**
 * SendForApprovalDialog — the maker's single "pick one offer and send it for approval" step
 * (S5.9 Task 9), opened from the "Send for approval…" button below the whole grid rather than a
 * per-offer `Select` button inside it (that in-grid affordance — and `ShortlistDialog`, which used
 * to open from it — are retired this task).
 *
 * **Why a list, not a pre-picked cell.** Product ask: list every option with its Total (USD) so an
 * executive choosing between similarly-named forwarders isn't relying on memory of a grid they've
 * since scrolled past, and can only ever pick one. So this dialog owns its OWN selection state
 * (`selectedKey`), built fresh from `buildComparisonRowModel(leg, false).cells` on every render —
 * there is no `cell` prop, no second "candidate pick" living anywhere else that this one could
 * drift from (the exact shape the S5.6 Critical exploited: a *reading* gesture silently re-pointing
 * what a *submit* would act on). Every request this dialog issues names exactly the offer currently
 * checked in its own `RadioGroup`, in the SAME `mutate` call — Task 3 merged selection and send
 * into one endpoint, so there is no save-then-send sequence left to desynchronize either.
 *
 * `overrideRequired = selectedKey !== recommendedKey`, both derived from the SAME `offerKey` the
 * grid keys its cells by (via `buildComparisonRowModel`), so "is this the recommendation?" can't
 * disagree with the tint/star the maker just looked at. Only offers past the model's own priced
 * filter are listed — an unpriced offer has nothing to award and the server's guards would refuse
 * it anyway. The A9 in-flight-re-quote block is unchanged from `ShortlistDialog`.
 *
 * **`REQUOTED` offers are listed, DISABLED, with their reason on screen** — never hidden, and never
 * selectable (S5.9 final whole-branch review, IMPORTANT 1). This dialog originally ported
 * `ShortlistDialog`'s pre-Task-3 "stays selectable" behaviour, which the server has refused
 * unconditionally since Task 3: `award.service.ts`'s in-transaction A1 refresh requires the NAMED
 * quote to be in `SENDABLE_STATUSES` right now — `QUOTED` or, since S5.9.5 D4, `EXPIRED`
 * (CORRECTED review round 1: this used to say "`QUOTED` right now", which stopped being the rule
 * when S5.9.5 Task 2 widened the guard). `REQUOTED` is in neither, so the conclusion below is
 * unchanged: picking a re-quoted offer cost the maker a written override reason, a ticked
 * proceed-without-waiting box and a Send press to earn a 409 — *"Only a live or expired offer can
 * be sent for approval…"* — which cannot help, because refreshing leaves it `REQUOTED`.
 * Note this is a DIFFERENT rule from A9, which is about some
 * OTHER quote on the leg being re-quoted: A9 is proceedable-past with a reason, this is not
 * proceedable at all. Same shape `NegotiateDialog` uses for an ineligible forwarder in this
 * folder — disabled control, reason text beside it — so an unavailable option is always visible
 * and always explained rather than silently missing.
 *
 * **An `EXPIRED` offer is the opposite case, and Step 5b split the two apart.** Both are
 * `cell.stale` (Task 8 widened that flag to span both causes), but only `REQUOTED` is unsendable.
 * Keying the radio's `disabled` off `cell.stale` therefore refused, from the only screen that can
 * issue a send, exactly what Task 2 had just taught the server to accept — and labelled it
 * "Re-quote requested", which is false for an offer whose re-quote window closed unanswered. Both
 * the badge and the disabled-ness now read `cell.offer.quoteStatus` directly.
 *
 * **The reason field (PO ruling, review round).** Always rendered, for every selection — not only
 * when `overrideRequired`. It stays REQUIRED only off the recommendation; on the recommended path
 * it's a voluntary note the maker can choose to leave. The label/help text below it says which
 * state it's in, so the difference is visible before submit, not only enforced by it. A voluntary
 * reason reaches the wire the same as a mandatory one — `handleSend` sends `overrideReason`
 * whenever the (trimmed) field is non-empty, not only when `overrideRequired`; the server already
 * persists `input.overrideReason ?? null` unconditionally (`award.service.ts`) and only the A2
 * guard is conditional, so there is nothing here for the backend to reject either way. Because the
 * field never unmounts any more, `handleSelectOffer` resets it (value AND any manually-set error)
 * on every selection change — see that function's own doc comment for the two staleness bugs this
 * closes.
 */
export function SendForApprovalDialog({
  open,
  onOpenChange,
  queryId,
  leg,
}: SendForApprovalDialogProps) {
  const sendForApproval = useSendForApproval(queryId, leg.legId);

  // `locked: false` — this dialog is only ever reachable while the leg is still sendable
  // (`CompareLegPanel` withholds the trigger otherwise); the A2 override rule is about the live
  // engine recommendation, which `locked` only ever SUPPRESSES for display.
  const model = buildComparisonRowModel(leg, false);
  // S5.9.5 (D7) — `model.cells`/`group.cells` are now `GridCell[]` (offer cells + pending
  // forwarders, Task 8). This dialog only ever sends a real, priced OFFER for approval — a
  // pending forwarder has nothing to send — so the existing `.priced` filter below is widened
  // into a type guard that also narrows out `PendingCell`, rather than this dialog growing any
  // pending-cell UI of its own (that's the grid's job, not this one's).
  const groups = model.groups
    .map((g) => ({
      ...g,
      cells: g.cells.filter((c): c is OfferCell => c.kind === "offer" && c.offer.priced),
    }))
    .filter((g) => g.cells.length > 0);

  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const selectedCell = groups.flatMap((g) => g.cells).find((c) => c.key === selectedKey);
  const overrideRequired = selectedKey != null && selectedKey !== model.recommendedKey;

  const form = useForm<{ overrideReason?: string }>({
    // Same `.optional()` trap `ShortlistDialog` carried: `sendForApprovalSchema`'s `overrideReason`
    // is `.trim().min(1).max(2000).optional()`, which accepts `undefined` but rejects `""`. A `""`
    // default makes zodResolver reject every submit of the RECOMMENDED offer — the common path,
    // and the one case that renders no textarea at all, so nothing on screen explains the dead
    // button. Shipped once (S5.6 Task 4); kept dead by "sends the recommended offer with the
    // reason box never touched" below.
    resolver: zodResolver(sendForApprovalSchema.pick({ overrideReason: true })),
    defaultValues: { overrideReason: undefined },
  });

  // A9 (design §9) — an in-flight re-quote means the recommendation deliberately excludes an
  // offer, so sending for approval needs an explicit confirm + reason. Local state, not RHF, same
  // as `ShortlistDialog`: it isn't part of `sendForApprovalSchema`'s pick above.
  const [proceed, setProceed] = useState(false);
  const [proceedReason, setProceedReason] = useState("");
  const [proceedError, setProceedError] = useState<string | null>(null);

  const pending = sendForApproval.isPending;
  const overrideId = `send-override-reason-${leg.legId}`;
  const proceedId = `send-proceed-reason-${leg.legId}`;

  // Review round — the reason block used to unmount whenever `overrideRequired` went false, which
  // destroyed a manually-set error (`handleSend`'s "A reason is required…") along with it for free.
  // The PO ruling keeps the block permanently mounted, so nothing clears that error on its own any
  // more: pick a non-recommended offer, trip the error with an empty Send, then switch to the
  // recommendation — the label/help text correctly flip to "optional," but the red alert
  // underneath still insists a reason is required. `resetField` clears both the error AND the
  // typed value in one call. The value half closes the SAME class of bug from the other side: a
  // reason typed while one offer was selected must not silently ride along and get attached to a
  // DIFFERENT offer's submit now that the field no longer unmounts between selections.
  function handleSelectOffer(key: string) {
    setSelectedKey(key);
    form.resetField("overrideReason");
  }

  function handleSend(values: { overrideReason?: string }) {
    if (pending || !selectedCell) return;
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

    if (leg.awaitingReQuote && (!proceed || !proceedReason.trim())) {
      setProceedError(
        "Tick “Proceed without waiting” and give a reason before sending this leg for approval.",
      );
      return;
    }
    setProceedError(null);

    // One mutation call — Task 3 merged selection and send into a single endpoint, so this is the
    // only request this dialog ever issues. `overrideReason` is sent whenever the maker actually
    // TYPED one — mandatory (off-recommendation) or voluntary (on-recommendation) alike (PO
    // ruling) — not only when `overrideRequired`; gating the send on `overrideRequired` instead
    // silently dropped a voluntary reason typed on the recommended path.
    sendForApproval.mutate(
      {
        quoteId: selectedCell.offer.quoteId,
        variant: selectedCell.offer.variant,
        ...(reason ? { overrideReason: reason } : {}),
        ...(leg.awaitingReQuote
          ? { proceedWithoutWaiting: true as const, proceedReason: proceedReason.trim() }
          : {}),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  // Radix funnels Escape / overlay click / the corner X through here — blocked while a request is
  // in flight so a half-finished send can't lose its own error message.
  function handleOpenChange(next: boolean) {
    if (!next && pending) return;
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send for approval</DialogTitle>
          <DialogDescription>
            {leg.legCode} · {leg.origin} → {leg.destination}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <RadioGroup
            name={`send-for-approval-${leg.legId}`}
            value={selectedKey}
            onValueChange={handleSelectOffer}
            className="max-h-72 space-y-3 overflow-y-auto"
          >
            {groups.map((g) => (
              <div key={g.freightForwarderId} className="space-y-1.5">
                <p className="text-xs font-semibold text-foreground">{g.freightForwarderName}</p>
                {g.cells.map((cell) => {
                  const optionId = `send-option-${cell.key}`;
                  // S5.9.5 Step 5b — `cell.stale` spans BOTH stale causes since Task 8 (`REQUOTED`
                  // and `EXPIRED`), and the two must not be treated alike here: only `REQUOTED` is
                  // outside the server's `SENDABLE_STATUSES`. Keying off the offer's own status
                  // rather than off `cell.stale` is what `EXPIRED_OFFER_LABEL`'s own doc comment
                  // in `comparisonRowModel.ts` asks this call site to do.
                  const isRequoted = cell.offer.quoteStatus === "REQUOTED";
                  const isExpired = cell.offer.quoteStatus === "EXPIRED";
                  return (
                    <div
                      key={cell.key}
                      data-testid={`send-option-${cell.key}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
                    >
                      <div className="flex items-center gap-2">
                        {/* Disabled, never omitted (review IMPORTANT 1) — the server refuses a
                            REQUOTED named offer unconditionally, so letting it be picked only buys
                            the maker a 409 whose "refresh and pick again" advice can't help. An
                            EXPIRED offer is NOT in that position: S5.9.5 Task 2 put it in
                            `SENDABLE_STATUSES`, so it stays selectable (Step 5b). */}
                        <RadioGroupItem id={optionId} value={cell.key} disabled={isRequoted} />
                        <div className="space-y-0.5">
                          <Label
                            htmlFor={optionId}
                            className="flex flex-wrap items-center gap-1.5 font-normal"
                          >
                            <span>
                              {cell.offer.freightForwarderName} — {cell.offer.variantLabel}
                            </span>
                            {cell.recommended && (
                              <span
                                className="text-emerald-600"
                                title="Recommended by the comparison engine"
                              >
                                ★
                              </span>
                            )}
                            {(isRequoted || isExpired) && (
                              <Badge variant="warning" className="whitespace-nowrap">
                                {isRequoted ? STALE_OFFER_LABEL : EXPIRED_OFFER_LABEL}
                              </Badge>
                            )}
                          </Label>
                          {isRequoted && (
                            <p className="text-xs text-muted-foreground">
                              This price isn’t live while a re-quote is outstanding — it can’t be
                              sent for approval. Wait for the new quote, or pick another offer.
                            </p>
                          )}
                          {/* The expired case says what is actually true of it: the re-quote
                              window closed with no answer, so this is the last price the forwarder
                              submitted. It is sendable — deliberately, not by omission. */}
                          {isExpired && (
                            <p className="text-xs text-muted-foreground">
                              This forwarder didn’t answer the re-quote before the deadline, so this
                              is their last submitted price. You can still send it for approval —
                              doing so is a deliberate choice.
                            </p>
                          )}
                        </div>
                      </div>
                      <span className="font-mono text-sm tabular-nums">
                        {fmtUsd(cell.offer.usdTotal)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </RadioGroup>

          {/* PO ruling — always visible, for every selection, not conditionally mounted on
              `overrideRequired`. Only the REQUIREDNESS (enforced in `handleSend` above) and the
              label/help text below it change with the pick; the field itself never disappears. */}
          <div className="space-y-1">
            <Label htmlFor={overrideId}>
              {overrideRequired ? "Override reason" : "Reason (optional)"}
            </Label>
            <Textarea
              id={overrideId}
              {...form.register("overrideReason", {
                // A cleared (or never-touched) textarea reads back "" from the DOM, which the same
                // `.optional()` mismatch above would reject — coerce back to `undefined` (mirrors
                // `FxRatesPage.tsx`'s `note` field). This still applies now that the field is
                // ALWAYS mounted: the untouched, common case on the recommended path is exactly the
                // one this coercion protects.
                setValueAs: (v: string) => (v === "" ? undefined : v),
              })}
            />
            <p className="text-xs text-muted-foreground">
              {overrideRequired
                ? "Required — this offer differs from the recommended one."
                : "Optional — you may record a reason even for the recommended offer."}
            </p>
            {form.formState.errors.overrideReason && (
              <p role="alert" className="text-sm text-destructive">
                {form.formState.errors.overrideReason.message}
              </p>
            )}
          </div>

          {leg.awaitingReQuote && (
            <div className="space-y-2 text-sm">
              <p>
                This leg has an in-flight re-quote — the recommendation excludes it until the
                forwarder responds. Confirm to send for approval anyway.
              </p>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={proceed}
                  onCheckedChange={(v) => setProceed(v === true)}
                  aria-label="Proceed without waiting"
                  required
                  aria-required="true"
                />
                Proceed without waiting
              </label>
              {/* Review round (Minor) — `handleSend` below blocks on BOTH `!proceed` and
                  `!proceedReason.trim()`; the reason alone was marked required, leaving the
                  checkbox's own requirement enforced-but-invisible (exactly the shape this whole
                  change existed to remove) until Send was clicked and `proceedError` explained it.
                  This line makes that half visible too, matching the box's own `required`/
                  `aria-required` above. */}
              <p className="pl-6 text-xs text-muted-foreground">
                Required — you must confirm this before sending the leg for approval.
              </p>
              {/* PO ruling (S5.9.2 product item 9) — always rendered, not only after ticking the
                  box above, and marked required: the reason is already enforced on submit
                  (`handleSend` below), so this makes that requirement visible rather than
                  conditional — the same treatment (label + helper text stating the requirement)
                  the recommendation-override reason gets above. */}
              <div className="space-y-1">
                <Label htmlFor={proceedId}>Reason</Label>
                <Textarea
                  id={proceedId}
                  required
                  aria-required="true"
                  value={proceedReason}
                  onChange={(e) => setProceedReason(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Required — this leg has an in-flight re-quote.
                </p>
              </div>
              {proceedError && (
                <p role="alert" className="text-sm text-destructive">
                  {proceedError}
                </p>
              )}
            </div>
          )}

          {pending && <p className="text-sm text-muted-foreground">Sending…</p>}
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
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || !selectedCell}
            onClick={form.handleSubmit(handleSend)}
          >
            {pending ? "Sending…" : "Send for approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
