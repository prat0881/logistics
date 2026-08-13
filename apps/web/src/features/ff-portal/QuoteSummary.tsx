import type { QuoteDraft, ChargeRateVariant } from "@svyft/shared";
import { computeQuoteTotals, rateVariantLabel } from "@svyft/shared";
import { fmtAmount } from "./format";

export function QuoteSummary({
  draft,
  currency,
}: {
  draft: QuoteDraft;
  currency: string | null;
}): JSX.Element {
  const totals = computeQuoteTotals(draft);
  return (
    <dl className="space-y-2 text-sm">
      {/* v4 (design D1): "Shared subtotal" (warehouse-only, v3) split into the two figures that
          actually feed every variant's Grand total — Additional charges (the COMMON `charges`
          sum ChargeMatrix's own subtotal row shows) and Warehouse — so this headline stays
          consistent with the charge table instead of collapsing them into one unlabeled number. */}
      <div className="flex justify-between" data-testid="total-additional-charges">
        <dt className="text-muted-foreground">Additional charges</dt>
        <dd className="font-mono tabular-nums">{fmtAmount(totals.additionalChargeSum)}</dd>
      </div>
      <div className="flex justify-between" data-testid="total-warehouse">
        <dt className="text-muted-foreground">Warehouse</dt>
        <dd className="font-mono tabular-nums">{fmtAmount(totals.warehouseSum)}</dd>
      </div>
      <div className="flex justify-between" data-testid="total-chargeable">
        <dt className="text-muted-foreground">Chargeable weight (kg)</dt>
        <dd className="font-mono tabular-nums">{totals.chargeableWeightKg.toFixed(3)}</dd>
      </div>
      <div className="border-t pt-2 mt-2 space-y-2">
        {totals.variants.map((v) => {
          // Round 4 (reverses the old "own-rate-only" rule): blank only when NOTHING at all is
          // priced for this variant — no own freight rate, no common charge, no warehouse. Once
          // ANY of those is priced, show the real grandTotal, even if the variant's OWN rate is
          // still unset (mirrors ChargeMatrix/RfqPrintView). Air is excluded from the check the
          // same as before — it has no freight-rate cell at all, so rateAmount is always null.
          const blank =
            v.rateAmount == null &&
            v.key !== "AIR" &&
            totals.additionalChargeSum === 0 &&
            totals.warehouseSum === 0;
          const label = v.key === "AIR" ? "Air" : rateVariantLabel(v.key as ChargeRateVariant);
          return (
            <div key={v.key} className="flex justify-between" data-testid={`grand-total-${v.key}`}>
              <dt className="font-display font-semibold">{label} total</dt>
              <dd className="font-mono tabular-nums text-lg font-bold">
                {blank ? (
                  "–"
                ) : (
                  <>
                    {fmtAmount(v.grandTotal)}
                    {currency && <span className="ml-1 text-sm font-normal">{currency}</span>}
                  </>
                )}
              </dd>
            </div>
          );
        })}
      </div>
    </dl>
  );
}
