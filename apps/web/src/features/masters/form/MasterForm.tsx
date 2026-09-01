import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function MasterForm({
  title,
  error,
  banner,
  onSubmit,
  isSubmitting,
  onCancel,
  isDirty,
  recordNoun = "record",
  children,
}: {
  title: string;
  error?: string | null;
  banner?: ReactNode;
  onSubmit: () => void;
  isSubmitting: boolean;
  onCancel: () => void;
  isDirty: boolean;
  recordNoun?: string;
  children: ReactNode;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        aria-label={title}
        className="max-w-3xl space-y-6"
      >
        <h1 className="font-display text-xl font-semibold tracking-tight">{title}</h1>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {banner}
        {children}
        <div className="flex gap-2 border-t border-border pt-4">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => (isDirty ? setConfirmingDiscard(true) : onCancel())}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
        </div>
      </form>

      {/* Deliberately a sibling of the <form>, not a child. Radix renders DialogContent through
          a Portal, but React bubbles events through the REACT tree rather than the DOM tree —
          a dialog nested inside the form would route its clicks through that form's handlers.
          That exact bug bit ContactDialog on this branch and needed an explicit
          stopPropagation; keeping this outside the form means there is nothing to guard. */}
      <Dialog open={confirmingDiscard} onOpenChange={(open) => !open && setConfirmingDiscard(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your changes to this {recordNoun} will not be saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirmingDiscard(false)}>
              Keep editing
            </Button>
            {/* Close the dialog before handing control back. Every caller's `onCancel` today
                navigates away and unmounts this component, which would hide the leftover
                `confirmingDiscard: true` — but that is a property of the callers, not of the
                prop contract, and a shared form shell is exactly the thing that acquires a
                non-navigating `onCancel` later. Resetting here makes the state correct on its
                own terms rather than by luck. */}
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmingDiscard(false);
                onCancel();
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
