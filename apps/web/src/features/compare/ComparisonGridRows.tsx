import { Fragment } from "react";
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
            <TableHead className="h-9 w-48 px-3">Variant</TableHead>
            {METRICS.map((metric) => (
              <TableHead key={metric.id} className={cn("h-9 px-3", METRIC_ALIGN.rows)}>
                {metric.label}
              </TableHead>
            ))}
            <TableHead className="h-9 px-3 text-center">Status</TableHead>
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
                const isFirstInGroup = indexInGroup === 0;
                // S5.9.5 (D7) — the two tints are read off an OFFER cell only; a pending cell earns
                // neither (nothing to recommend, nothing to approve). Hoisted so the four
                // `className` sites below stay readable rather than repeating the narrow.
                const recommended = cell.kind === "offer" && cell.recommended;
                const approved = cell.kind === "offer" && cell.approved;
                // Ordered so `cn`'s tailwind-merge resolves the background conflicts: the band
                // first, then the recommendation over it, then the approval over that — the
                // checker's decision outranks the engine's opinion, and the model lets one cell
                // carry both.
                const tints = cn(recommended && RECOMMENDED_TINT, approved && APPROVED_TINT);

                return (
                  <TableRow
                    key={cell.key}
                    data-testid={`offer-row-${cell.key}`}
                    className={cn(
                      groupIndex % 2 === 1 && GROUP_BAND,
                      isFirstInGroup && groupIndex > 0 && GROUP_TOP_RULE,
                      // Last, so `cn`'s tailwind-merge resolves the background conflict in favour of
                      // the recommendation/approval rather than the band.
                      tints,
                    )}
                  >
                    <TableCell className={cn("px-3 py-2", tints)}>
                      {/* S5.9.5 (D7) — a pending forwarder's variant slot: `NOT_QUOTED_LABEL`, no
                          button, and no `offer-header-` testid (that id is the charge-breakdown
                          affordance's, and there is nothing to break down). Its own `pending-cell-`
                          id matches the columns view's, so Task 10's tests key off one contract in
                          both orientations. */}
                      {cell.kind === "pending" ? (
                        <div
                          data-testid={`pending-cell-${cell.key}`}
                          className="px-1 py-0.5 text-xs font-medium text-muted-foreground"
                        >
                          {NOT_QUOTED_LABEL}
                        </div>
                      ) : /* Same guard as the columns header: an unpriced offer has nothing to
                             expand (see ComparisonGridColumns's doc comment) — no click affordance
                             at all. */
                      cell.offer.priced ? (
                        <button
                          type="button"
                          data-testid={`offer-header-${cell.key}`}
                          aria-expanded={selectedOfferKey === cell.key}
                          onClick={() => onOpenBreakdown(cell)}
                          className="w-fit rounded px-1 py-0.5 text-left text-xs font-medium hover:bg-muted/50"
                        >
                          {cell.offer.variant ? rateVariantLabel(cell.offer.variant) : "—"}
                          <OfferMarks cell={cell} recommendedReason={model.recommendedReason} />
                        </button>
                      ) : (
                        <div
                          data-testid={`offer-header-${cell.key}`}
                          className="px-1 py-0.5 text-xs font-medium text-muted-foreground"
                        >
                          {cell.offer.variant ? rateVariantLabel(cell.offer.variant) : "—"}
                          <OfferMarks cell={cell} recommendedReason={model.recommendedReason} />
                        </div>
                      )}
                    </TableCell>
                    {METRICS.map((metric) => (
                      <TableCell
                        key={metric.id}
                        data-testid={`${METRIC_TESTID[metric.id]}-${cell.key}`}
                        className={cn(
                          "px-3 py-2",
                          METRIC_CELL_CLASS[metric.id],
                          METRIC_ALIGN.rows,
                          tints,
                        )}
                      >
                        {/* S5.9.5 (D7) — see the columns view's identical guard: `metric.render` is
                            typed against `OfferCell` alone, and a pending cell has nothing to
                            measure. */}
                        {cell.kind === "pending" ? "—" : metric.render(cell)}
                      </TableCell>
                    ))}
                    <TableCell
                      data-testid={`offer-status-${cell.key}`}
                      className={cn("px-3 py-2 text-center", tints)}
                    >
                      <div className="flex flex-wrap items-center justify-center gap-1">
                        {/* S5.9.2 Q4 (PO ruling) — same removal as `ComparisonGridColumns.tsx`'s
                            identical block: `ForwarderStatusBadge` already reads "RFQ-Resent" for
                            a `REQUOTED` offer, so the second `STALE_OFFER_LABEL` badge here just
                            duplicated it.
                            S5.9.5 (D7) — and a pending cell reads its own `forwarder.quoteStatus`;
                            see `ComparisonGridColumns.tsx`'s identical block for why that is what
                            lets `NOT_QUOTED_LABEL` avoid being a status name. */}
                        <ForwarderStatusBadge
                          status={
                            cell.kind === "pending"
                              ? cell.forwarder.quoteStatus
                              : cell.offer.quoteStatus
                          }
                        />
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
