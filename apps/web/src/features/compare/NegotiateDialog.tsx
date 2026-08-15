import { useEffect, useRef } from "react";
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

  // The LATEST `quoteId` prop, updated every render (not just captured once) — read only inside
  // the async `onSuccess` callback below, where a plain closed-over `quoteId` would always equal
  // itself and could never detect "this dialog has since moved on to a different FF" (task-4
  // review Fix #1, part 2).
  const latestQuoteId = useRef(quoteId);
  latestQuoteId.current = quoteId;

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

  // This single controlled Dialog is reused across every FF's negotiation on the leg (see the doc
  // comment above) — Radix funnels EVERY close attempt (Escape, overlay click, the DialogContent
  // corner X, and this component's own Cancel button below) through `onOpenChange`, so gating it
  // here blocks all of them at once while a request is in flight. Without this, closing/cancelling
  // out of Acme's pending negotiation and opening Globex's would leave Acme's request racing
  // Globex's dialog: whichever settles later would otherwise fire the OTHER negotiation's
  // `onSuccess` (task-4 review Fix #1, part 1).
  function handleOpenChange(next: boolean) {
    if (!next && requestRequote.isPending) return;
    onOpenChange(next);
  }

  // `.mutate()` with an inline `onSuccess`, not `.mutateAsync()` — closing the dialog only on
  // success still needs a completion signal, but awaiting `mutateAsync` here would leave its
  // rejection uncaught on a failed request (mirrors the same fix in MakerPanel.tsx); the inline
  // `requestRequote.isError` block below still renders the failure without closing the dialog.
  //
  // The `submittedFor`/`latestQuoteId` check is defense-in-depth on top of `handleOpenChange`
  // above: with that guard in place, `quoteId` structurally can't change while a request for it
  // is pending (every normal close path is blocked), so this comparison should always hold in
  // practice — but it makes the success handler self-verifying rather than relying solely on the
  // dialog never having been reachable in a bad state, which is worth keeping cheap insurance
  // against however this component gets reused or changed later.
  function onSubmit(values: RequestRequoteInput) {
    const submittedFor = quoteId;
    requestRequote.mutate(values, {
      onSuccess: () => {
        if (latestQuoteId.current === submittedFor) onOpenChange(false);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={requestRequote.isPending}
            >
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
