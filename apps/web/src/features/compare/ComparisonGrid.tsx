import type { LegComparisonDto } from "@svyft/shared";
import {
  buildComparisonRowModel,
  RECOMMENDATION_FOOTNOTE,
  SENT_FOR_APPROVAL_FOOTNOTE,
  APPROVED_FOOTNOTE,
  type OfferCell,
} from "./comparisonRowModel";
import { ComparisonGridColumns } from "./ComparisonGridColumns";
import { ComparisonGridRows } from "./ComparisonGridRows";
import type { ViewMode } from "./useViewMode";

// `offerKey`/`STALE_OFFER_LABEL` used to be re-exported from here for `ComparisonGrid.test.tsx`
// (final review MINOR #8 traces the earlier moves). S5.9.2 Task 3 (Q4's duplicate-badge removal)
// deleted the grid's own use of `STALE_OFFER_LABEL` and the test's import of it through this
// module — nothing resolves either symbol through here any more, so the re-export is gone too;
// `offerKey` lives in `comparisonRowModel.ts` and `STALE_OFFER_LABEL` in the same module, imported
// directly by whoever still needs them (`SendForApprovalDialog.tsx` and its own test).

export interface ComparisonGridProps {
  leg: LegComparisonDto;
  selectedOfferKey?: string;
  onSelectOffer?: (quoteId: string, variant: string | null) => void;
  /** `true` once the query is QUOTING_CLIENT (an award snapshot exists). The grid stays fully
   *  readable, but the engine's live recommendation is SUPPRESSED: the winning quote is `APPROVED`
   *  by then, `COMPARABLE_STATUSES` excludes it from `offers`, and `buildRecommendation` therefore
   *  re-ranks whatever is left — i.e. the losers — so a "Recommended" flag here would name a
   *  forwarder the award panel directly below contradicts (final review M1). Defaults to `false`. */
  locked?: boolean;
  /** Offers-as-columns (default) vs offers-as-rows (S5.7 T2). Optional and defaulted so every
   *  existing caller/test that doesn't pass it keeps rendering exactly as it did before T2 —
   *  ambiguity resolution #1. `CompareLegPanel` is the only caller that threads a live value
   *  through, from the ONE `useViewMode()` owned by `CompareQuotesPage` (final review IMPORTANT
   *  #1 — it used to call the hook per leg panel, which made the "global" preference per-leg). */
  viewMode?: ViewMode;
}

/**
 * ComparisonGrid — the public entry point for the Compare Quotes leg comparison table (S5.6 §12,
 * reshaped by S5.7 T1/T2). Builds the `ComparisonRowModel` (grouping, recommendation, staleness —
 * all pure and unit-tested in `comparisonRowModel.test.ts`) and dispatches to whichever orientation
 * `viewMode` selects — `ComparisonGridColumns` or `ComparisonGridRows` — plus the leg-level
 * "awaiting re-quote" notice that sits outside the table and is identical either way. (The
 * "awaiting response" roster that used to sit beside it is gone — S5.9.5 D7 moved every pending
 * forwarder INTO the table; see the comment at that notice below.)
 *
 * Purely read-only (S5.9 T9) — the maker's per-offer `Select` affordance (S5.7 T4) that used to
 * live in a Shortlist row/column here is gone. `CompareLegPanel` now opens one
 * `SendForApprovalDialog` from a "Send for approval…" button below the whole grid, which lists
 * every priced offer itself rather than acting on a single cell a grid click identified.
 */
export function ComparisonGrid({
  leg,
  selectedOfferKey,
  onSelectOffer,
  locked = false,
  viewMode = "columns",
}: ComparisonGridProps) {
  const model = buildComparisonRowModel(leg, locked);

  // Code-review fix (round 2) — `model.recommendedKey` is a non-null string whenever
  // `leg.recommendation` exists, EVEN when that recommendation names an offer absent from this
  // leg's `offers` (the dangling-reference edge case `comparisonRowModel.ts`'s own doc comment
  // and `ComparisonGrid.test.tsx`'s "degrades gracefully..." test both cover): no cell then has
  // `recommended: true`, so zero `★` marks render anywhere, and gating the footnote on the raw key
  // alone let it print regardless — "★ Recommended by the comparison engine." with nothing on the
  // page for the `★` to refer to. Gating on whether some cell actually carries the flag keeps the
  // footnote and the mark(s) it explains appearing/disappearing together, which is the whole point
  // of "explain the mark, only when the mark exists" (Step 6's own doc comment below).
  const hasRecommendedCell = model.cells.some((c) => c.kind === "offer" && c.recommended);
  // S5.9.1 Task 5 — same "gate the footnote on an ACTUAL flagged cell" reasoning as
  // `hasRecommendedCell` above, applied to the new mark.
  const hasSentForApprovalCell = model.cells.some((c) => c.kind === "offer" && c.sentForApproval);
  // S5.9.5 (D8) — and again for the `✔`. Same gate, same reason.
  const hasApprovedCell = model.cells.some((c) => c.kind === "offer" && c.approved);
  // Requirement 5 — the explanations share ONE line rather than growing a stray one each:
  // joined into a single string (not sibling JSX nodes) so the `<p>` below carries exactly one
  // text node, and `RECOMMENDATION_FOOTNOTE` alone still round-trips unchanged through
  // `screen.getByText` in the (still-common) case where only the recommendation applies.
  const footnote = [
    hasRecommendedCell && RECOMMENDATION_FOOTNOTE,
    hasSentForApprovalCell && SENT_FOR_APPROVAL_FOOTNOTE,
    hasApprovedCell && APPROVED_FOOTNOTE,
  ]
    .filter((x): x is string => Boolean(x))
    .join("  ");

  function handleOpenBreakdown(cell: OfferCell) {
    onSelectOffer?.(cell.offer.quoteId, cell.offer.variant);
  }

  return (
    <div className="space-y-4" data-testid="comparison-grid">
      {/* S5.9.5 (D7) — `groups.length === 0` changed MEANING with the row model, so the copy
          changed with it. A pending forwarder is now a group of its own, so this is no longer
          "nobody has priced" (which is exactly what "No comparable quotes yet." said) — it is "no
          forwarders at all on this leg". The old string is actively wrong for a leg where three
          forwarders were sent an RFQ and none replied: that leg now renders a real table of
          "Not quoted" cells, and would have read as having nothing on it. */}
      {model.groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No forwarders on this leg yet.</p>
      ) : viewMode === "rows" ? (
        <ComparisonGridRows
          model={model}
          onOpenBreakdown={handleOpenBreakdown}
          selectedOfferKey={selectedOfferKey}
        />
      ) : (
        <ComparisonGridColumns
          model={model}
          onOpenBreakdown={handleOpenBreakdown}
          selectedOfferKey={selectedOfferKey}
        />
      )}

      {/* Explains whichever mark(s) are actually on screen (product item 2; S5.9.1 Task 5 adds the
          `⚑`) — one `<p>`, not one per mark, per Requirement 5 ("keep the two explanations
          together rather than adding a second stray line"). Each half is gated on an ACTUAL
          flagged cell, not just a non-null key: `locked` suppressing a mark makes its key `null`
          (so its half of the footnote disappears too), and a dangling `leg.recommendation` (naming
          an offer absent from `offers`) leaves `recommendedKey` a non-null string with no cell ever
          picking it up — this guard is what keeps that half from printing with no `★` anywhere on
          the page for it to explain (code-review fix, round 2, extended to the new mark). */}
      {footnote.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="comparison-footnote">
          {footnote}
        </p>
      )}

      {/* S5.9.5 (D7) — the "Awaiting response" list that used to sit here is gone; every forwarder
          at RFQ_SENT and beyond is a cell IN the table above, `NOT_QUOTED_LABEL` in its variant
          slot and its own `ForwarderStatusBadge` in its Status slot. This note is a DIFFERENT
          thing (a leg-level warning about a re-quote in flight, not a per-forwarder roster) and D7
          does not touch it, so its wrapper condition narrows to `awaitingReQuote` alone. */}
      {leg.awaitingReQuote && (
        <div className="space-y-2 text-sm">
          <p className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-warning">
            Awaiting revised quote — the re-quoted offer above is excluded from the recommendation
            until the forwarder responds.
          </p>
        </div>
      )}
    </div>
  );
}
