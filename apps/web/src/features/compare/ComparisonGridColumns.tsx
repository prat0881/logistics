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
import { ShortlistSelectCell } from "./ShortlistSelectCell";

/** Right-of-column border that groups a forwarder's variant columns visually (S5.7 item 1 — S5.6
 *  Task 3 deliberately shipped without one, recorded as a judgment call, which read as ambiguous
 *  grouping). Applied to the LAST cell of every forwarder group in every row of the table, so the
 *  line runs unbroken from the forwarder-name header down through the Status row. Columns-only —
 *  there's no rows-view equivalent (S5.7 T2). */
const GROUP_SEPARATOR = "border-r-2 border-border";

export interface ComparisonGridColumnsProps {
  model: ComparisonRowModel;
  leg: LegComparisonDto;
  onOpenBreakdown: (cell: OfferCell) => void;
  /** Which offer's charge breakdown is currently expanded below the grid — used only for the
   *  header button's `aria-expanded`; the toggle itself is owned by `CompareLegPanel`. */
  selectedOfferKey?: string;
  /** Opens the maker's `ShortlistDialog` for one offer (S5.7 T4). `undefined` ⇒ the whole Shortlist
   *  row is UNMOUNTED — that's how a locked award (and a decision already past DRAFT) drops the
   *  maker affordance entirely rather than merely disabling it. Deliberately separate from
   *  `onOpenBreakdown`: reading an offer's charges must never move what a submit would act on,
   *  which is exactly how the S5.6 Critical happened. */
  onShortlistOffer?: (cell: OfferCell) => void;
}

/**
 * ComparisonGridColumns — the read-only per-leg `(FF × variant)` comparison table (S5.6 §12,
 * reshaped by S5.7 T1), driven entirely by a pre-built `ComparisonRowModel` rather than deriving
 * grouping/recommendation state itself. `ComparisonGrid` builds the model and stays the public
 * entry point; this component is pure rendering.
 */
export function ComparisonGridColumns({
  model,
  leg,
  onOpenBreakdown,
  selectedOfferKey,
  onShortlistOffer,
}: ComparisonGridColumnsProps) {
  const { groups, cells } = model;
  const lastInGroup = new Set(groups.map((g) => g.cells[g.cells.length - 1]!.key));

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-32" />
            {groups.map((g) => (
              <TableHead
                key={g.freightForwarderId}
                colSpan={g.cells.length}
                className={cn("text-center font-semibold text-foreground", GROUP_SEPARATOR)}
              >
                {g.freightForwarderName}
              </TableHead>
            ))}
          </TableRow>
          <TableRow>
            <TableHead className="w-32">Offer</TableHead>
            {cells.map((cell) => {
              const variantText = cell.offer.variant ? rateVariantLabel(cell.offer.variant) : "—";
              return (
                <TableHead
                  key={cell.key}
                  className={cn(
                    "text-center align-bottom",
                    cell.recommended && RECOMMENDED_TINT,
                    lastInGroup.has(cell.key) && GROUP_SEPARATOR,
                  )}
                >
                  {/* An unpriced offer has nothing to expand (its "charges" are just the two real,
                      always-zero Additional/Warehousing lines buildCharges still emits — see
                      ChargeBreakdownDialog's doc comment) — no click affordance at all, consistent
                      with the grid greying its totals rather than showing $0. */}
                  {cell.offer.priced ? (
                    <button
                      type="button"
                      data-testid={`offer-header-${cell.key}`}
                      aria-expanded={selectedOfferKey === cell.key}
                      onClick={() => onOpenBreakdown(cell)}
                      className="w-full rounded px-1 py-0.5 text-center hover:bg-muted/50"
                    >
                      <span className="block text-xs font-medium">
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
                      </span>
                    </button>
                  ) : (
                    <div data-testid={`offer-header-${cell.key}`} className="w-full px-1 py-0.5">
                      <span className="block text-xs font-medium text-muted-foreground">
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
                      </span>
                    </div>
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {METRICS.map((metric) => (
            <TableRow key={metric.id}>
              <TableCell className="font-medium text-muted-foreground">{metric.label}</TableCell>
              {cells.map((cell) => (
                <TableCell
                  key={cell.key}
                  data-testid={`${METRIC_TESTID[metric.id]}-${cell.key}`}
                  className={cn(
                    METRIC_CELL_CLASS[metric.id],
                    cell.recommended && RECOMMENDED_TINT,
                    lastInGroup.has(cell.key) && GROUP_SEPARATOR,
                  )}
                >
                  {metric.render(cell)}
                </TableCell>
              ))}
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="font-medium text-muted-foreground">Status</TableCell>
            {cells.map((cell) => (
              <TableCell
                key={cell.key}
                data-testid={`offer-status-${cell.key}`}
                className={cn(
                  "text-center",
                  cell.recommended && RECOMMENDED_TINT,
                  lastInGroup.has(cell.key) && GROUP_SEPARATOR,
                )}
              >
                <div className="flex flex-col items-center gap-1">
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
            ))}
          </TableRow>
          {onShortlistOffer && (
            <TableRow>
              <TableCell className="font-medium text-muted-foreground">Shortlist</TableCell>
              {cells.map((cell) => (
                <TableCell
                  key={cell.key}
                  className={cn(
                    "text-center",
                    cell.recommended && RECOMMENDED_TINT,
                    lastInGroup.has(cell.key) && GROUP_SEPARATOR,
                  )}
                >
                  <ShortlistSelectCell cell={cell} onSelect={onShortlistOffer} />
                </TableCell>
              ))}
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
