import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { LegComparisonDto, RejectInput } from "@svyft/shared";
import { rejectSchema, Role } from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useApprove, useReject } from "./useAwardActions";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export interface CheckerPanelProps {
  queryId: string;
  leg: LegComparisonDto;
}

/**
 * CheckerPanel — the Manager+ approve/reject controls for one leg's PENDING_APPROVAL decision
 * (S5.6 Task 5, design §9 steps 2+4). Self-gates on role exactly like `FxRatesPage.tsx`'s
 * `canWrite` (`user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER`) so
 * `CompareLegPanel` can mount this unconditionally: nothing renders for an Executive viewer, and
 * nothing renders once there's nothing left to check (no decision yet, or the decision has
 * already moved past PENDING_APPROVAL — DRAFT/APPROVED/REJECTED). The four-eyes rule
 * (`decision.sentByUserId === user.id`) disables both buttons WITHOUT hiding them, per the
 * coordinator's ambiguity resolution #1 — the point is to show the hint, not hide the controls.
 * The server enforces the same rule independently (403 SELF_APPROVAL), surfaced inline below as
 * defense-in-depth, not as the primary guard.
 */
export function CheckerPanel({ queryId, leg }: CheckerPanelProps) {
  const { user } = useAuth();
  const canCheck = user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER;

  const approve = useApprove(queryId, leg.legId);
  const reject = useReject(queryId, leg.legId);
  const form = useForm<RejectInput>({
    resolver: zodResolver(rejectSchema),
    defaultValues: { reason: "" },
  });

  const decision = leg.decision;
  const hasPendingDecision = decision != null && decision.status === "PENDING_APPROVAL";

  if (!canCheck || !hasPendingDecision) return null;

  const isSelf = user != null && decision.sentByUserId === user.id;
  const reasonId = `reject-reason-${leg.legId}`;

  // Same belt-and-suspenders pattern as MakerPanel's shortlist/send handlers (task-4 review
  // Fix #2): the disabled button already blocks a fast double-click, this closes the window at
  // the handler level too regardless of render/DOM timing.
  function onApprove() {
    if (approve.isPending || isSelf) return;
    approve.mutate();
  }

  function onReject(values: RejectInput) {
    if (reject.isPending || isSelf) return;
    reject.mutate({ reason: values.reason.trim() });
  }

  return (
    <div data-testid="checker-panel" className="space-y-4 rounded-lg border border-border bg-card p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Checker decision
      </h3>

      {isSelf && (
        <p className="text-sm text-muted-foreground">
          You sent this for approval — another manager must decide.
        </p>
      )}

      {approve.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(approve.error, "Failed to approve this leg.")}
        </p>
      )}

      <Button type="button" onClick={onApprove} disabled={isSelf || approve.isPending}>
        {approve.isPending ? "Approving…" : "Approve"}
      </Button>

      <form onSubmit={form.handleSubmit(onReject)} className="space-y-2 border-t border-border pt-4">
        <Label htmlFor={reasonId}>Rejection reason</Label>
        <Textarea id={reasonId} disabled={isSelf} {...form.register("reason")} />
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
        <Button type="submit" variant="outline" disabled={isSelf || reject.isPending}>
          {reject.isPending ? "Rejecting…" : "Reject"}
        </Button>
      </form>
    </div>
  );
}
