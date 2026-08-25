import { useEffect, useState } from "react";
import type { QuotationDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { errorMessage } from "@/features/compare/errorMessage";
import { copyToClipboard } from "@/lib/clipboard";
import { useIssueQuotation } from "./useQuotation";

// Mirrors `quotationIssueSchema.bodyText`'s `.max(5000)` (packages/shared/src/quotation.ts) — a
// client-side guard so overflow is caught at the keyboard, not as a round trip that comes back
// with the Zod pipe's generic "Validation failed" and no mention of length. Keep these two in
// sync if the schema's cap ever changes.
const BODY_MAX_LENGTH = 5000;

export interface QuotationPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryId: string;
  quotation: QuotationDto;
  /** Prefilled recipient — the query's own contact email (S5.8 Task 6, ambiguity resolution #1),
   *  `""` when the query has none on file. Editable; re-seeded only when the dialog (re)opens, not
   *  on every prop change, so it can't clobber an in-progress edit mid-session. */
  defaultRecipientEmail: string;
  /** True while `QuotationPage` has a margin/override PATCH in flight OR debounced-but-not-yet-
   *  fired (S5.9.3 Task 1 review, IMPORTANT). Because the dialog is modal (Radix traps/blocks the
   *  page behind it — see `components/ui/dialog.tsx`), THIS browser cannot start a new reprice
   *  while the dialog is open, so what this prop covers is exactly one window: a request that was
   *  already in flight or queued at the moment it opened. It covers nothing outside this browser
   *  — another tab or another manager can PATCH at any time, and this prop stays `false` — which
   *  is why the server, not this flag, is the guard against issuing against stale pricing (final
   *  review IMPORTANT #1; see `handleIssue`'s `expectedUpdatedAt` below). While `true`, Issue
   *  stays disabled and a note explains why — see this component's own doc comment for why this,
   *  not just disabling the *trigger* button in `QuotationPage`, is what closes the in-flight
   *  window: a click that blurs an override field and opens this dialog in the same gesture can
   *  beat a `disabled` attribute update, so the dialog itself has to be the backstop. */
  pricingPending: boolean;
}

/**
 * QuotationPreviewDialog — envelope + letter (S5.8 Task 6, ambiguity resolution #1): recipient
 * (prefilled, editable), subject (prefilled from the rendered template, editable), version, and
 * "Attachments — none" on the left; the letter on the right.
 *
 * S5.9.3 Task 1 (P1, product owner's explicit ruling): the letter (`data-testid="quotation-
 * letter"`) is now ALSO prefilled-and-editable, the same way subject already was — it seeds from
 * `quotation.previewBody` on open and can be freely edited before issuing. Through S5.8 Task 6
 * this box was read-only and rendered VERBATIM from `previewBody`, which was the *structural*
 * guarantee that a client-facing letter could not contain cost, margin or forwarder names: the UI
 * had no control that could put them there. P1 removes that guarantee — it is now procedural
 * (P2), resting on the manager only ever editing a prefilled, already-safe draft rather than
 * composing from blank. What P1 explicitly does NOT touch is the money: this component still
 * never reads `quotation.pricing` for the LETTER, and — more importantly — neither does the
 * server. `QuotationService.issue()` prices the grand total from the query's frozen award data,
 * completely independent of whatever free text ends up in this box; see that method's doc comment
 * for exactly how. The `issuedSnapshot`/`Quotation.bodyText` audit record still stores whatever
 * was ACTUALLY sent (P2), so a manager's edit is never silently lost or silently overridden.
 *
 * 🔴 S5.9.3 Task 1 re-review (IMPORTANT): the first cut of P1 re-seeded `bodyText` on `[open]`
 * only, same as `subject`/`recipientEmail`. That is wrong for the body specifically, because
 * unlike those two fields the body is what carries the grand total, and pricing can genuinely
 * change WHILE this dialog is open (a margin/override PATCH that was already in flight or
 * debounced when it opened settles moments later) — without a re-seed, the manager reads and
 * sends the OLD total while `issue()` prices the NEW draft, with no error and no edit required to
 * trigger it. Before P1 this was structurally impossible (the body was always rendered fresh at
 * issue time); P1 made it possible; this fix closes it back down, WITHOUT reintroducing "silently
 * discard the manager's edit" as the mechanism:
 *
 * - `seededBody` tracks the `previewBody` the textarea was last synced to (on open, on an
 *   auto-resync, or on an explicit reconcile below) — the baseline "what pricing does the CURRENT
 *   box content agree with". Real state, not a ref: `handleKeepEdits` below needs to move this
 *   baseline WITHOUT touching `bodyText`, and that has to actually re-render for the conflict
 *   banner to clear — a ref mutation alone wouldn't.
 * - If the box still matches that baseline (`bodyText === seededBody`, i.e. the
 *   manager hasn't touched it) and `quotation.previewBody` has since moved on, the effect below
 *   silently re-syncs — nothing is lost, because there was nothing to lose.
 * - If the box does NOT match the baseline (the manager HAS edited) and `previewBody` has also
 *   moved on, that is a genuine conflict: the manager's own text disagrees with what pricing now
 *   is, and neither "keep serving the stale text" nor "silently overwrite their edit" is
 *   acceptable. `staleConflict` renders an inline warning with two explicit choices — reload from
 *   the new pricing (discards the edit, but the manager chose that) or keep the edit (advances the
 *   baseline so the warning doesn't nag on every render, on record that they saw and accepted the
 *   mismatch). Issue stays disabled until one of those two is picked.
 * - `pricingPending` (prop, from `QuotationPage`) covers the narrower window where a request is
 *   still outstanding — Issue disables and a note explains why, rather than letting a manager
 *   issue in the split second before a reprice lands.
 *
 * 🔴 S5.9.3 final review (IMPORTANT #1): all three of those layers react only to THIS browser's
 * `quotation` prop changing, and nothing makes that prop change on its own. `useQuotation` has no
 * polling and TanStack Query refetches only on focus/mount, so a manager who opens this dialog and
 * stays in the tab never sees a PATCH made by a second tab or a second manager — every layer above
 * stays quiet and Issue stays enabled, while the letter on screen quotes the pre-PATCH total and
 * the server charges the post-PATCH one. That is not closable from here (the client is the thing
 * that is stale), so `handleIssue` sends `expectedUpdatedAt` — the `updatedAt` of the quotation
 * this letter was composed against — and the server refuses a mismatch with a 409. The refusal is
 * recoverable, not a wall: `useIssueQuotation` refetches the quotation on that 409, which flows
 * back in through the same re-seed/conflict logic above and puts the CURRENT letter in front of
 * the manager, with the server's message still on screen explaining why it changed.
 *
 * The action is labelled "Issue quotation", not "Send" (ambiguity resolution #2): `LogTransport
 * .send()` is a no-op until `SmtpTransport` lands at the go-live gate, so the footer states
 * plainly that delivery is pending rather than implying the email has actually gone out.
 *
 * `subject`/`bodyText` both fall back to the template's own rendered defaults but stay
 * caller-editable — issuing sends `{ recipientEmail, subject?, bodyText? }`, `quotationIssueSchema`
 * mirrors `subject`'s existing optional-but-non-empty-if-present rule onto `bodyText` (S5.9.3
 * Task 1). Unlike subject, an emptied body is never silently swapped back to the render here —
 * the Issue action stays disabled while the box is blank, so a manager who clears it gets an
 * unambiguous "you need to put something back", not a letter they didn't actually write.
 */
export function QuotationPreviewDialog({
  open,
  onOpenChange,
  queryId,
  quotation,
  defaultRecipientEmail,
  pricingPending,
}: QuotationPreviewDialogProps) {
  const issue = useIssueQuotation(queryId);
  const [recipientEmail, setRecipientEmail] = useState(defaultRecipientEmail);
  const [subject, setSubject] = useState(quotation.previewSubject);
  const [bodyText, setBodyText] = useState(quotation.previewBody);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  // The `previewBody` the box currently agrees with — see the doc comment above.
  const [seededBody, setSeededBody] = useState(quotation.previewBody);

  // Re-seed on open only (not on every `quotation`/`defaultRecipientEmail` prop change) — a
  // background refetch of the quotation while the dialog is open (e.g. from another tab's PATCH)
  // must not silently overwrite whatever the user is mid-typing into any of these fields. The
  // BODY gets an additional, narrower re-sync below for the in-flight-at-open case.
  useEffect(() => {
    if (open) {
      setRecipientEmail(defaultRecipientEmail);
      setSubject(quotation.previewSubject);
      setBodyText(quotation.previewBody);
      setSeededBody(quotation.previewBody);
      setCopyState("idle");
      issue.reset();
    }
  }, [open]);

  // Reprice-while-open, unedited case: the box still holds exactly what we last seeded it with,
  // so a new `previewBody` can be adopted with nothing to lose. Runs on every render where
  // `quotation.previewBody` or `bodyText` changed; both branches converge (either it re-syncs and
  // `seededBody` catches up, or the condition is false and it's a no-op) so this can't loop.
  useEffect(() => {
    if (!open) return;
    if (bodyText === seededBody && quotation.previewBody !== seededBody) {
      setBodyText(quotation.previewBody);
      setSeededBody(quotation.previewBody);
    }
  }, [open, quotation.previewBody, bodyText, seededBody]);

  // Reprice-while-open, EDITED case: the manager's text no longer matches the pricing baseline it
  // was written against. Recomputed every render — cheap string comparisons, no state of its own.
  const bodyEdited = bodyText !== seededBody;
  const staleConflict = bodyEdited && quotation.previewBody !== seededBody;

  const bodyIsEmpty = !bodyText.trim();

  function handleBodyChange(next: string) {
    setBodyText(next);
    // A stale "Copied to clipboard"/"Couldn't copy" confirmation is actively misleading once the
    // content it refers to has changed — copy now copies whatever's CURRENTLY in the box.
    if (copyState !== "idle") setCopyState("idle");
  }

  function handleReloadFromPricing() {
    setBodyText(quotation.previewBody);
    setSeededBody(quotation.previewBody);
  }

  function handleKeepEdits() {
    // Advance the baseline to the current pricing WITHOUT touching `bodyText` — the manager's
    // edit survives untouched, but the conflict clears because the box is now understood to be a
    // deliberate, acknowledged departure from current pricing rather than an accidental one. If
    // pricing moves again after this, `staleConflict` re-arms exactly the same way.
    setSeededBody(quotation.previewBody);
  }

  async function handleIssue() {
    try {
      await issue.mutateAsync({
        recipientEmail,
        subject: subject.trim() ? subject.trim() : undefined,
        // No fallback-on-blank here (unlike subject): the Issue button is disabled while
        // `bodyIsEmpty`, so this only ever runs with real, manager-authored text — sending
        // whatever the template quietly rendered instead would contradict the audit record's
        // whole point (P2 — it must reflect what was actually sent).
        bodyText: bodyText.trim(),
        // The optimistic-concurrency token (final review IMPORTANT #1). Read off the CURRENT
        // `quotation` prop, not off a value captured when the dialog opened — if a refetch has
        // landed since, this is exactly the pricing the re-seed/conflict logic above has already
        // reconciled the letter against, so the server accepts it. If no refetch has landed, it
        // is stale by definition and the server is the one that says so.
        expectedUpdatedAt: quotation.updatedAt,
      });
      onOpenChange(false);
    } catch {
      // Surfaced via issue.isError below — the dialog stays open so the manager can retry.
    }
  }

  async function handleCopy() {
    const ok = await copyToClipboard(bodyText);
    setCopyState(ok ? "ok" : "fail");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Preview quotation</DialogTitle>
          <DialogDescription>
            Review the letter, edit it if needed, then send it to the client.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[minmax(0,220px)_1fr]">
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <Label htmlFor="quotation-recipient">Recipient</Label>
              <Input
                id="quotation-recipient"
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="quotation-subject">Subject</Label>
              <Input
                id="quotation-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Version</div>
              <div>{quotation.version}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Attachments
              </div>
              <div className="text-muted-foreground">None</div>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="quotation-body">Letter</Label>
            <Textarea
              id="quotation-body"
              data-testid="quotation-letter"
              value={bodyText}
              onChange={(e) => handleBodyChange(e.target.value)}
              maxLength={BODY_MAX_LENGTH}
              className="max-h-[50vh] min-h-[50vh] resize-none overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4 font-mono text-sm"
            />
          </div>
        </div>

        {pricingPending && (
          <p role="status" className="text-sm text-muted-foreground">
            Pricing is still updating — the total isn't final yet, so issuing is paused for a
            moment.
          </p>
        )}

        {staleConflict && (
          <div role="alert" className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
            <p>
              Pricing changed after this letter was written — the total below may no longer match
              what the client will actually be charged.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={handleReloadFromPricing}>
                Reload letter from current pricing
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={handleKeepEdits}>
                Keep my edits
              </Button>
            </div>
          </div>
        )}

        {issue.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(issue.error, "Failed to issue the quotation.")}
          </p>
        )}

        <DialogFooter className="flex-col items-stretch gap-2 sm:items-end">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {copyState === "ok" && (
              <p role="status" className="text-xs text-success">Copied to clipboard</p>
            )}
            {copyState === "fail" && (
              <p role="alert" className="text-xs text-warning">
                Couldn't copy — select the text and copy manually.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={issue.isPending}
            >
              Back to builder
            </Button>
            <Button type="button" variant="outline" onClick={() => void handleCopy()}>
              Copy to clipboard
            </Button>
            <Button
              type="button"
              onClick={handleIssue}
              disabled={
                issue.isPending || !recipientEmail.trim() || bodyIsEmpty || pricingPending || staleConflict
              }
            >
              {issue.isPending ? "Issuing…" : "Issue quotation"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Delivery is pending — issuing records this quotation but doesn't send the email yet;
            outbound sending isn't wired up until go-live.
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
