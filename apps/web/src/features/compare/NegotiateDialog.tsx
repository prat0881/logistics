import { useEffect, useState } from "react";
import type { LegComparisonDto } from "@svyft/shared";
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
 * A forwarder is eligible when it has AT LEAST ONE offer with `quoteStatus` `QUOTED` or
 * `APPROVED` — REQUOTED forwarders (an offer exists, but a revised one is already pending) and
 * `pendingForwarders` (sent the RFQ, never comparably quoted) are both included, disabled, with
 * their own reason text — never hidden.
 */
function buildCandidates(leg: LegComparisonDto): Candidate[] {
  const byForwarder = new Map<string, Candidate>();
  for (const offer of leg.offers) {
    const quotable = offer.quoteStatus === "QUOTED" || offer.quoteStatus === "APPROVED";
    const existing = byForwarder.get(offer.freightForwarderId);
    if (!existing) {
      byForwarder.set(offer.freightForwarderId, {
        freightForwarderId: offer.freightForwarderId,
        freightForwarderName: offer.freightForwarderName,
        quoteId: offer.quoteId,
        eligible: quotable,
        reason: quotable ? undefined : "Already awaiting a revised quote.",
      });
    } else if (quotable && !existing.eligible) {
      // A later offer for the same forwarder turned out quotable (e.g. Dedicated is QUOTED after
      // Groupage, seen first, was REQUOTED) — the forwarder as a whole is still eligible.
      existing.eligible = true;
      existing.quoteId = offer.quoteId;
      existing.reason = undefined;
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
      });
    }
  }
  return Array.from(byForwarder.values());
}

/**
 * NegotiateDialog — the maker's leg-level "ask selected forwarders to revise their price" action
 * (S5.7 T5, replacing S5.6's per-forwarder button + single-forwarder dialog in `MakerPanel`). One
 * `Checkbox` per eligible/ineligible forwarder (deduplicated — see `buildCandidates`), a shared
 * note by default with a toggle that swaps in one note box per SELECTED forwarder, and a Send that
 * fires N sequential `request-requote` calls via `useRequestRequoteBatch` — see that hook's doc
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
  const [separateNotes, setSeparateNotes] = useState(false);
  const [sharedNote, setSharedNote] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [results, setResults] = useState<RequoteResult[] | null>(null);

  // Reset every bit of selection/note/result state whenever the dialog re-opens — a cancelled (or
  // completed) attempt must not leak its picks into the next one (ambiguity resolution #5).
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setSeparateNotes(false);
      setSharedNote("");
      setNotes({});
      setResults(null);
    }
  }, [open]);

  const allEligibleSelected = eligible.length > 0 && eligible.every((c) => selected.has(c.freightForwarderId));
  const selectedCandidates = candidates.filter((c) => c.eligible && selected.has(c.freightForwarderId));
  const n = selectedCandidates.length;

  function noteFor(id: string): string {
    return separateNotes ? (notes[id] ?? "") : sharedNote;
  }

  const hasEmptyNote = selectedCandidates.some((c) => noteFor(c.freightForwarderId).trim().length === 0);
  const canSubmit = n > 0 && !hasEmptyNote && !batch.isPending;

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
    const targets: RequoteTarget[] = selectedCandidates.map((c) => ({
      quoteId: c.quoteId as string,
      freightForwarderName: c.freightForwarderName,
      comment: noteFor(c.freightForwarderId).trim(),
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
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected.has(c.freightForwarderId)}
                    disabled={!c.eligible}
                    onCheckedChange={(v) => toggleForwarder(c.freightForwarderId, v === true)}
                    aria-label={c.freightForwarderName}
                  />
                  {c.freightForwarderName}
                </label>
                {!c.eligible && (
                  <p className="pl-6 text-xs text-muted-foreground">{c.reason}</p>
                )}
                {separateNotes && selected.has(c.freightForwarderId) && (
                  <div className="space-y-1 pl-6">
                    <Label htmlFor={`negotiate-note-${c.freightForwarderId}`}>
                      Note for {c.freightForwarderName}
                    </Label>
                    <Textarea
                      id={`negotiate-note-${c.freightForwarderId}`}
                      value={notes[c.freightForwarderId] ?? ""}
                      onChange={(e) =>
                        setNotes((prev) => ({ ...prev, [c.freightForwarderId]: e.target.value }))
                      }
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={separateNotes}
              onCheckedChange={(v) => setSeparateNotes(v === true)}
              aria-label="Send a separate note per forwarder"
            />
            Send a separate note per forwarder
          </label>

          {!separateNotes && (
            <div className="space-y-1">
              <Label htmlFor="negotiate-note">Note</Label>
              <Textarea
                id="negotiate-note"
                value={sharedNote}
                onChange={(e) => setSharedNote(e.target.value)}
              />
            </div>
          )}

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
