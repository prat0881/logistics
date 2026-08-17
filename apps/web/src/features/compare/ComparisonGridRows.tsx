import type { LegComparisonDto } from "@svyft/shared";
import { rateVariantLabel } from "@svyft/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ForwarderStatusBadge } from "@/features/rfq-workspace/statusBadges";
import {
  METRICS,
  METRIC_TESTID,
  METRIC_CELL_CLASS,
  RECOMMENDED_TINT,
  STALE_OFFER_LABEL,
  type ComparisonRowModel,
  type OfferCell,
} from "./comparisonRowModel";

export interface ComparisonGridRowsProps {
  model: ComparisonRowModel;
  leg: LegComparisonDto;
  onOpenBreakdown: (cell: OfferCell) => void;
  /** Which offer's charge breakdown is currently expanded below the grid — same meaning as
   *  `ComparisonGridColumns`'s prop of the same name; used only for `aria-expanded`. */
  selectedOfferKey?: string;
}

/**
 * ComparisonGridRows — the offers-as-rows orientation of the Compare Quotes leg comparison table
 * (S5.7 T2). One `<tr>` per `(FF × variant)` cell, driven by the SAME `ComparisonRowModel` and
 * `METRICS` as `ComparisonGridColumns` — no second metric list, no second recommendation/staleness
 * rule, so the two views cannot drift. Rows are grouped by forwarder in the model's first-seen
 * order; the forwarder name is printed once, above its first variant, and subsequent variants of
 * the same forwarder are indented/muted rather than repeating the name.
 */
export function ComparisonGridRows({
  model,
  leg,
  onOpenBreakdown,
  selectedOfferKey,
}: ComparisonGridRowsProps) {
  const { groups } = model;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-48">Forwarder / variant</TableHead>
            {METRICS.map((metric) => (
              <TableHead key={metric.id} className="text-right">
                {metric.label}
              </TableHead>
            ))}
            <TableHead className="text-center">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group) =>
            group.cells.map((cell, indexInGroup) => {
              const variantText = cell.offer.variant ? rateVariantLabel(cell.offer.variant) : "—";
              const isFirstInGroup = indexInGroup === 0;

              return (
                <TableRow key={cell.key} className={cn(cell.recommended && RECOMMENDED_TINT)}>
                  <TableCell className={cn(cell.recommended && RECOMMENDED_TINT)}>
                    <div className="flex flex-col gap-0.5">
                      {isFirstInGroup && (
                        <span className="text-xs font-semibold text-foreground">
                          {group.freightForwarderName}
                        </span>
                      )}
                      {/* Same guard as the columns header: an unpriced offer has nothing to expand
                          (see ComparisonGridColumns's doc comment) — no click affordance at all. */}
                      {cell.offer.priced ? (
                        <button
                          type="button"
                          data-testid={`offer-header-${cell.key}`}
                          aria-expanded={selectedOfferKey === cell.key}
                          onClick={() => onOpenBreakdown(cell)}
                          className={cn(
                            "w-fit rounded px-1 py-0.5 text-left text-xs font-medium hover:bg-muted/50",
                            !isFirstInGroup && "pl-3 text-muted-foreground",
                          )}
                        >
                          {variantText}
                        </button>
                      ) : (
                        <div
                          data-testid={`offer-header-${cell.key}`}
                          className={cn(
                            "px-1 py-0.5 text-xs font-medium text-muted-foreground",
                            !isFirstInGroup && "pl-3",
                          )}
                        >
                          {variantText}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  {METRICS.map((metric) => (
                    <TableCell
                      key={metric.id}
                      data-testid={`${METRIC_TESTID[metric.id]}-${cell.key}`}
                      className={cn(METRIC_CELL_CLASS[metric.id], cell.recommended && RECOMMENDED_TINT)}
                    >
                      {metric.render(cell)}
                    </TableCell>
                  ))}
                  <TableCell
                    data-testid={`offer-status-${cell.key}`}
                    className={cn("text-center", cell.recommended && RECOMMENDED_TINT)}
                  >
                    <div className="flex flex-wrap items-center justify-center gap-1">
                      <ForwarderStatusBadge status={cell.offer.quoteStatus} />
                      {cell.recommended && leg.recommendation && (
                        <Badge
                          variant="accent"
                          title={leg.recommendation.reason}
                          className="whitespace-nowrap"
                        >
                          ★ Recommended
                        </Badge>
                      )}
                      {cell.stale && (
                        <Badge
                          variant="warning"
                          data-testid={`offer-stale-${cell.key}`}
                          className="whitespace-nowrap"
                        >
                          {STALE_OFFER_LABEL}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            }),
          )}
        </TableBody>
      </Table>
    </div>
  );
}
