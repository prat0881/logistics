import { useState } from "react";
import type { OfferDto } from "@svyft/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/dates";
import { fmtNative, fmtUsd } from "./money";
import { buildChargeTree, type ChargeNode } from "./chargeTree";

export interface ChargeBreakdownDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offer: OfferDto;
  /** e.g. "L1 · Chennai → Mumbai" — identifies which leg this offer belongs to, since the dialog
   *  itself carries no leg context of its own. */
  legLabel: string;
  /** `ComparisonDto.fxAsOf` (query-level), threaded down from `CompareQuotesPage` through
   *  `CompareLegPanel` — this component has no query-level data of its own. */
  fxAsOf: string | null;
}

/**
 * ChargeBreakdownDialog — the click-FF-header-to-inspect itemised breakdown (S5.6 §11/§12,
 * replatformed onto a modal in S5.7 T3). Replaces the inline itemised-breakdown block that used to
 * sit below the grid; one offer per dialog (the coordinator explicitly ruled out a side-by-side
 * two-forwarder view).
 *
 * Carries over both of the previous inline block's regression-tested guards verbatim:
 *
 * 1. `!offer.priced` short-circuits to a "Not priced by this forwarder" state BEFORE any total or
 *    charge line renders. `buildCharges` unconditionally emits real (not empty) "Additional
 *    Charges"/"Warehousing" lines even for an unpriced offer — so `charges.length === 0` is NOT a
 *    substitute for checking `priced` directly; a real unpriced offer's two zero-valued lines
 *    would otherwise sum into a fake-looking $0.00 total, the exact anti-pattern the grid's own
 *    greying already guards against.
 * 2. The total row renders the offer's own authoritative `usdTotal`, NEVER a sum of the charge
 *    lines' `usdAmount` — per-line rounding can leave the sum a cent off `usdTotal` on a
 *    foreign-currency leg (T1 review Minor #1).
 */
export function ChargeBreakdownDialog({
  open,
  onOpenChange,
  offer,
  legLabel,
  fxAsOf,
}: ChargeBreakdownDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {offer.freightForwarderName} — {offer.variantLabel}
          </DialogTitle>
          <DialogDescription>{legLabel}</DialogDescription>
        </DialogHeader>

        {!offer.priced ? (
          <p className="text-sm text-muted-foreground">Not priced by this forwarder.</p>
        ) : (
          <div className="space-y-3">
            <ChargeTreeTable nodes={buildChargeTree(offer.charges)} currency={offer.currency} />

            <div
              data-testid="charge-total"
              className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm font-semibold"
            >
              <span>Total</span>
              <span className="font-mono tabular-nums">{fmtUsd(offer.usdTotal)}</span>
            </div>

            {offer.unitsPerUsd != null && (
              <p className="text-xs text-muted-foreground">
                Converted at {offer.unitsPerUsd.toFixed(5)} {offer.currency} per USD · FX as of{" "}
                {formatDateTime(fxAsOf)}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export interface ChargeTreeTableProps {
  nodes: ChargeNode[];
  currency: string;
}

/**
 * ChargeTreeTable — pure rendering of a `ChargeNode[]` forest, extracted so it can be unit-tested
 * directly against a hand-built tree (see `ChargeBreakdownDialog.test.tsx`'s `ChargeTreeTable`
 * suite). `buildChargeTree` can only ever produce `children: []` today (see chargeTree.ts's doc
 * comment) — nothing in production reaches the caret/nested-row branch below. It stays anyway,
 * tree-shaped from the start: a future itemised read model only has to change `buildChargeTree`'s
 * mapping, not this component.
 */
export function ChargeTreeTable({ nodes, currency }: ChargeTreeTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Charge</TableHead>
          <TableHead className="text-right">Native</TableHead>
          <TableHead className="text-right">USD</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {nodes.map((node) => (
          <ChargeTreeRow key={node.id} node={node} depth={0} currency={currency} />
        ))}
      </TableBody>
    </Table>
  );
}

function ChargeTreeRow({
  node,
  depth,
  currency,
}: {
  node: ChargeNode;
  depth: number;
  currency: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <TableRow>
        <TableCell style={{ paddingLeft: `${depth * 1.25 + 0.75}rem` }}>
          <span className="flex items-center gap-1.5">
            {hasChildren ? (
              <button
                type="button"
                data-testid={`charge-toggle-${node.id}`}
                aria-expanded={expanded}
                aria-label={expanded ? `Collapse ${node.label}` : `Expand ${node.label}`}
                onClick={() => setExpanded((e) => !e)}
                className="rounded p-0.5 hover:bg-muted"
              >
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
            ) : (
              // Keeps leaf rows aligned with rows that DO have a caret, without rendering a
              // control that does nothing (ambiguity resolution #2 — no dead affordance).
              <span className="inline-block h-3.5 w-3.5" aria-hidden="true" />
            )}
            {node.label}
          </span>
        </TableCell>
        <TableCell className="text-right font-mono tabular-nums">
          {fmtNative(node.nativeAmount, currency)}
        </TableCell>
        <TableCell className="text-right font-mono tabular-nums">
          {node.usdAmount == null ? "—" : fmtUsd(node.usdAmount)}
        </TableCell>
      </TableRow>
      {hasChildren &&
        expanded &&
        node.children.map((child) => (
          <ChargeTreeRow key={child.id} node={child} depth={depth + 1} currency={currency} />
        ))}
    </>
  );
}
