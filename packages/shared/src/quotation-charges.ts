import {
  containerSizeLabel,
  rateVariantLabel,
  truckTonnageLabel,
  type ChargeRateVariant,
  type QuoteDraft,
  type TruckingBasis,
} from "./quote";

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

/** `"PER_TRIP"` -> `"Per trip"`, `"PICKUP"` -> `"Pickup"`. Used as a fallback for values outside
 *  the known label maps above (e.g. a trucking sub-type not yet given its own label). */
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
  const usd = (native: number): number =>
    currency == null || currency === "USD"
      ? round2(native)
      : round2(unitsPerUsd && unitsPerUsd > 0 ? native / unitsPerUsd : 0);

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
    if (charge.zone === "ORIGIN") push("ORIGIN", charge.label, charge.amount, charge.note);
    else if (charge.zone === "DESTINATION") push("DESTINATION", charge.label, charge.amount, charge.note);
    else push("FREIGHT", charge.label, charge.amount, charge.note); // MAIN_FREIGHT, or null = ad-hoc
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
