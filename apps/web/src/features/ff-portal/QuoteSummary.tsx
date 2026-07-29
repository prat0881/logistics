import type { QuoteDraft } from "@svyft/shared";
import { computeQuoteTotals } from "@svyft/shared";
import { fmtAmount, fmtWeight } from "./format";

export function QuoteSummary({
  draft,
  currency,
}: {
  draft: QuoteDraft;
  currency: string | null;
}): JSX.Element {
  const totals = computeQuoteTotals(draft);
  const hasCharges = draft.charges.length > 0;
  const hasTrucking = draft.trucking.length > 0;
  const hasWarehouse = draft.warehouse.length > 0;

  return (
    <dl className="space-y-2 text-sm">
      {hasCharges && (
        <>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Origin subtotal</dt>
            <dd className="font-mono tabular-nums">{fmtAmount(totals.zoneSubtotals.origin)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Main freight subtotal</dt>
            <dd className="font-mono tabular-nums">{fmtAmount(totals.zoneSubtotals.mainFreight)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Destination subtotal</dt>
            <dd className="font-mono tabular-nums">{fmtAmount(totals.zoneSubtotals.destination)}</dd>
          </div>
        </>
      )}
      {hasTrucking && (
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Trucking subtotal</dt>
          <dd className="font-mono tabular-nums">{fmtAmount(totals.truckingSubtotal)}</dd>
        </div>
      )}
      {hasWarehouse && (
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Warehouse subtotal</dt>
          <dd className="font-mono tabular-nums">{fmtAmount(totals.warehouseSubtotal)}</dd>
        </div>
      )}
      <div className="flex justify-between" data-testid="total-chargeable">
        <dt className="text-muted-foreground">Total chargeable weight (t)</dt>
        <dd className="font-mono tabular-nums">{fmtWeight(totals.totalChargeableWeightT)}</dd>
      </div>
      <div
        className="flex justify-between border-t pt-2 mt-2"
        data-testid="grand-total"
      >
        <dt className="font-display font-semibold">Grand total</dt>
        <dd className="font-mono tabular-nums text-lg font-bold">
          {fmtAmount(totals.grandTotal)}
          {currency && <span className="ml-1 text-sm font-normal">{currency}</span>}
        </dd>
      </div>
    </dl>
  );
}
