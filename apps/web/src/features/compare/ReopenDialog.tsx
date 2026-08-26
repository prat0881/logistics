import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ReopenComparisonInput } from "@svyft/shared";
import { reopenComparisonSchema } from "@svyft/shared";
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
import { useReopenComparison } from "./useAwardActions";
import { errorMessage } from "./errorMessage";

export interface ReopenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryId: string;
}

/**
 * ReopenDialog — the reason-collecting confirmation in front of `reopen-comparison` (S5.9.5,
 * design D6). Mirrors `RejectDialog` exactly — `react-hook-form` + `zodResolver`, one required
 * `reason` textarea, an inline `role="alert"` field error and the same in-flight close guard — so
 * the two reason-collecting flows on this screen behave identically.
 *
 * `reopenComparisonSchema` (`packages/shared`'s `award.ts`) is the SAME schema the controller
 * validates against (`ZodValidationPipe(reopenComparisonSchema)`), so a reason this dialog accepts
 * is one the server accepts; the reason lands on every leg's `REOPEN` `AwardDecisionEvent`.
 *
 * **The copy states the consequences, because they are not reversible by clicking again.** Traced
 * through `AwardService.reopenComparison`, which in one transaction: clears `Query.awardSnapshot`
 * (which is what unlocks the query — `QueryLockService`); marks every `ISSUED` `Quotation` on the
 * query `SUPERSEDED`; and DELETES every `DRAFT` one, because the cost basis it was priced from has
 * just gone. It deliberately leaves leg, decision and quote statuses exactly as they are — D2
 * replaced the original "move all APPROVED forwarders back to QUOTED" ask, and Reject is what walks
 * a single leg back afterwards. So this dialog must not promise that anything is un-approved.
 */
export function ReopenDialog({ open, onOpenChange, queryId }: ReopenDialogProps) {
  const reopen = useReopenComparison(queryId);
  const pending = reopen.isPending;
  const reasonId = `reopen-reason-${queryId}`;

  const form = useForm<ReopenComparisonInput>({
    resolver: zodResolver(reopenComparisonSchema),
    defaultValues: { reason: "" },
  });

  // Same in-flight guard as `RejectDialog`/`ApproveDialog` — Radix funnels every close path
  // (Escape, overlay click, the corner X) through here too.
  function handleOpenChange(next: boolean) {
    if (!next && pending) return;
    onOpenChange(next);
  }

  function onSubmit(values: ReopenComparisonInput) {
    if (pending) return;
    reopen.mutate(
      { reason: values.reason.trim() },
      {
        onSuccess: () => {
          onOpenChange(false);
          form.reset({ reason: "" });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen comparison</DialogTitle>
          <DialogDescription>
            This unfreezes the query so the offers can be compared again. A client quotation already
            issued from this comparison is marked superseded, and one still in draft is discarded.
            Each leg keeps the status it has now — to change a leg&rsquo;s approved forwarder, reject
            that leg after reopening.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-2">
          <Label htmlFor={reasonId}>Reason for reopening</Label>
          <Textarea id={reasonId} disabled={pending} {...form.register("reason")} />
          {form.formState.errors.reason && (
            <p role="alert" className="text-sm text-destructive">
              {form.formState.errors.reason.message}
            </p>
          )}
          {reopen.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(reopen.error, "Failed to reopen the comparison.")}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Reopening…" : "Reopen"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
