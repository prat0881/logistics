import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * A single unchecked checklist item displayed in the optional-gaps dialog.
 * Only the fields needed for display are required here.
 */
export interface UncheckedItem {
  itemKey: string;
  label: string;
}

/** The three possible outcomes from the dialog. */
export type CreateQueryDialogResult = "send" | "draft" | "cancel";

interface CreateQueryDialogProps {
  open: boolean;
  items: UncheckedItem[];
  onResult: (result: CreateQueryDialogResult) => void;
}

/**
 * CreateQueryDialog — spec §13 "optional gaps" prompt.
 *
 * Shown when there are no blocking findings but some checklist items remain
 * unchecked. Offers three actions:
 *   - Cancel     → close without creating (onResult("cancel"))
 *   - Save Draft → close, already saved (onResult("draft"))
 *   - Send Anyway → proceed with create (onResult("send"))
 */
export function CreateQueryDialog({ open, items, onResult }: CreateQueryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onResult("cancel"); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create query with missing optional info?</DialogTitle>
          <DialogDescription>
            The following checklist items are still unchecked. You can still
            send the query, but the assigned team will have less context.
          </DialogDescription>
        </DialogHeader>

        {items.length > 0 && (
          <ul className="space-y-1 text-sm pl-1">
            {items.map((item) => (
              <li key={item.itemKey} className="flex items-center gap-2 text-muted-foreground">
                <span className="w-2 h-2 rounded-full bg-warning shrink-0" aria-hidden="true" />
                {item.label}
              </li>
            ))}
          </ul>
        )}

        <DialogFooter className="flex-row justify-end gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onResult("cancel")}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => onResult("draft")}>
            Save Draft
          </Button>
          <Button onClick={() => onResult("send")}>
            Send Anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
