import type { LegComparisonDto } from "@svyft/shared";
import { ForwarderStatusBadge } from "@/features/rfq-workspace/statusBadges";
import { buildComparisonRowModel, offerKey, STALE_OFFER_LABEL, type OfferCell } from "./comparisonRowModel";
import { ComparisonGridColumns } from "./ComparisonGridColumns";

// Re-exported so every existing importer (`CompareLegPanel`, `MakerPanel`, and their tests) keeps
// resolving these from `./ComparisonGrid` unchanged. Both now live in `comparisonRowModel.ts`
// (S5.7 T1) — `offerKey` moved there verbatim, `STALE_OFFER_LABEL` moved there to avoid a module
// cycle with `ComparisonGridColumns.tsx`, which also needs it.
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
}

/**
 * ComparisonGrid — the public entry point for the Compare Quotes leg comparison table (S5.6 §12,
 * reshaped by S5.7 T1). Builds the `ComparisonRowModel` (grouping, recommendation, staleness — all
 * pure and unit-tested in `comparisonRowModel.test.ts`) and renders `ComparisonGridColumns`, plus
 * the leg-level "awaiting response" / "awaiting re-quote" notices that sit outside the table.
 */
export function ComparisonGrid({
  leg,
  selectedOfferKey,
  onSelectOffer,
  locked = false,
}: ComparisonGridProps) {
  const model = buildComparisonRowModel(leg, locked);

  function handleOpenBreakdown(cell: OfferCell) {
    onSelectOffer?.(cell.offer.quoteId, cell.offer.variant);
  }

  return (
    <div className="space-y-4">
      {model.groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comparable quotes yet.</p>
      ) : (
        <ComparisonGridColumns
          model={model}
          leg={leg}
          onOpenBreakdown={handleOpenBreakdown}
          selectedOfferKey={selectedOfferKey}
        />
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
