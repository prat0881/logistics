import { Button } from "@/components/ui/button";
import type { OfferCell } from "./comparisonRowModel";

export interface ShortlistSelectCellProps {
  cell: OfferCell;
  onSelect: (cell: OfferCell) => void;
}

/**
 * The maker's per-offer `Select` affordance (S5.7 T4) — the single entry point to `ShortlistDialog`.
 *
 * ONE implementation shared by both grid orientations rather than a copy in each: T1/T2 lifted the
 * metric list, testids, cell classes and the recommendation tint into shared code precisely so the
 * columns and rows views cannot drift, and a hand-duplicated interactive control would have
 * re-opened that hole for the one control that fires a mutation. The parity suite in
 * `ComparisonGrid.test.tsx` still exercises it through BOTH views (click wiring, the unpriced guard,
 * and its absence once locked) — this component makes those three pass for the same reason rather
 * than by coincidence.
 *
 * An UNPRICED offer gets no button at all — same rule as the charge-breakdown header affordance
 * (`ComparisonGridColumns`'s doc comment): there is nothing to shortlist, and the server's A1 guard
 * would reject it anyway.
 */
export function ShortlistSelectCell({ cell, onSelect }: ShortlistSelectCellProps) {
  if (!cell.offer.priced) {
    return (
      <span data-testid={`shortlist-select-${cell.key}`} className="text-muted-foreground">
        —
      </span>
    );
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid={`shortlist-select-${cell.key}`}
      // The visible label is just "Select"; the accessible name carries the offer identity so a
      // screen-reader user isn't choosing between N identically-named buttons.
      aria-label={`Select ${cell.offer.freightForwarderName} — ${cell.offer.variantLabel}`}
      onClick={() => onSelect(cell)}
      className="h-7 px-2.5 text-xs"
    >
      Select
    </Button>
  );
}
