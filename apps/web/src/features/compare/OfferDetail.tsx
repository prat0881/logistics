import type { OfferDto } from "@svyft/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtNative, fmtUsd } from "./money";

export interface OfferDetailProps {
  offer: OfferDto;
}

/**
 * OfferDetail — the click-FF-to-expand itemised breakdown (S5.6 §11/§12): one row per
 * `offer.charges` line (COARSE — freight/additional/warehouse; see comparison.service.ts's
 * `buildCharges`, not a zone-level split), native + USD per line.
 *
 * ⚠ An UNPRICED offer (`priced === false`) short-circuits to a "not priced" message instead of the
 * charges table. `buildCharges` unconditionally emits "Additional Charges" + "Warehousing" lines
 * (only "Freight" is conditional) — so an unpriced offer's `charges` is NEVER `[]`, it's two real-
 * looking $0.00 lines that would otherwise sum to a $0.00 total reading as "we quoted zero," the
 * exact anti-pattern the grid's own `NaCell` greying guards against. `ComparisonGrid` also refuses
 * to wire the click affordance for an unpriced offer's header (belt + suspenders) — this component
 * defends independently in case it's ever handed one another way.
 *
 * ⚠ For a priced offer, the total row renders its own authoritative `usdTotal` — it deliberately
 * does NOT sum the lines' `usdAmount` (T1 review Minor #1: each line's USD is independently
 * rounded, so on a foreign-currency leg Σ usdAmount can differ from usdTotal by a cent;
 * `nativeTotal` reconciles exactly with Σ nativeAmount by construction, but usdTotal is still the
 * one the maker/checker workflow acts on).
 */
export function OfferDetail({ offer }: OfferDetailProps) {
  if (!offer.priced) {
    return (
      <div className="rounded-md border border-border bg-card p-3">
        <h4 className="mb-2 text-sm font-semibold text-foreground">
          {offer.freightForwarderName} — {offer.variantLabel}
        </h4>
        <p className="text-sm text-muted-foreground">Not priced by this forwarder.</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <h4 className="mb-2 text-sm font-semibold text-foreground">
        {offer.freightForwarderName} — {offer.variantLabel} charges
      </h4>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Charge</TableHead>
            <TableHead className="text-right">Native</TableHead>
            <TableHead className="text-right">USD</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {offer.charges.map((c, i) => (
            <TableRow key={`${c.group}-${i}`}>
              <TableCell>{c.label}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {fmtNative(c.nativeAmount, offer.currency)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {c.usdAmount == null ? "—" : fmtUsd(c.usdAmount)}
              </TableCell>
            </TableRow>
          ))}
          <TableRow className="bg-muted/40 font-semibold">
            <TableCell>Total</TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {fmtNative(offer.nativeTotal, offer.currency)}
            </TableCell>
            <TableCell
              data-testid="offer-detail-total-usd"
              className="text-right font-mono tabular-nums"
            >
              {fmtUsd(offer.usdTotal)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
