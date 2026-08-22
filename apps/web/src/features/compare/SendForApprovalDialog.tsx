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
import { buildComparisonRowModel, STALE_OFFER_LABEL } from "./comparisonRowModel";
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
 * it anyway. A stale (`REQUOTED`) offer stays selectable, carrying the same
 * `STALE_OFFER_LABEL` warning the grid badges it with. The A9 in-flight-re-quote block is
 * unchanged from `ShortlistDialog`.
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
  const groups = model.groups
    .map((g) => ({ ...g, cells: g.cells.filter((c) => c.offer.priced) }))
    .filter((g) => g.cells.length > 0);

  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const selectedCell = model.cells.find((c) => c.key === selectedKey);
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
                  return (
                    <div
                      key={cell.key}
                      data-testid={`send-option-${cell.key}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
                    >
                      <div className="flex items-center gap-2">
                        <RadioGroupItem id={optionId} value={cell.key} />
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
                          {cell.stale && (
                            <Badge variant="warning" className="whitespace-nowrap">
                              {STALE_OFFER_LABEL}
                            </Badge>
                          )}
                        </Label>
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
            <Label htmlFor={overrideId}>{overrideRequired ? "Override reason" : "Reason (optional)"}</Label>
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
