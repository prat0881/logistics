import { useEffect, useState } from "react";
import type { QuotationDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { errorMessage } from "@/features/compare/errorMessage";
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
 * "Attachments — none" on the left; the letter, read-only, on the right.
 *
 * 🔴 The letter (`data-testid="quotation-letter"`) is rendered VERBATIM from `quotation
 * .previewBody` and nothing else — this component never reads `quotation.pricing`. That is
 * deliberate, not an oversight: the commercial rule ("grand total only — no charge lines, no
 * per-leg totals, no forwarder cost, no margin, no forwarder names", design doc "Withheld from
 * the client") is enforced entirely server-side by `QuotationService.renderFromTemplate` (Task 4
 * fix round 1; Task 6 extends the same render to the read path as `previewBody`). Reconstructing
 * or re-filtering the letter here would let the display drift from what `POST .../issue` actually
 * sends — the whole reason Task 6's ruling moved rendering server-side in the first place. This
 * component's only job is to show that text faithfully.
 *
 * The action is labelled "Issue quotation", not "Send" (ambiguity resolution #2): `LogTransport
 * .send()` is a no-op until `SmtpTransport` lands at the go-live gate, so the footer states
 * plainly that delivery is pending rather than implying the email has actually gone out.
 *
 * `subject` falls back to `quotation.previewSubject` (the template's own rendered subject) but
 * stays caller-editable, matching the design's envelope-vs-letter split — the letter itself never
 * is. Issuing sends only `{ recipientEmail, subject? }` — `quotationIssueSchema` has no `bodyText`
 * field at all (Task 4 fix round 1), so there is nothing else to compose here.
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

  // Re-seed on open only (not on every `quotation`/`defaultRecipientEmail` prop change) — a
  // background refetch of the quotation while the dialog is open (e.g. from another tab's PATCH)
  // must not silently overwrite whatever the user is mid-typing into either field.
  useEffect(() => {
    if (open) {
      setRecipientEmail(defaultRecipientEmail);
      setSubject(quotation.previewSubject);
      issue.reset();
    }
  }, [open]);

  async function handleIssue() {
    try {
      await issue.mutateAsync({
        recipientEmail,
        subject: subject.trim() ? subject.trim() : undefined,
      });
      onOpenChange(false);
    } catch {
      // Surfaced via issue.isError below — the dialog stays open so the manager can retry.
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(quotation.previewBody);
    } catch {
      // Clipboard access can be denied/unavailable in some environments — this is a convenience
      // action only, nothing else depends on it succeeding.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Preview quotation</DialogTitle>
          <DialogDescription>
            Review the letter exactly as it will be issued, then send it to the client.
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

          <div
            data-testid="quotation-letter"
            className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4 font-mono text-sm"
          >
            {quotation.previewBody}
          </div>
        </div>

        {issue.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(issue.error, "Failed to issue the quotation.")}
          </p>
        )}

        <DialogFooter className="flex-col items-stretch gap-2 sm:items-end">
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={issue.isPending}
            >
              Back to builder
            </Button>
            <Button type="button" variant="outline" onClick={handleCopy}>
              Copy text
            </Button>
            <Button
              type="button"
              onClick={handleIssue}
              disabled={issue.isPending || !recipientEmail.trim()}
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
