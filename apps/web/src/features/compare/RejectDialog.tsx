import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { LegComparisonDto, RejectInput } from "@svyft/shared";
import { rejectSchema } from "@svyft/shared";
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
import { useReject } from "./useAwardActions";
import { errorMessage } from "./errorMessage";

export interface RejectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryId: string;
  leg: LegComparisonDto;
}

/**
 * RejectDialog — the checker's reason-collecting reject flow (S5.9.1 Task 2, product item 4: "On
 * click of Reject button, pop should appear for the reject reason notes"). Replaces `CheckerPanel`'s
 * old inline `<form>` with a modal, `react-hook-form` + `zodResolver(rejectSchema)` exactly as
 * `CheckerPanel` validated it — a required, non-empty `reason` (`rejectSchema`, `packages/shared`'s
 * `award.ts`) — mirroring `SendForApprovalDialog`'s own field-handling shape (register + inline
 * `role="alert"` field error).
 *
 * Rejecting is this org's whole path to a revised price for Manager/Admin (product item 1: no
 * Negotiate for them — "if they want to negotiate then they should reject and put the reason in
 * the notes"), so the reason box is the operative surface here, not a footnote — `reject()` writes
 * the leg back to DRAFT carrying this reason, which `MakerPanel`'s rejection alert then surfaces to
 * the maker.
 */
export function RejectDialog({ open, onOpenChange, queryId, leg }: RejectDialogProps) {
  const reject = useReject(queryId, leg.legId);
  const pending = reject.isPending;
  const reasonId = `reject-reason-${leg.legId}`;

  const form = useForm<RejectInput>({
    resolver: zodResolver(rejectSchema),
    defaultValues: { reason: "" },
  });

  // Same in-flight guard as `ApproveDialog`/`SendForApprovalDialog` — Radix funnels every close
  // path (Escape, overlay click, the corner X) through here too.
  function handleOpenChange(next: boolean) {
    if (!next && pending) return;
    onOpenChange(next);
  }

  function onSubmit(values: RejectInput) {
    if (pending) return;
    reject.mutate(
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
          <DialogTitle>Reject {leg.legCode}</DialogTitle>
          <DialogDescription>
            {leg.origin} → {leg.destination}. This returns the leg to the maker as DRAFT — the
            reason below is their only on-screen cue for what to revise.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-2">
          <Label htmlFor={reasonId}>Rejection reason</Label>
          <Textarea id={reasonId} disabled={pending} {...form.register("reason")} />
          {form.formState.errors.reason && (
            <p role="alert" className="text-sm text-destructive">
              {form.formState.errors.reason.message}
            </p>
          )}
          {reject.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(reject.error, "Failed to reject this leg.")}
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
              {pending ? "Rejecting…" : "Reject"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
