import {
  RECOMMENDED_MARK,
  SENT_FOR_APPROVAL_MARK,
  SENT_FOR_APPROVAL_ACCESSIBLE_NAME,
  APPROVED_MARK,
  APPROVED_ACCESSIBLE_NAME,
  type OfferCell,
} from "./comparisonRowModel";

export interface OfferMarksProps {
  cell: OfferCell;
  /** `ComparisonRowModel.recommendedReason` — the `★`'s accessible name. Never
   *  `leg.recommendation.reason` directly: once a decision snapshot is in play the live reason may
   *  no longer describe the offer this mark points at (see `buildComparisonRowModel`'s doc). */
  recommendedReason: string | null;
}

/**
 * OfferMarks — the mark cluster that sits beside an offer's variant label.
 *
 * Extracted in S5.9.5 Task 9 from four copies of the same JSX (the priced and unpriced branches of
 * both `ComparisonGridColumns` and `ComparisonGridRows`), because this task adds a third mark and
 * a fourth copy of the addition is where the two orientations drift. Rationale carried forward
 * from those copies, still true and now stated once:
 *
 * - The `★`'s reason comes from `model.recommendedReason`, never `leg.recommendation.reason` — see
 *   `OfferMarksProps.recommendedReason` above and `buildComparisonRowModel`'s doc comment.
 *   Gating on `cell.recommended` alone would do (the model guarantees a non-null reason whenever a
 *   cell is flagged), but the extra `recommendedReason &&` term keeps this render from ever
 *   asserting an accessible name it cannot back with real text.
 * - `⚑` is a DIFFERENT glyph and colour from `★`, never a second use of it: recommended (the
 *   engine's opinion) and sent-for-approval (the maker's decision) are independent signals, so an
 *   offer that is both renders both marks side by side. See `comparisonRowModel.ts`'s doc comment
 *   on `SENT_FOR_APPROVAL_MARK`.
 *
 * `✔` (S5.9.5 D8) is the new one. It follows the same "independent signals render side by side"
 * rule as the two above, with one asymmetry that comes from the model rather than from here:
 * `recommended` and `approved` CAN coexist on one cell (the engine's opinion and the checker's
 * decision are separate questions), while `sentForApproval` and `approved` cannot — the model
 * gates one on `decision.status === "PENDING_APPROVAL"` and the other on `"APPROVED"`, so
 * "approved replaces the flag" falls out of those gates and needs no precedence rule here.
 */
export function OfferMarks({ cell, recommendedReason }: OfferMarksProps) {
  return (
    <>
      {cell.recommended && recommendedReason && (
        <span
          data-testid={`offer-recommended-${cell.key}`}
          aria-label={`Recommended — ${recommendedReason}`}
          title={recommendedReason}
          className="ml-1 text-emerald-600"
        >
          {RECOMMENDED_MARK}
        </span>
      )}
      {cell.sentForApproval && (
        <span
          data-testid={`offer-sent-for-approval-${cell.key}`}
          aria-label={SENT_FOR_APPROVAL_ACCESSIBLE_NAME}
          title={SENT_FOR_APPROVAL_ACCESSIBLE_NAME}
          className="ml-1 text-primary"
        >
          {SENT_FOR_APPROVAL_MARK}
        </span>
      )}
      {cell.approved && (
        <span
          data-testid={`offer-approved-${cell.key}`}
          aria-label={APPROVED_ACCESSIBLE_NAME}
          title={APPROVED_ACCESSIBLE_NAME}
          className="ml-1 text-primary"
        >
          {APPROVED_MARK}
        </span>
      )}
    </>
  );
}
