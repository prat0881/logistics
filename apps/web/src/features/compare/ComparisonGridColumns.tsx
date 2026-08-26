import { rateVariantLabel } from "@svyft/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ForwarderStatusBadge } from "@/features/rfq-workspace/statusBadges";
import {
  METRICS,
  METRIC_TESTID,
  METRIC_CELL_CLASS,
  METRIC_ALIGN,
  RECOMMENDED_TINT,
  APPROVED_TINT,
  NOT_QUOTED_LABEL,
  type ComparisonRowModel,
  type OfferCell,
} from "./comparisonRowModel";
import { OfferMarks } from "./OfferMarks";

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
      {/* S5.9.2 T4 (#6, PO ruling) — full width, columns spread evenly, values still centred.
       *  A previous round set `w-auto` (sizing the table to its content, table.tsx is off-limits —
       *  this is a className override from the consumer, the sanctioned seam) to fix a centring
       *  regression, but that reopened the ORIGINAL complaint: a narrow table stranded in a wide
       *  panel, all dead space to its right. `w-full` alone would just let `table-auto` stretch
       *  columns in proportion to their content, which is uneven and not what "distributed evenly"
       *  asks for. `table-fixed` makes column width purely a function of the header row's own
       *  classes instead: the one cell with an explicit width (the `w-32` label column below) stays
       *  fixed, and every offer column — none of which sets a width — splits the remaining space
       *  equally. Centring is untouched: it still comes from `METRIC_ALIGN.columns` on both the
       *  header and the cell (see the comment where it's applied below), not from anything here. */}
      <Table className="w-full table-fixed">
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
              // S5.9.5 (D7) — a pending forwarder's header slot. No variant to name (nothing was
              // priced), so it reads `NOT_QUOTED_LABEL`, and no `offer-header-` testid: that id is
              // the charge-breakdown affordance's, and there is nothing to break down. Its own
              // `pending-cell-` id is what Task 10's tests key off.
              if (cell.kind === "pending") {
                return (
                  <TableHead
                    key={cell.key}
                    className={cn(
                      "h-auto px-2 py-1.5 align-bottom",
                      METRIC_ALIGN.columns,
                      lastInGroup.has(cell.key) && GROUP_SEPARATOR,
                    )}
                  >
                    <div data-testid={`pending-cell-${cell.key}`} className="w-full px-1 py-0.5">
                      <span className="block text-xs font-medium text-muted-foreground">
                        {NOT_QUOTED_LABEL}
                      </span>
                    </div>
                  </TableHead>
                );
              }
              const variantText = cell.offer.variant ? rateVariantLabel(cell.offer.variant) : "—";
              // The header (and the button inside it) take `METRIC_ALIGN.columns`, NOT a
              // `text-center` literal (final whole-branch review): the metric cells below derive
              // their alignment from that same constant, so a literal here would be a second source
              // for the one thing R6 exists to keep in step — editing it to `text-left` would put
              // the data back out from under its header (the product owner's original complaint)
              // with the whole suite still green, since the tests only reached the cell. Both ends
              // now move together by construction.
              return (
                <TableHead
                  key={cell.key}
                  className={cn(
                    "h-auto px-2 py-1.5 align-bottom",
                    METRIC_ALIGN.columns,
                    cell.recommended && RECOMMENDED_TINT,
                    // Last, so `cn`'s tailwind-merge resolves a cell that is BOTH recommended and
                    // approved in favour of the approval — the checker's decision outranks the
                    // engine's opinion, and the model lets the two coexist on one cell.
                    cell.approved && APPROVED_TINT,
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
                      className={cn(
                        "w-full rounded px-1 py-0.5 hover:bg-muted/50",
                        METRIC_ALIGN.columns,
                      )}
                    >
                      <span className="block text-xs font-medium">
                        {variantText}
                        <OfferMarks cell={cell} recommendedReason={model.recommendedReason} />
                      </span>
                    </button>
                  ) : (
                    <div data-testid={`offer-header-${cell.key}`} className="w-full px-1 py-0.5">
                      <span className="block text-xs font-medium text-muted-foreground">
                        {variantText}
                        <OfferMarks cell={cell} recommendedReason={model.recommendedReason} />
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
                    cell.kind === "offer" && cell.recommended && RECOMMENDED_TINT,
                    // Last of the two tints — see the header's identical pair for why.
                    cell.kind === "offer" && cell.approved && APPROVED_TINT,
                    lastInGroup.has(cell.key) && GROUP_SEPARATOR,
                  )}
                >
                  {/* S5.9.5 (D7) — a pending cell has nothing to measure, so it never reaches
                      `metric.render`, which is typed against `OfferCell` alone precisely so this
                      site cannot forget. Em-dash, the same "no value" glyph an unpriced offer's
                      own metrics already use. */}
                  {cell.kind === "pending" ? "—" : metric.render(cell)}
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
                  cell.kind === "offer" && cell.recommended && RECOMMENDED_TINT,
                  cell.kind === "offer" && cell.approved && APPROVED_TINT,
                  lastInGroup.has(cell.key) && GROUP_SEPARATOR,
                )}
              >
                <div className="flex flex-col items-center gap-1">
                  {/* S5.9.2 Q4 (PO ruling) — the second `STALE_OFFER_LABEL` badge that used to sit
                      here is gone: it duplicated `ForwarderStatusBadge`, which already reads
                      "RFQ-Resent" for a `REQUOTED` offer (renamed for exactly this reason). Two
                      badges saying the same thing was the duplication the product owner asked
                      about — one status, one badge.
                      S5.9.5 (D7) — a pending cell reads its own `forwarder.quoteStatus` here (RFQ
                      Sent / Expired / Invalid), which is why `NOT_QUOTED_LABEL` in the variant
                      slot above is deliberately NOT a status name: this badge already carries the
                      precise one. It is the only place ON THIS SCREEN that still does, now that
                      the list below the grid which used to carry the same badge is gone —
                      `NegotiateDialog` renders its own copy from the same `pendingForwarders`
                      entry, but that is a dialog the user has to open. */}
                  <ForwarderStatusBadge
                    status={
                      cell.kind === "pending" ? cell.forwarder.quoteStatus : cell.offer.quoteStatus
                    }
                  />
                </div>
              </TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
