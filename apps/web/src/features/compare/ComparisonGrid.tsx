import type { LegComparisonDto } from "@svyft/shared";
import { ForwarderStatusBadge } from "@/features/rfq-workspace/statusBadges";
import {
  buildComparisonRowModel,
  offerKey,
  RECOMMENDATION_FOOTNOTE,
  STALE_OFFER_LABEL,
  type OfferCell,
} from "./comparisonRowModel";
import { ComparisonGridColumns } from "./ComparisonGridColumns";
import { ComparisonGridRows } from "./ComparisonGridRows";
import type { ViewMode } from "./useViewMode";

// Both of these now LIVE in `comparisonRowModel.ts` (S5.7 T1) — `offerKey` moved there verbatim,
// `STALE_OFFER_LABEL` moved there to avoid a module cycle with `ComparisonGridColumns.tsx`, which
// also needs it. They stay re-exported here because `ComparisonGrid.test.tsx` imports
// `STALE_OFFER_LABEL` from this module; no production file resolves either symbol through here any
// more (final review MINOR #8 — `MakerPanel` stopped importing from this module in T4, and
// `CompareLegPanel` now takes `offerKey` from the leaf module alongside `buildComparisonRowModel`).
export { offerKey, STALE_OFFER_LABEL };

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
 * "awaiting response" / "awaiting re-quote" notices that sit outside the table and are identical
 * either way.
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
  const hasRecommendedCell = model.cells.some((c) => c.recommended);

  function handleOpenBreakdown(cell: OfferCell) {
    onSelectOffer?.(cell.offer.quoteId, cell.offer.variant);
  }

  return (
    <div className="space-y-4" data-testid="comparison-grid">
      {model.groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comparable quotes yet.</p>
      ) : viewMode === "rows" ? (
        <ComparisonGridRows
          model={model}
          leg={leg}
          onOpenBreakdown={handleOpenBreakdown}
          selectedOfferKey={selectedOfferKey}
        />
      ) : (
        <ComparisonGridColumns
          model={model}
          leg={leg}
          onOpenBreakdown={handleOpenBreakdown}
          selectedOfferKey={selectedOfferKey}
        />
      )}

      {/* Explains the `★` mark (product item 2) once per leg — only when there's a live
          recommendation for it to refer to. Gated on an ACTUAL flagged cell, not just a non-null
          `recommendedKey`: `locked` suppressing the recommendation makes `recommendedKey` `null`
          (so this and the mark disappear together there too), but a dangling `leg.recommendation`
          (naming an offer absent from `offers`) leaves `recommendedKey` a non-null string with no
          cell ever picking it up — this guard is what keeps the footnote from printing in that
          case with no `★` anywhere on the page for it to explain (code-review fix, round 2). */}
      {hasRecommendedCell && (
        <p className="text-xs text-muted-foreground">{RECOMMENDATION_FOOTNOTE}</p>
      )}

      {(leg.pendingForwarders.length > 0 || leg.awaitingReQuote) && (
        <div className="space-y-2 text-sm">
          {leg.pendingForwarders.length > 0 && (
            <div data-testid="pending-forwarders" className="space-y-1">
              <p className="font-medium text-muted-foreground">Awaiting response</p>
              <ul className="space-y-1">
                {leg.pendingForwarders.map((pf) => (
                  <li
                    key={pf.freightForwarderId}
                    data-testid={`pending-ff-${pf.freightForwarderId}`}
                    className="flex items-center gap-2"
                  >
                    <span>{pf.freightForwarderName}</span>
                    <ForwarderStatusBadge status={pf.quoteStatus} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {leg.awaitingReQuote && (
            <p className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-warning">
              Awaiting revised quote — the re-quoted offer above is excluded from the
              recommendation until the forwarder responds.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
