import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { requestRequoteSchema, type RequestRequoteInput } from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useRequestRequote } from "./useAwardActions";

export interface NegotiateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryId: string;
  legId: string;
  /** The forwarder's quote to negotiate — "" while closed (no FF picked yet); the trigger always
   *  supplies a real id before setting `open`, so the mutation is never fired against it. */
  quoteId: string;
  freightForwarderName: string;
}

/**
 * NegotiateDialog — the maker's "ask this forwarder to revise their price" action (S5.6 §12,
 * design §10.1). A single controlled `Dialog` shared by every FF button in `MakerPanel` (mirrors
 * `DistributeLegAction`'s confirm dialog / `PreviewRfqDialog`: the parent owns `open` + which
 * quote it's currently pointed at, this component owns only the form). On success the FF's quote
 * moves to REQUOTED server-side; the dialog closes and `useRequestRequote`'s invalidation of
 * `["comparison", queryId]` refreshes the grid with the new status badge.
 */
export function NegotiateDialog({
  open,
  onOpenChange,
  queryId,
  legId,
  quoteId,
  freightForwarderName,
}: NegotiateDialogProps) {
  const requestRequote = useRequestRequote(queryId, legId, quoteId);
  const form = useForm<RequestRequoteInput>({
    resolver: zodResolver(requestRequoteSchema),
    defaultValues: { comment: "" },
  });

  // Reset both the form and any previous error whenever the dialog re-opens — otherwise a
  // cancelled attempt for one FF would leak its typed comment (or a stale error) into the next.
  // Deliberately keyed on `open` alone (`form`/`requestRequote` are stable hook identities, not
  // values this effect needs to re-run for) — this repo doesn't run `react-hooks/exhaustive-deps`.
  useEffect(() => {
    if (open) {
      form.reset({ comment: "" });
      requestRequote.reset();
    }
  }, [open]);

  // `.mutate()` with an inline `onSuccess`, not `.mutateAsync()` — closing the dialog only on
  // success still needs a completion signal, but awaiting `mutateAsync` here would leave its
  // rejection uncaught on a failed request (mirrors the same fix in MakerPanel.tsx); the inline
  // `requestRequote.isError` block below still renders the failure without closing the dialog.
  function onSubmit(values: RequestRequoteInput) {
    requestRequote.mutate(values, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Negotiate with {freightForwarderName}</DialogTitle>
          <DialogDescription>
            Ask this forwarder to revise their price. They will see your comment and their quote
            moves to Re-quoted until they respond.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="negotiate-comment">Comment</Label>
            <Textarea id="negotiate-comment" {...form.register("comment")} />
            {form.formState.errors.comment && (
              <p role="alert" className="text-sm text-destructive">
                {form.formState.errors.comment.message}
              </p>
            )}
          </div>
          {requestRequote.isError && (
            <p role="alert" className="text-sm text-destructive">
              {requestRequote.error instanceof ApiError
                ? requestRequote.error.message
                : "Failed to request a re-quote."}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={requestRequote.isPending}>
              {requestRequote.isPending ? "Sending…" : "Request re-quote"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
