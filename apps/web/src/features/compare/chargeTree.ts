import type { OfferChargeLineDto } from "@svyft/shared";

/**
 * ChargeNode — the tree-shaped charge-breakdown row (S5.7 T3). `children` is ALWAYS present, never
 * `undefined`, and today it is always `[]`: `comparison.service.ts`'s `buildCharges` emits at most
 * three FLAT aggregate lines per offer (Freight / Additional Charges / Warehousing — the last two
 * are each a single sum over many origin/destination/ad-hoc or warehouse rows; see the design's
 * C2). The itemised detail behind those sums lives in each quote's `draftJson` but is collapsed by
 * `computeQuoteTotals` before it reaches the browser, and this task is FRONTEND ONLY — it cannot
 * add a backend read model to un-collapse it.
 *
 * The shape is tree-first anyway, on purpose: when a future read model supplies real itemised
 * lines, only `buildChargeTree`'s mapping changes below — `ChargeBreakdownDialog`'s rendering
 * (which already branches on `children.length > 0`) does not.
 */
export interface ChargeNode {
  id: string;
  label: string;
  nativeAmount: number;
  usdAmount: number | null;
  children: ChargeNode[];
}

/**
 * buildChargeTree — maps `OfferDto.charges` (the flat aggregate lines) 1:1 onto top-level
 * `ChargeNode`s. Order is preserved exactly as the API returns it (Freight, then Additional
 * Charges, then Warehousing — see `buildCharges`), and `id` is derived from `group` + index so it
 * stays stable across renders without needing a real per-line identifier the API doesn't supply.
 */
export function buildChargeTree(lines: OfferChargeLineDto[]): ChargeNode[] {
  return lines.map((l, i) => ({
    id: `${l.group}-${i}`,
    label: l.label,
    nativeAmount: l.nativeAmount,
    usdAmount: l.usdAmount,
    children: [],
  }));
}
