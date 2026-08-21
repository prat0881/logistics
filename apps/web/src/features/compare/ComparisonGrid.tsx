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
  /** Opens the maker's `ShortlistDialog` for one offer (S5.7 T4). Omit it — or set `locked` — and
   *  the Shortlist row/column is not rendered at all. Deliberately NOT folded into `onSelectOffer`
   *  above: that one only opens the read-only charge breakdown, and the S5.6 Critical was precisely
   *  a *reading* gesture silently moving what a submit would act on. */
  onShortlistOffer?: (cell: OfferCell) => void;
}

/**
 * ComparisonGrid — the public entry point for the Compare Quotes leg comparison table (S5.6 §12,
 * reshaped by S5.7 T1/T2). Builds the `ComparisonRowModel` (grouping, recommendation, staleness —
 * all pure and unit-tested in `comparisonRowModel.test.ts`) and dispatches to whichever orientation
 * `viewMode` selects — `ComparisonGridColumns` or `ComparisonGridRows` — plus the leg-level
 * "awaiting response" / "awaiting re-quote" notices that sit outside the table and are identical
 * either way.
 */
export function ComparisonGrid({
  leg,
  selectedOfferKey,
  onSelectOffer,
  locked = false,
  viewMode = "columns",
  onShortlistOffer,
}: ComparisonGridProps) {
  const model = buildComparisonRowModel(leg, locked);

  // ONE place decides that a locked award has no maker affordance, so neither orientation can be
  // the one that forgets (the panel above ALSO withholds the handler for a decision past DRAFT —
  // these are different conditions, and both must unmount rather than disable).
  const shortlistHandler = locked ? undefined : onShortlistOffer;

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
          onShortlistOffer={shortlistHandler}
        />
      ) : (
        <ComparisonGridColumns
          model={model}
          leg={leg}
          onOpenBreakdown={handleOpenBreakdown}
          selectedOfferKey={selectedOfferKey}
          onShortlistOffer={shortlistHandler}
        />
      )}

      {/* Explains the `★` mark (product item 2) once per leg — only when there's a live
          recommendation for it to refer to; `recommendedKey` is already `null` whenever `locked`
          suppresses the recommendation, so this and the mark disappear together. */}
      {model.recommendedKey && (
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
