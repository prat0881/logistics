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

export interface QuotationPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryId: string;
  quotation: QuotationDto;
  /** Prefilled recipient — the query's own contact email (S5.8 Task 6, ambiguity resolution #1),
   *  `""` when the query has none on file. Editable; re-seeded only when the dialog (re)opens, not
   *  on every prop change, so it can't clobber an in-progress edit mid-session. */
  defaultRecipientEmail: string;
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
}: QuotationPreviewDialogProps) {
  const issue = useIssueQuotation(queryId);
  const [recipientEmail, setRecipientEmail] = useState(defaultRecipientEmail);
  const [subject, setSubject] = useState(quotation.previewSubject);
  const [bodyText, setBodyText] = useState(quotation.previewBody);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");

  // Re-seed on open only (not on every `quotation`/`defaultRecipientEmail` prop change) — a
  // background refetch of the quotation while the dialog is open (e.g. from another tab's PATCH)
  // must not silently overwrite whatever the user is mid-typing into any of these fields.
  useEffect(() => {
    if (open) {
      setRecipientEmail(defaultRecipientEmail);
      setSubject(quotation.previewSubject);
      setBodyText(quotation.previewBody);
      setCopyState("idle");
      issue.reset();
    }
  }, [open]);

  const bodyIsEmpty = !bodyText.trim();

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
              onChange={(e) => setBodyText(e.target.value)}
              className="max-h-[50vh] min-h-[50vh] resize-none overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4 font-mono text-sm"
            />
          </div>
        </div>

        {issue.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(issue.error, "Failed to issue the quotation.")}
          </p>
        )}

        <DialogFooter className="flex-col items-stretch gap-2 sm:items-end">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {copyState === "ok" && (
              <p className="text-xs text-success">Copied to clipboard</p>
            )}
            {copyState === "fail" && (
              <p className="text-xs text-warning">Couldn't copy — select the text and copy manually.</p>
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
              disabled={issue.isPending || !recipientEmail.trim() || bodyIsEmpty}
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
