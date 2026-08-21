import { Fragment } from "react";
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
  RECOMMENDED_MARK,
  STALE_OFFER_LABEL,
  type ComparisonRowModel,
  type OfferCell,
} from "./comparisonRowModel";

/** The rows-view equivalent of `ComparisonGridColumns`'s `GROUP_SEPARATOR` (design §39 — forwarder
 *  rows are "grouped and banded"; S5.7 shipped the columns rule but no rows counterpart, so
 *  grouping read only from the name being printed once — final review MINOR #9). Two existing
 *  tokens, no new visual language: alternate forwarder groups get a faint `muted` wash, and every
 *  group after the first opens with the same 2px `border` rule the columns view closes its groups
 *  with. The band sits on the `<tr>` and the recommendation tint on each `<td>`, so a recommended
 *  row inside a banded group still reads as recommended (a cell background paints over its row's). */
const GROUP_BAND = "bg-muted/30";
const GROUP_TOP_RULE = "border-t-2 border-border";

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
 * order; the forwarder's name is printed once, on its own full-width band row above the group
 * (product item 3 — the Forwarder column is gone, so two rows both reading "Dedicated" from
 * different forwarders would otherwise be indistinguishable), and every variant row underneath it
 * carries just the variant. Purely read-only (S5.9 T9) — see `ComparisonGridColumns`'s doc comment
 * for why the Shortlist column this table used to carry is gone.
 */
export function ComparisonGridRows({
  model,
  leg,
  onOpenBreakdown,
  selectedOfferKey,
}: ComparisonGridRowsProps) {
  const { groups } = model;
  // The band row spans every column the table actually has: the metrics, plus Variant and Status.
  // Derived, never hard-coded, so a future METRICS entry can't silently leave the band short.
  const bandColSpan = METRICS.length + 2;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-48">Variant</TableHead>
            {METRICS.map((metric) => (
              <TableHead key={metric.id} className="text-right">
                {metric.label}
              </TableHead>
            ))}
            <TableHead className="text-center">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group, groupIndex) => (
            <Fragment key={group.freightForwarderId}>
              <TableRow
                data-testid={`forwarder-band-${group.freightForwarderId}`}
                className={cn("bg-muted/60", groupIndex > 0 && GROUP_TOP_RULE)}
              >
                <TableCell
                  colSpan={bandColSpan}
                  className="py-1.5 text-xs font-semibold text-foreground"
                >
                  {group.freightForwarderName}
                </TableCell>
              </TableRow>
              {group.cells.map((cell, indexInGroup) => {
                const variantText = cell.offer.variant ? rateVariantLabel(cell.offer.variant) : "—";
                const isFirstInGroup = indexInGroup === 0;

                return (
                  <TableRow
                    key={cell.key}
                    data-testid={`offer-row-${cell.key}`}
                    className={cn(
                      groupIndex % 2 === 1 && GROUP_BAND,
                      isFirstInGroup && groupIndex > 0 && GROUP_TOP_RULE,
                      // Last, so `cn`'s tailwind-merge resolves the background conflict in favour of
                      // the recommendation rather than the band.
                      cell.recommended && RECOMMENDED_TINT,
                    )}
                  >
                    <TableCell className={cn(cell.recommended && RECOMMENDED_TINT)}>
                      {/* Same guard as the columns header: an unpriced offer has nothing to expand
                          (see ComparisonGridColumns's doc comment) — no click affordance at all. */}
                      {cell.offer.priced ? (
                        <button
                          type="button"
                          data-testid={`offer-header-${cell.key}`}
                          aria-expanded={selectedOfferKey === cell.key}
                          onClick={() => onOpenBreakdown(cell)}
                          className="w-fit rounded px-1 py-0.5 text-left text-xs font-medium hover:bg-muted/50"
                        >
                          {variantText}
                          {cell.recommended && leg.recommendation && (
                            <span
                              data-testid={`offer-recommended-${cell.key}`}
                              aria-label={`Recommended — ${leg.recommendation.reason}`}
                              title={leg.recommendation.reason}
                              className="ml-1 text-emerald-600"
                            >
                              {RECOMMENDED_MARK}
                            </span>
                          )}
                        </button>
                      ) : (
                        <div
                          data-testid={`offer-header-${cell.key}`}
                          className="px-1 py-0.5 text-xs font-medium text-muted-foreground"
                        >
                          {variantText}
                          {cell.recommended && leg.recommendation && (
                            <span
                              data-testid={`offer-recommended-${cell.key}`}
                              aria-label={`Recommended — ${leg.recommendation.reason}`}
                              title={leg.recommendation.reason}
                              className="ml-1 text-emerald-600"
                            >
                              {RECOMMENDED_MARK}
                            </span>
                          )}
                        </div>
                      )}
                    </TableCell>
                    {METRICS.map((metric) => (
                      <TableCell
                        key={metric.id}
                        data-testid={`${METRIC_TESTID[metric.id]}-${cell.key}`}
                        className={cn(
                          METRIC_CELL_CLASS[metric.id],
                          cell.recommended && RECOMMENDED_TINT,
                        )}
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
              })}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
