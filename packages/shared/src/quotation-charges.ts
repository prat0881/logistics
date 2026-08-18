import {
  containerSizeLabel,
  rateVariantLabel,
  truckTonnageLabel,
  type ChargeRateVariant,
  type QuoteDraft,
  type TruckingBasis,
} from "./quote";
import { effectiveChargeAmount } from "./quote-engine";

export type ChargeGroupKey = "ORIGIN" | "FREIGHT" | "DESTINATION" | "WAREHOUSE";

export interface QuotationCostLine {
  id: string; // stable within a leg: `${group}:${index}`
  group: ChargeGroupKey;
  label: string;
  note?: string;
  costNative: number;
  costUsd: number;
}

export interface QuotationCostGroup {
  group: ChargeGroupKey;
  label: string;
  lines: QuotationCostLine[];
  costUsd: number;
}

const GROUP_ORDER: ChargeGroupKey[] = ["ORIGIN", "FREIGHT", "DESTINATION", "WAREHOUSE"];

const GROUP_LABELS: Record<ChargeGroupKey, string> = {
  ORIGIN: "Origin charges",
  FREIGHT: "Freight",
  DESTINATION: "Destination charges",
  WAREHOUSE: "Warehouse",
};

const TRUCKING_BASIS_LABELS: Record<TruckingBasis, string> = {
  PER_TRUCK: "Per truck",
  PER_CBM: "Per CBM",
  PER_TON: "Per ton",
  FIXED: "Fixed",
};

/** `"DEDICATED"` -> `"Dedicated"`, `"PER_TRUCK"` -> `"Per truck"`. Used for `TruckingType` (which
 *  has no label map of its own) and as a fallback for values outside the known label maps above. */
function humanize(raw: string): string {
  const lower = raw.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function buildQuotationCostLines(
  draft: QuoteDraft,
  variant: ChargeRateVariant | null,
  currency: string | null,
  unitsPerUsd: number | null,
): QuotationCostGroup[] {
  const needsConversion = currency != null && currency !== "USD";
  // Final review MINOR #10 — a non-USD leg with no usable FX rate used to price EVERY line at
  // `0`, i.e. a silent "this shipment costs us nothing" on the one read path a client price is
  // marked up from. Unreachable in practice (award check A7 409s a leg whose currency has no FX
  // rate long before a quotation can be built off it), but a money path must fail loudly rather
  // than quietly produce a wrong number if that ever stops holding. Checked once, up front, so
  // the failure can't depend on which line happens to be converted first.
  if (needsConversion && !(unitsPerUsd != null && unitsPerUsd > 0)) {
    throw new Error(`cannot price a ${currency} leg: no usable FX rate (unitsPerUsd=${unitsPerUsd})`);
  }
  const usd = (native: number): number =>
    needsConversion ? round2(native / (unitsPerUsd as number)) : round2(native);

  const linesByGroup: Record<ChargeGroupKey, QuotationCostLine[]> = {
    ORIGIN: [],
    FREIGHT: [],
    DESTINATION: [],
    WAREHOUSE: [],
  };

  const push = (group: ChargeGroupKey, label: string, amount: number | null, note?: string): void => {
    const costNative = amount ?? 0;
    const lines = linesByGroup[group];
    lines.push({
      id: `${group}:${lines.length}`,
      group,
      label,
      ...(note != null ? { note } : {}),
      costNative,
      costUsd: usd(costNative),
    });
  };

  for (const charge of draft.charges) {
    // 🔴 Final review CRITICAL #1 — NOT `charge.amount`. A HEAVY_WEIGHT_CALC line's `amount` is
    // null BY CONSTRUCTION: its value is derived from the three calc inputs. Reading the raw
    // column priced every excess-weight surcharge at $0.00 here, which made the quotation's leg
    // cost fall BELOW the awarded cost and marked the client's price up from the wrong base —
    // silently, since nothing reconciles this against `awardSnapshot.combinedUsd`.
    // `effectiveChargeAmount` is the same fold `computeQuoteTotals` (and therefore every S5.4
    // figure, including `awardSnapshot.usdTotal`) applies — one source of truth, no drift.
    const amount = effectiveChargeAmount(charge);
    if (charge.zone === "ORIGIN") push("ORIGIN", charge.label, amount, charge.note);
    else if (charge.zone === "DESTINATION") push("DESTINATION", charge.label, amount, charge.note);
    else push("FREIGHT", charge.label, amount, charge.note); // MAIN_FREIGHT, or null = ad-hoc
  }

  for (const t of draft.trucking) {
    if (t.rateVariant !== variant) continue;
    const basisLabel = TRUCKING_BASIS_LABELS[t.basis] ?? humanize(t.basis);
    const tonnageSuffix = t.tonnage ? `, ${truckTonnageLabel(t.tonnage)}` : "";
    push("FREIGHT", `${humanize(t.truckingType)} trucking (${basisLabel})${tonnageSuffix}`, t.amount, t.remarks);
  }

  for (const s of draft.seaRates) {
    if (s.rateVariant !== variant) continue;
    const sizeSuffix = s.containerSize ? ` (${containerSizeLabel(s.containerSize)})` : "";
    push("FREIGHT", `${rateVariantLabel(s.rateVariant)} freight${sizeSuffix}`, s.amount, s.remarks);
  }

  for (const w of draft.warehouse) {
    push("WAREHOUSE", w.label, w.amount);
  }

  const groups: QuotationCostGroup[] = [];
  for (const group of GROUP_ORDER) {
    const lines = linesByGroup[group];
    if (lines.length === 0) continue;
    groups.push({
      group,
      label: GROUP_LABELS[group],
      lines,
      costUsd: round2(lines.reduce((sum, l) => sum + l.costUsd, 0)),
    });
  }
  return groups;
}
