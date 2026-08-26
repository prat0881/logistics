import { useEffect, useState } from "react";
import { requestRequoteSchema, type LegComparisonDto, type QuoteStatus } from "@svyft/shared";
import { ForwarderStatusBadge } from "@/features/rfq-workspace/statusBadges";
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
import { useRequestRequoteBatch, type RequoteResult, type RequoteTarget } from "./useAwardActions";
import { fmtUsd } from "./money";

export interface NegotiateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryId: string;
  legId: string;
  /** The whole leg — eligibility is derived from `offers`/`pendingForwarders` fresh on every
   *  render, so a background refetch (the batch's own invalidate included) can't leave the dialog
   *  showing a stale forwarder list. */
  leg: LegComparisonDto;
}

// Read straight off the schema (`requestRequoteSchema.shape.comment` is `.trim().min(1).max(2000)`)
// rather than a hand-copied `2000` — the single-forwarder dialog this replaces enforced the WHOLE
// schema via `zodResolver`; this rewrite dropped the max-length half of that (fix round 1, MINOR
// #2), so both note paths below must fail the same way the old dialog did, not just on empty.
const NOTE_MAX_LENGTH = requestRequoteSchema.shape.comment.maxLength ?? 2000;

function noteTooLong(value: string): boolean {
  return value.trim().length > NOTE_MAX_LENGTH;
}

/** One row in the eligibility list — one per FORWARDER, never per offer. */
interface Candidate {
  freightForwarderId: string;
  freightForwarderName: string;
  /** The one Quote covering every variant this forwarder priced — `null` for a forwarder that
   *  never quoted at all (a `pendingForwarders` entry), which is therefore never selectable. */
  quoteId: string | null;
  eligible: boolean;
  /** Only set when `!eligible` — always rendered next to the (disabled) checkbox, never hidden. */
  reason?: string;
  /** The forwarder's quote status, shown as the SAME `ForwarderStatusBadge` the grid uses (design
   *  §89). For an eligible forwarder this is the status of the quote `quoteId` points at; for a
   *  `pendingForwarders` entry it's that entry's own status (`RFQ_SENT`). */
  quoteStatus: QuoteStatus;
  /** Every PRICED offer this forwarder has on the leg, in read-model order. A list, not one
   *  number, because one Quote fans out into one offer per variant — "Bridge's current price" is
   *  genuinely `Dedicated $542.17 · Groupage $361.45`, and collapsing that to a single figure would
   *  be inventing one. Empty for a forwarder that has never priced anything. `usdTotal` keeps the
   *  read model's own `number | null` — `priced` and a non-null total are separate fields on
   *  `OfferDto`, and `fmtUsd` renders the null as an em-dash rather than a fake `$0.00`. */
  prices: { variantLabel: string; usdTotal: number | null }[];
}

/**
 * Builds the dialog's eligibility list, deduplicated by `freightForwarderId`.
 *
 * One `Quote` covers ALL of a forwarder's variants on a leg (`request-requote` is keyed by
 * `quoteId`, not offer), so a Road forwarder who priced both Dedicated and Groupage shows up as
 * TWO `OfferDto` rows sharing one `quoteId` (see `ComparisonGrid`'s own `groupByForwarder` doc
 * comment for the same fact on the read side). Keying this list on the offer instead of the
 * forwarder would show that FF twice and fire two `request-requote` calls against the one quote it
 * actually has — `NegotiateDialog.test.tsx`'s "posts one request per selected forwarder" catches
 * exactly that regression (asserts 2 calls off a 4-offer/1-pending fixture, not 4 or 5).
 *
 * A forwarder is eligible when it has AT LEAST ONE offer whose `quoteStatus` is in the server's
 * `REQUOTABLE_STATUSES` — `QUOTED`, `APPROVED` or (S5.9.5 D4) `EXPIRED`. REQUOTED forwarders (an
 * offer exists, but a revised one is already pending) and `pendingForwarders` (sent the RFQ, never
 * comparably quoted) are both included, disabled, with their own reason text — never hidden.
 *
 * PENDING_APPROVAL is ALSO ineligible, with its own reason text (design decision D5, S5.9 code
 * review round 2): negotiate stays REFUSED while a leg is under review — the maker must reject
 * the leg back to QUOTED first, matching the server's own gate: the LEG-level decision guard at
 * `negotiation.service.ts:114-124`, which loads the leg's `LegAwardDecision` and 409s when it is
 * `PENDING_APPROVAL` — or, since S5.9.5 D1, `APPROVED` — BEFORE `REQUOTABLE_STATUSES` (`:126`) is
 * ever consulted. (Those citations read `:69-74` and `:76` until review round 1 of Task 10; both
 * had drifted well before that task, and the guard moved again when D1's `APPROVED` arm was added
 * to it.) That guard is NOT
 * redundant with `REQUOTABLE_STATUSES` — the latter only gates the quote NAMED in a given call,
 * so a still-QUOTED sibling quote on the same leg would sail straight past it and let a maker
 * reset a decision a checker is mid-review of on a different, already-shortlisted quote. An
 * earlier version of this function admitted PENDING_APPROVAL as eligible on the theory that it's
 * "just a QUOTED offer under review, not a different commitment" — that was wrong: the product
 * owner ruled negotiate stays refused, and admitting it client-side while the server refuses it
 * would have let the maker select an ineligible forwarder and get a 409 back.
 */
function buildCandidates(leg: LegComparisonDto): Candidate[] {
  const byForwarder = new Map<string, Candidate>();
  for (const offer of leg.offers) {
    // Mirrors negotiation.service.ts's REQUOTABLE_STATUSES exactly (S5.9.5 D4). EXPIRED is new:
    // after D4 an expired quote can still carry the forwarder's real submitted price, and
    // re-negotiating is the deliberate act that reopens their portal with a fresh deadline.
    // APPROVED stays listed because `REQUOTABLE_STATUSES` still lists it — but it is unreachable
    // from here for TWO independent reasons now, not one: D1 stops this dialog opening on an
    // approved leg at all (`CompareLegPanel`'s `negotiateDisabledReason`), and, since review round 1
    // of this sub-build, `requestRequote` itself refuses a leg whose decision is APPROVED with a
    // 409 naming Reject as the remedy. The UI and the server agree; the two lists are kept
    // readable side by side rather than trimmed. Do not "clean it up" without checking the server
    // first.
    const quotable =
      offer.quoteStatus === "QUOTED" ||
      offer.quoteStatus === "APPROVED" ||
      offer.quoteStatus === "EXPIRED";
    // Reachable only for the statuses left over once `quotable` has taken QUOTED/APPROVED/EXPIRED:
    // `COMPARABLE_STATUSES` (comparison.service.ts) admits exactly QUOTED, REQUOTED,
    // PENDING_APPROVAL, APPROVED and EXPIRED, so the two arms below cover PENDING_APPROVAL and
    // REQUOTED and nothing else. That is why the fallback may state REQUOTED's cause outright —
    // and why widening `quotable` above without revisiting it would be a bug: before S5.9.5 an
    // EXPIRED offer landed on this fallback and was told a re-quote was outstanding, when in fact
    // the re-quote had already gone unanswered.
    const ineligibleReason =
      offer.quoteStatus === "PENDING_APPROVAL"
        ? "This leg is pending approval — reject it first."
        : "Already awaiting a revised quote.";
    const existing = byForwarder.get(offer.freightForwarderId);
    if (!existing) {
      byForwarder.set(offer.freightForwarderId, {
        freightForwarderId: offer.freightForwarderId,
        freightForwarderName: offer.freightForwarderName,
        quoteId: offer.quoteId,
        eligible: quotable,
        reason: quotable ? undefined : ineligibleReason,
        quoteStatus: offer.quoteStatus,
        prices: [],
      });
    } else if (quotable && !existing.eligible) {
      // A later offer for the same forwarder turned out quotable (e.g. Dedicated is QUOTED after
      // Groupage, seen first, was REQUOTED) — the forwarder as a whole is still eligible. The badge
      // follows the quote that made it eligible, so it can't say "RFQ-Resent" next to an enabled box.
      existing.eligible = true;
      existing.quoteId = offer.quoteId;
      existing.reason = undefined;
      existing.quoteStatus = offer.quoteStatus;
    }
    // Prices accumulate across ALL of the forwarder's offers, eligible or not — the maker is
    // choosing who to renegotiate with and needs to see what each one currently charges.
    if (offer.priced) {
      byForwarder
        .get(offer.freightForwarderId)!
        .prices.push({ variantLabel: offer.variantLabel, usdTotal: offer.usdTotal });
    }
  }
  for (const pending of leg.pendingForwarders) {
    if (!byForwarder.has(pending.freightForwarderId)) {
      byForwarder.set(pending.freightForwarderId, {
        freightForwarderId: pending.freightForwarderId,
        freightForwarderName: pending.freightForwarderName,
        quoteId: null,
        eligible: false,
        reason: "Hasn't quoted yet — nothing to re-quote.",
        quoteStatus: pending.quoteStatus,
        prices: [],
      });
    }
  }
  return Array.from(byForwarder.values());
}

/**
 * NegotiateDialog — the maker's leg-level "ask selected forwarders to revise their price" action
 * (S5.7 T5, replacing S5.6's per-forwarder button + single-forwarder dialog in `MakerPanel`). One
 * `Checkbox` per eligible/ineligible forwarder (deduplicated — see `buildCandidates`), ONE shared
 * note applied to every selected forwarder (S5.9.2 product item 1 — the earlier per-forwarder
 * note toggle/boxes are gone; a maker wanting different wording for one forwarder selects just
 * that forwarder and sends alone), and a Send that fires N sequential `request-requote` calls via
 * `useRequestRequoteBatch` — see that hook's doc
 * comment for why there is no single combined success/error state.
 *
 * **Partial success is a real state, not an error path.** `run()` never throws; it always resolves
 * with one `RequoteResult` per target. This component closes ONLY when every result is `ok`
 * (ambiguity resolution #3) — on any failure it stays open, renders the full per-forwarder result
 * list (`data-result="ok"|"error"` on each row, so nothing is folded into one combined message),
 * and narrows the selection down to just the FAILED forwarders so a second Send retries only those
 * (their notes are left exactly as typed — nothing here re-collects one on retry).
 *
 * **Can't dismiss mid-flight** survives from the single-forwarder dialog this replaces: Radix
 * funnels every close attempt (Escape, overlay click, the corner X, this component's own Cancel)
 * through `onOpenChange`, gated here while `batch.isPending`. The OTHER hard-won behaviour from
 * that component — the `latestQuoteId` stale-success guard — is moot here: there is exactly one
 * dialog instance now (not one reused across forwarders), and `run()`'s result is consumed
 * synchronously off its own `await`, so there is no second in-flight call whose late resolution
 * could reach for a `quoteId` that has since moved on.
 */
export function NegotiateDialog({ open, onOpenChange, queryId, legId, leg }: NegotiateDialogProps) {
  const batch = useRequestRequoteBatch(queryId, legId);
  const candidates = buildCandidates(leg);
  const eligible = candidates.filter((c) => c.eligible);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sharedNote, setSharedNote] = useState("");
  const [results, setResults] = useState<RequoteResult[] | null>(null);

  // Reset every bit of selection/note/result state whenever the dialog re-opens — a cancelled (or
  // completed) attempt must not leak its picks into the next one (ambiguity resolution #5).
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setSharedNote("");
      setResults(null);
    }
  }, [open]);

  const allEligibleSelected = eligible.length > 0 && eligible.every((c) => selected.has(c.freightForwarderId));
  const selectedCandidates = candidates.filter((c) => c.eligible && selected.has(c.freightForwarderId));
  const n = selectedCandidates.length;

  // Same rule `requestRequoteSchema` enforces server-side — non-empty AND no more than
  // `NOTE_MAX_LENGTH`. One shared note applies to every selected forwarder (S5.9.2 product item 1
  // — an exec wanting different wording per forwarder selects one at a time instead), so there is
  // only ever one note to validate.
  const hasInvalidNote = n > 0 && (sharedNote.trim().length === 0 || sharedNote.trim().length > NOTE_MAX_LENGTH);
  const canSubmit = n > 0 && !hasInvalidNote && !batch.isPending;

  function toggleForwarder(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleSelectAll(checked: boolean) {
    setSelected(checked ? new Set(eligible.map((c) => c.freightForwarderId)) : new Set());
  }

  async function handleSend() {
    if (!canSubmit) return;
    const note = sharedNote.trim();
    const targets: RequoteTarget[] = selectedCandidates.map((c) => ({
      quoteId: c.quoteId as string,
      freightForwarderName: c.freightForwarderName,
      comment: note,
    }));
    const idByQuoteId = new Map(selectedCandidates.map((c) => [c.quoteId as string, c.freightForwarderId]));

    const outcome = await batch.run(targets);
    setResults(outcome);

    if (outcome.every((r) => r.ok)) {
      onOpenChange(false);
      return;
    }
    // Narrow the selection to just the forwarders that failed, so the notes stay filled in and a
    // second click of Send retries only those — the ones that already succeeded don't need it.
    setSelected(
      new Set(outcome.filter((r) => !r.ok).map((r) => idByQuoteId.get(r.quoteId)).filter((id): id is string => !!id)),
    );
  }

  // Same "can't dismiss mid-flight" gate the single-forwarder dialog had — see the component doc
  // comment above.
  function handleOpenChange(next: boolean) {
    if (!next && batch.isPending) return;
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Negotiate — {leg.legCode}</DialogTitle>
          <DialogDescription>
            Ask selected forwarders to revise their price. Each one sees your note and their quote
            moves to Re-quoted until they respond.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={allEligibleSelected}
              disabled={eligible.length === 0}
              onCheckedChange={(v) => toggleSelectAll(v === true)}
              aria-label="Select all"
            />
            Select all
          </label>

          <ul className="space-y-2">
            {candidates.map((c) => (
              <li key={c.freightForwarderId} className="space-y-1">
                {/* Design item 6 (§89) — "a checkbox per forwarder, showing each one's current
                    price and status". The dialog is modal, so the grid the maker was reading is
                    covered; shipping names alone made them choose who to renegotiate with blind to
                    prices (final review IMPORTANT #4). The badge is the grid's own
                    `ForwarderStatusBadge`, not a second status vocabulary. `aria-label` stays on
                    the Checkbox, so its accessible name is still just the forwarder's name. */}
                <label className="flex flex-wrap items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected.has(c.freightForwarderId)}
                    disabled={!c.eligible}
                    onCheckedChange={(v) => toggleForwarder(c.freightForwarderId, v === true)}
                    aria-label={c.freightForwarderName}
                  />
                  {c.freightForwarderName}
                  <ForwarderStatusBadge status={c.quoteStatus} />
                  <span
                    data-testid={`negotiate-price-${c.freightForwarderId}`}
                    className="font-mono text-xs tabular-nums text-muted-foreground"
                  >
                    {c.prices.length === 0
                      ? "No price yet"
                      : c.prices
                          .map((p) => `${p.variantLabel} ${fmtUsd(p.usdTotal)}`)
                          .join(" · ")}
                  </span>
                </label>
                {!c.eligible && (
                  <p className="pl-6 text-xs text-muted-foreground">{c.reason}</p>
                )}
              </li>
            ))}
          </ul>

          {/* S5.9.2 product item 1 — one shared note applied to every selected forwarder. The
              per-forwarder note toggle/boxes this used to offer are gone: an exec who wants
              different wording for one forwarder selects just that forwarder and sends alone. */}
          <div className="space-y-1">
            <Label htmlFor="negotiate-note">Note</Label>
            <Textarea
              id="negotiate-note"
              value={sharedNote}
              onChange={(e) => setSharedNote(e.target.value)}
            />
            {noteTooLong(sharedNote) && (
              <p role="alert" className="text-sm text-destructive">
                Note must be {NOTE_MAX_LENGTH} characters or fewer.
              </p>
            )}
          </div>

          {results && (
            <ul className="space-y-1 text-sm" data-testid="negotiate-results">
              {results.map((r) => (
                <li key={r.quoteId} data-result={r.ok ? "ok" : "error"}>
                  {r.ok ? (
                    <>{r.freightForwarderName} — re-quote requested.</>
                  ) : (
                    <span role="alert">
                      {r.freightForwarderName} — {r.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={batch.isPending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSend} disabled={!canSubmit}>
            {batch.isPending ? "Sending…" : `Send to ${n} forwarder${n === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
