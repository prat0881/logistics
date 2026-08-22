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
  METRIC_ALIGN,
  RECOMMENDED_TINT,
  RECOMMENDED_MARK,
  STALE_OFFER_LABEL,
  type ComparisonRowModel,
  type OfferCell,
} from "./comparisonRowModel";

/** Right-of-column border that groups a forwarder's variant columns visually (S5.7 item 1 — S5.6
 *  Task 3 deliberately shipped without one, recorded as a judgment call, which read as ambiguous
 *  grouping). Applied to the LAST cell of every forwarder group in every row of the table, so the
 *  line runs unbroken from the forwarder-name header down through the Status row. Columns-only —
 *  there's no rows-view equivalent (S5.7 T2). */
const GROUP_SEPARATOR = "border-r-2 border-border";

export interface ComparisonGridColumnsProps {
  model: ComparisonRowModel;
  onOpenBreakdown: (cell: OfferCell) => void;
  /** Which offer's charge breakdown is currently expanded below the grid — used only for the
   *  header button's `aria-expanded`; the toggle itself is owned by `CompareLegPanel`. */
  selectedOfferKey?: string;
}

/**
 * ComparisonGridColumns — the read-only per-leg `(FF × variant)` comparison table (S5.6 §12,
 * reshaped by S5.7 T1), driven entirely by a pre-built `ComparisonRowModel` rather than deriving
 * grouping/recommendation state itself. `ComparisonGrid` builds the model and stays the public
 * entry point; this component is pure rendering. Purely read-only (S5.9 T9) — the per-offer
 * `Select`/Shortlist row this table used to render is gone; `SendForApprovalDialog` (opened below
 * the whole grid) is now the only place that acts on an offer.
 */
export function ComparisonGridColumns({
  model,
  onOpenBreakdown,
  selectedOfferKey,
}: ComparisonGridColumnsProps) {
  const { groups, cells } = model;
  const lastInGroup = new Set(groups.map((g) => g.cells[g.cells.length - 1]!.key));

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      {/* `w-auto` overrides the shared `Table`'s own `w-full` (table.tsx is off-limits — this is a
       *  className override from the consumer, the sanctioned seam). With few offers, a `w-full`
       *  table stretches its columns to fill the panel and the numbers end up stranded far from
       *  their (narrow, centred) headers — the product owner's complaint. Sized-to-content still
       *  scrolls correctly for a wide leg: the wrapping div above keeps `overflow-x-auto`. */}
      <Table className="w-auto">
        <TableHeader>
          <TableRow>
            <TableHead className="h-9 w-32 px-3" />
            {groups.map((g) => (
              <TableHead
                key={g.freightForwarderId}
                colSpan={g.cells.length}
                className={cn(
                  "h-9 px-3 text-center font-semibold text-foreground",
                  GROUP_SEPARATOR,
                )}
              >
                {g.freightForwarderName}
              </TableHead>
            ))}
          </TableRow>
          <TableRow>
            <TableHead className="h-auto w-32 px-3 py-1.5">Offer</TableHead>
            {cells.map((cell) => {
              const variantText = cell.offer.variant ? rateVariantLabel(cell.offer.variant) : "—";
              return (
                <TableHead
                  key={cell.key}
                  className={cn(
                    "h-auto px-2 py-1.5 text-center align-bottom",
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
                        {/* S5.9.1 R1, Step 4 — the reason text comes from `model.recommendedReason`,
                            not `leg.recommendation.reason` directly: once a decision snapshot is in
                            play, the live reason may no longer describe the offer this mark is
                            pointing at (see `buildComparisonRowModel`'s doc comment). Gating on
                            `cell.recommended` alone would do here (the model guarantees a non-null
                            reason whenever a cell is flagged), but the extra check keeps this render
                            from ever asserting an accessible name it can't back with real text. */}
                        {cell.recommended && model.recommendedReason && (
                          <span
                            data-testid={`offer-recommended-${cell.key}`}
                            aria-label={`Recommended — ${model.recommendedReason}`}
                            title={model.recommendedReason}
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
                        {/* S5.9.1 R1, Step 4 — the reason text comes from `model.recommendedReason`,
                            not `leg.recommendation.reason` directly: once a decision snapshot is in
                            play, the live reason may no longer describe the offer this mark is
                            pointing at (see `buildComparisonRowModel`'s doc comment). Gating on
                            `cell.recommended` alone would do here (the model guarantees a non-null
                            reason whenever a cell is flagged), but the extra check keeps this render
                            from ever asserting an accessible name it can't back with real text. */}
                        {cell.recommended && model.recommendedReason && (
                          <span
                            data-testid={`offer-recommended-${cell.key}`}
                            aria-label={`Recommended — ${model.recommendedReason}`}
                            title={model.recommendedReason}
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
              <TableCell className="px-3 py-2 font-medium text-muted-foreground">
                {metric.label}
              </TableCell>
              {cells.map((cell) => (
                <TableCell
                  key={cell.key}
                  data-testid={`${METRIC_TESTID[metric.id]}-${cell.key}`}
                  className={cn(
                    "px-2 py-2",
                    METRIC_CELL_CLASS[metric.id],
                    METRIC_ALIGN.columns,
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
            <TableCell className="px-3 py-2 font-medium text-muted-foreground">Status</TableCell>
            {cells.map((cell) => (
              <TableCell
                key={cell.key}
                data-testid={`offer-status-${cell.key}`}
                className={cn(
                  "px-2 py-2 text-center",
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
        </TableBody>
      </Table>
    </div>
  );
}
