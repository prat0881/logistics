import type { QuoteDraft } from "@svyft/shared";
import { computeQuoteTotals } from "@svyft/shared";
import { fmtAmount } from "./format";

const VARIANT_LABELS: Record<string, string> = {
  DEDICATED: "Dedicated", GROUPAGE: "Groupage", FCL: "FCL", LCL: "LCL", AIR: "Air",
};

export function QuoteSummary({ draft, currency }: { draft: QuoteDraft; currency: string | null }): JSX.Element {
  const totals = computeQuoteTotals(draft);
  return (
    <dl className="space-y-2 text-sm">
      <div className="flex justify-between">
        <dt className="text-muted-foreground">Shared subtotal</dt>
        <dd className="font-mono tabular-nums">{fmtAmount(totals.sharedSubtotal)}</dd>
      </div>
      <div className="flex justify-between" data-testid="total-chargeable">
        <dt className="text-muted-foreground">Chargeable weight (kg)</dt>
        <dd className="font-mono tabular-nums">{totals.chargeableWeightKg.toFixed(3)}</dd>
      </div>
      <div className="border-t pt-2 mt-2 space-y-2">
        {totals.variants.map((v) => {
          const blank = v.rateAmount == null && v.key !== "AIR";
          return (
            <div key={v.key} className="flex justify-between" data-testid={`grand-total-${v.key}`}>
              <dt className="font-display font-semibold">{VARIANT_LABELS[v.key] ?? v.key} total</dt>
              <dd className="font-mono tabular-nums text-lg font-bold">
                {blank ? "–" : <>{fmtAmount(v.grandTotal)}{currency && <span className="ml-1 text-sm font-normal">{currency}</span>}</>}
              </dd>
            </div>
          );
        })}
      </div>
    </dl>
  );
}
