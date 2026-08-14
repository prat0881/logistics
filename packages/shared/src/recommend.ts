import type { Priority } from "./query";
import {
  SEA_VARIANT_KEY,
  AIR_VARIANT_KEY,
  type ChargeRateVariant,
  type TransitVariantKey,
} from "./quote";
import type { FreightMode } from "./config";

/** Which `guaranteedTransitDaysByVariant` key an (FF × freight-variant) offer reads its transit
 *  from: Road keys per-variant (Dedicated/Groupage differ); Sea collapses FCL/LCL to one common
 *  value; Air (or an unresolved mode) uses its single key. Mirrors `variantsForTransit`. */
export function transitKeyForVariant(
  mode: FreightMode | null,
  variant: ChargeRateVariant | null,
): TransitVariantKey {
  if (mode === "ROAD") return (variant ?? AIR_VARIANT_KEY) as TransitVariantKey; // DEDICATED | GROUPAGE
  if (mode === "SEA") return SEA_VARIANT_KEY;
  return AIR_VARIANT_KEY;
}

export interface RecommendOffer {
  quoteId: string;
  variant: ChargeRateVariant | null;
  usdTotal: number | null; // null = no FX rate → excluded from ranking
  transitDays: number | null; // null → excluded from ranking
  submittedAt: string; // ISO — final deterministic tie-break
}
export interface RecommendResult {
  quoteId: string;
  variant: ChargeRateVariant | null;
}

/**
 * Per-leg recommendation over `(FF × variant)` offers (design §7/D4). HIGH/URGENT → fastest
 * transit, tie→lower USD, tie→earliest submit. MEDIUM/LOW → lowest USD, tie→faster transit,
 * tie→earliest submit. Offers missing a USD total (no FX rate) or transit days are excluded.
 * Returns `null` when nothing is rankable. Pure — no IO, no `Date.now()`.
 */
export function recommendOffer(input: { priority: Priority; offers: RecommendOffer[] }): RecommendResult | null {
  const rankable = input.offers.filter((o) => o.usdTotal != null && o.transitDays != null);
  if (rankable.length === 0) return null;
  const speedFirst = input.priority === "HIGH" || input.priority === "URGENT";
  const sorted = [...rankable].sort((a, b) => {
    const price = a.usdTotal! - b.usdTotal!;
    const transit = a.transitDays! - b.transitDays!;
    const submit = a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0;
    return speedFirst ? transit || price || submit : price || transit || submit;
  });
  const best = sorted[0];
  return { quoteId: best.quoteId, variant: best.variant };
}
