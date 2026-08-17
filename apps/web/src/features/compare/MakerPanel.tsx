import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { LegComparisonDto, OfferDto } from "@svyft/shared";
import { shortlistSchema } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { offerKey, STALE_OFFER_LABEL } from "./ComparisonGrid";
import { fmtUsd } from "./money";
import { useSendForApproval, useShortlist } from "./useAwardActions";
import { NegotiateDialog } from "./NegotiateDialog";
import { errorMessage } from "./errorMessage";

/** The offer this leg's decision actually has PERSISTED, keyed the same way the grid/radio key
 *  their columns — `undefined` when no shortlist has ever been saved. This is what
 *  `POST /send-for-approval` would submit (`award.service.ts` re-reads the row and never looks at
 *  anything the client sends), so it's the only safe thing to compare a candidate pick against. */
function savedShortlistKey(leg: LegComparisonDto): string | undefined {
  const dec = leg.decision;
  if (!dec?.shortlistedQuoteId) return undefined;
  return offerKey(dec.shortlistedQuoteId, dec.shortlistedVariant);
}

export interface MakerPanelProps {
  queryId: string;
  leg: LegComparisonDto;
  /** The offer currently selected for shortlisting, keyed via `offerKey` — `undefined` means
   *  "nothing explicitly picked yet" (render falls back to `defaultShortlistKey`). Lifted to
   *  `CompareLegPanel` so a click on a `ComparisonGrid` column header and a click on this panel's
   *  own radio update the SAME piece of state — see that file's doc comment for why this isn't
   *  two independently-owned copies. */
  shortlistKey: string | undefined;
  onShortlistKeyChange: (key: string) => void;
}

/**
 * The leg's current decision/recommendation resolved to a starting radio pick — decision first
 * (an existing shortlist always wins), else the engine's recommendation, and only when that key
 * still names a real PRICED offer on the leg (mirrors `RecommendationBanner`'s own defensive
 * `.find()`: a stale/renamed reference degrades to "nothing pre-selected", never a crash).
 * Exported so `CompareLegPanel` doesn't need its own copy of this lookup when deciding whether a
 * grid click actually changed anything.
 */
export function defaultShortlistKey(leg: LegComparisonDto): string | undefined {
  const priced = leg.offers.filter((o) => o.priced);
  const exists = (quoteId: string, variant: OfferDto["variant"]) =>
    priced.some((o) => o.quoteId === quoteId && o.variant === variant);

  const dec = leg.decision;
  if (dec?.shortlistedQuoteId && exists(dec.shortlistedQuoteId, dec.shortlistedVariant)) {
    return offerKey(dec.shortlistedQuoteId, dec.shortlistedVariant);
  }
  const rec = leg.recommendation;
  if (rec && exists(rec.quoteId, rec.variant)) {
    return offerKey(rec.quoteId, rec.variant);
  }
  return undefined;
}

/**
 * MakerPanel — the Executive's award actions for one leg (S5.6 Task 4, design §9 steps 1+3 and
 * §10.1): pick a shortlist offer (with an override reason when it isn't the recommendation),
 * send the leg for approval (with the A9 in-flight-re-quote confirm), and negotiate a re-quote
 * per forwarder. Renders inside `CompareLegPanel`, below the read-only grid/detail — this
 * component never fetches the comparison itself, it only mutates and lets its callers'
 * `["comparison", queryId]` invalidation (in `useAwardActions.ts`) pull the fresh read model back
 * down through `leg`.
 */
export function MakerPanel({ queryId, leg, shortlistKey, onShortlistKeyChange }: MakerPanelProps) {
  const pricedOffers = leg.offers.filter((o) => o.priced);
  const effectiveKey = shortlistKey ?? defaultShortlistKey(leg);
  const selectedOffer = pricedOffers.find((o) => offerKey(o.quoteId, o.variant) === effectiveKey);
  const recommendedKey = leg.recommendation
    ? offerKey(leg.recommendation.quoteId, leg.recommendation.variant)
    : undefined;
  const overrideRequired = effectiveKey != null && effectiveKey !== recommendedKey;

  // A re-shortlist attempt once the decision has moved past DRAFT 409s server-side
  // (award.service.ts's `shortlist` guard) — locking the form here avoids a guaranteed round trip
  // just to learn that. Enumerated rather than `!== "DRAFT"` because `REJECTED` is never persisted:
  // `reject()` writes DRAFT + `rejectionReason` in a single update (award.service.ts:319-331,
  // design §9.5 "REJECTED -> back to DRAFT"), so a rejected leg is an editable DRAFT — see
  // `rejectionReason` below.
  const status = leg.decision?.status;
  const locked = status === "PENDING_APPROVAL" || status === "APPROVED";
  // A rejected leg comes back as DRAFT carrying the checker's reason. Without this the maker's
  // only clue is the timeline at the very bottom of the panel body (final review I2).
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
      <ShortlistSection
        queryId={queryId}
        leg={leg}
        pricedOffers={pricedOffers}
        effectiveKey={effectiveKey}
        selectedOffer={selectedOffer}
        overrideRequired={overrideRequired}
        locked={locked}
        onPick={onShortlistKeyChange}
      />
      <SendForApprovalSection queryId={queryId} leg={leg} effectiveKey={effectiveKey} />
      <NegotiateSection queryId={queryId} leg={leg} pricedOffers={pricedOffers} />
    </div>
  );
}

interface ShortlistSectionProps {
  queryId: string;
  leg: LegComparisonDto;
  pricedOffers: OfferDto[];
  effectiveKey: string | undefined;
  selectedOffer: OfferDto | undefined;
  overrideRequired: boolean;
  locked: boolean;
  onPick: (key: string) => void;
}

function ShortlistSection({
  queryId,
  leg,
  pricedOffers,
  effectiveKey,
  selectedOffer,
  overrideRequired,
  locked,
  onPick,
}: ShortlistSectionProps) {
  const shortlist = useShortlist(queryId, leg.legId);
  const form = useForm<{ overrideReason?: string }>({
    // `shortlistSchema`'s `overrideReason` is `.trim().min(1).max(2000).optional()` — `.optional()`
    // only accepts `undefined`, NOT an empty string, so the default (and any cleared textarea)
    // must resolve to `undefined`, never `""`, or zodResolver silently blocks submission with no
    // visible error whenever the field is untouched (task-4 review Fix #3 caught this: the
    // equals-recommendation case never renders the field at all, so it's always "untouched").
    resolver: zodResolver(shortlistSchema.pick({ overrideReason: true })),
    defaultValues: { overrideReason: leg.decision?.overrideReason ?? undefined },
  });
  const reasonValue = form.watch("overrideReason");
  const missingReason = overrideRequired && !reasonValue?.trim();
  const overrideId = `override-reason-${leg.legId}`;

  // `.mutate()`, not `.mutateAsync()` — nothing here needs to run AFTER the request settles (the
  // hook's own `onSuccess` handles invalidation, `shortlist.isError` drives the inline message
  // below), and `mutateAsync`'s rejected promise would otherwise go uncaught on a 4xx/409. The
  // `isPending` guard is redundant with the submit button's own `disabled` below in the normal
  // case (a native disabled button never dispatches a click) — kept anyway as a cheap,
  // self-contained belt-and-suspenders against a double-fire (task-4 review Fix #2).
  function onSubmit(values: { overrideReason?: string }) {
    if (!selectedOffer || shortlist.isPending) return;
    const reason = values.overrideReason?.trim();
    shortlist.mutate({
      quoteId: selectedOffer.quoteId,
      variant: selectedOffer.variant,
      overrideReason: overrideRequired ? reason : undefined,
    });
  }

  if (pricedOffers.length === 0) {
    return <p className="text-sm text-muted-foreground">No priced offers yet to shortlist.</p>;
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Shortlist an offer
      </h3>

      <RadioGroup
        name={`shortlist-${leg.legId}`}
        value={effectiveKey}
        onValueChange={onPick}
        aria-label="Shortlist an offer"
      >
        {pricedOffers.map((o) => {
          const key = offerKey(o.quoteId, o.variant);
          const id = `shortlist-${key}`;
          // A REQUOTED offer is still shortlistable (the server's A1 guard checks `priced` only,
          // award.service.ts:91-96) but its price is stale — the engine already drops it from the
          // ranking (comparison.service.ts) and the grid badges it. Same wording as the grid's
          // badge, from the one shared constant, so the maker can see what they are picking
          // without cross-referencing the table (final review M2 + T3 #4).
          const stale = o.quoteStatus === "REQUOTED" ? ` — ${STALE_OFFER_LABEL}` : "";
          const label = o.variant
            ? `${o.freightForwarderName} — ${o.variantLabel} — ${fmtUsd(o.usdTotal)}${stale}`
            : `${o.freightForwarderName} — ${fmtUsd(o.usdTotal)}${stale}`;
          return (
            <label
              key={key}
              htmlFor={id}
              data-testid={`shortlist-option-${key}`}
              className="flex items-center gap-2 text-sm"
            >
              <RadioGroupItem id={id} value={key} disabled={locked} />
              <span>{label}</span>
            </label>
          );
        })}
      </RadioGroup>

      {/* Two genuinely different dead-ends, so two messages (final review I1). PENDING_APPROVAL is
          recoverable: a checker's Reject writes the decision back to DRAFT and clears
          `sentByUserId`, re-enabling this form. APPROVED is NOT — `reject` 409s on anything that
          isn't PENDING_APPROVAL (`requireDecidable`) and Reopen only clears the query's award
          snapshot, deliberately leaving every leg APPROVED (`reopenComparison`). Telling the user
          to "reject or reopen" there pointed at two impossible actions. */}
      {leg.decision?.status === "PENDING_APPROVAL" && (
        <p className="text-sm text-muted-foreground">
          Locked while this leg is pending approval — a checker has to reject it (which returns it
          to draft) before the shortlist can change.
        </p>
      )}
      {leg.decision?.status === "APPROVED" && (
        <p className="text-sm text-muted-foreground">
          This leg is approved — its shortlist is final here. Revising the award needs a change
          request or a fresh negotiation with the forwarder.
        </p>
      )}

      {overrideRequired && (
        <div className="space-y-1">
          <Label htmlFor={overrideId}>Override reason</Label>
          <Textarea
            id={overrideId}
            disabled={locked}
            {...form.register("overrideReason", {
              // A cleared textarea reads back "" from the DOM, which the same `.optional()`
              // mismatch above would reject — coerce back to `undefined` (mirrors
              // `FxRatesPage.tsx`'s `note` field).
              setValueAs: (v: string) => (v === "" ? undefined : v),
            })}
          />
          <p className="text-xs text-muted-foreground">
            Required — this pick differs from the recommended offer.
          </p>
          {form.formState.errors.overrideReason && (
            <p role="alert" className="text-sm text-destructive">
              {form.formState.errors.overrideReason.message}
            </p>
          )}
        </div>
      )}

      {shortlist.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(shortlist.error, "Failed to shortlist this offer.")}
        </p>
      )}

      <Button type="submit" disabled={locked || !effectiveKey || missingReason || shortlist.isPending}>
        {shortlist.isPending ? "Saving…" : "Shortlist"}
      </Button>
    </form>
  );
}

function SendForApprovalSection({
  queryId,
  leg,
  effectiveKey,
}: {
  queryId: string;
  leg: LegComparisonDto;
  /** The maker's CURRENT candidate pick (the radio / last-clicked grid column). Threaded in so
   *  this section can refuse to send while it disagrees with what's actually persisted — see
   *  `unsavedPick` below. */
  effectiveKey: string | undefined;
}) {
  const sendForApproval = useSendForApproval(queryId, leg.legId);
  const [proceed, setProceed] = useState(false);
  const [proceedReason, setProceedReason] = useState("");

  const alreadySent = leg.decision?.status === "PENDING_APPROVAL";
  const blockedByReQuote = leg.awaitingReQuote && !alreadySent && (!proceed || !proceedReason.trim());
  const reasonId = `proceed-reason-${leg.legId}`;

  // The send endpoint carries NO offer identity — `award.service.ts`'s `sendForApproval` re-reads
  // `legAwardDecision.shortlistedQuoteId` and sends THAT. Meanwhile a click on any grid column
  // header moves the maker's pick (`CompareLegPanel.handleSelectOffer`), so merely INSPECTING a
  // rival offer's charge breakdown re-points the radio without touching the saved decision. Sending
  // in that state silently submits the previously-saved offer under a UI showing a different one
  // (final review C1) — or, with nothing saved at all, guarantees a 400. Both keys come from the
  // same `offerKey` helper the grid columns use, so the comparison is apples-to-apples.
  // `savedKey == null` is spelled out rather than left to the `!==` (which would call
  // "nothing saved" equal to "nothing picked" on a leg with no priced offers at all).
  const savedKey = savedShortlistKey(leg);
  const unsavedPick = !alreadySent && (savedKey == null || savedKey !== effectiveKey);

  // `.mutate()`, same reasoning as ShortlistSection.onSubmit above — the 409/400 path (A2/A3/A9
  // guards in award.service.ts) is surfaced via `sendForApproval.isError`, not a caught rejection.
  // `disabled` below already covers `isPending` (a fast double-click can't reach a disabled native
  // button), but `alreadySent` only flips once the post-send refetch lands — this guard closes
  // that window at the handler level too, so a second invocation can never fire a second POST
  // regardless of DOM/render timing (task-4 review Fix #2).
  function onSend() {
    if (sendForApproval.isPending || unsavedPick) return;
    if (leg.awaitingReQuote) {
      sendForApproval.mutate({ proceedWithoutWaiting: true, proceedReason: proceedReason.trim() });
    } else {
      sendForApproval.mutate({});
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Send for approval
      </h3>

      {leg.awaitingReQuote && !alreadySent && (
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
              <Label htmlFor={reasonId}>Reason</Label>
              <Textarea
                id={reasonId}
                value={proceedReason}
                onChange={(e) => setProceedReason(e.target.value)}
              />
            </div>
          )}
        </div>
      )}

      {unsavedPick && (
        <p data-testid="unsaved-pick-note" className="text-sm text-muted-foreground">
          {savedKey == null
            ? "Save your shortlist first — press Shortlist above before sending this leg for approval."
            : "Save your shortlist first — the offer selected above is not the one saved on this leg, and Send would submit the saved one."}
        </p>
      )}

      {sendForApproval.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(sendForApproval.error, "Failed to send this leg for approval.")}
        </p>
      )}

      <Button
        type="button"
        onClick={onSend}
        disabled={alreadySent || sendForApproval.isPending || blockedByReQuote || unsavedPick}
      >
        {alreadySent ? "Sent for approval" : sendForApproval.isPending ? "Sending…" : "Send for approval"}
      </Button>
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
    <div className="space-y-3 border-t border-border pt-4">
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
