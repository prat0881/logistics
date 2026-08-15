/** Small money-formatting helpers for the Compare Quotes screen (S5.6 §12). The grid needs both
 *  a USD figure (`$1,234.56`) and an offer's own native-currency figure (`1,234.56 INR`) — neither
 *  matches `ff-portal/format.ts`'s `fmtAmount` (no `$` prefix, no currency suffix, and that module
 *  is FF-portal-scoped). Kept local to `features/compare/`; promote to a shared util if another
 *  feature ever needs a currency-prefixed/suffixed formatter. */
export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtNative(v: number | null | undefined, currency: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const amount = v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${amount} ${currency}` : amount;
}
