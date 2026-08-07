import type { FreightMode } from "./config";
import type { ChargeZone } from "./quote";
import type { ReferenceTag } from "./cargo";

// Role = when/how a catalogue line is included on the FF portal.
export const ChargeLineRole = {
  CORE: "CORE", // always shown & priced (Air/Sea Zones 1-2, Road trucking)
  STANDARD: "STANDARD", // Executive-selected (popover "Standard")
  TAG_DRIVEN: "TAG_DRIVEN", // Executive-selected (popover "Tag-driven") AND its tagKey must be carried by a package on the leg
  WAREHOUSE: "WAREHOUSE", // included via the per-leg warehouse toggle, never the popover
} as const;
export type ChargeLineRole = (typeof ChargeLineRole)[keyof typeof ChargeLineRole];
export const CHARGE_LINE_ROLES = Object.values(ChargeLineRole) as [
  ChargeLineRole,
  ...ChargeLineRole[],
];

// InputType = how the FF prices it / which instance table stores the amount.
export const ChargeLineInputType = {
  PLAIN: "PLAIN", // ChargeLine {amount, note}
  TRUCKING: "TRUCKING", // TruckingCharge {type, basis, amount, remarks}
  WAREHOUSE_STAGING: "WAREHOUSE_STAGING", // WarehouseStagingLine {amount, cargoAcceptanceWindow}
  HEAVY_WEIGHT_CALC: "HEAVY_WEIGHT_CALC", // QuoteDraftCharge {pieceWeightKg, airlineLimitKg, ratePerExcessKg} → computeHeavyWeightAmount
} as const;
export type ChargeLineInputType = (typeof ChargeLineInputType)[keyof typeof ChargeLineInputType];
export const CHARGE_LINE_INPUT_TYPES = Object.values(ChargeLineInputType) as [
  ChargeLineInputType,
  ...ChargeLineInputType[],
];

// A catalogue row as served to the Executive popover and read at distribute-time resolution.
export interface ChargeLineDefinitionDto {
  id: string;
  key: string;
  mode: FreightMode;
  role: ChargeLineRole;
  inputType: ChargeLineInputType;
  zone: ChargeZone | null; // ORIGIN|MAIN_FREIGHT|DESTINATION for Air/Sea; null for Road
  tagKey: string | null; // TAG_DRIVEN gate key (a ReferenceTag); null for non-TAG_DRIVEN roles
  label: string;
  sortOrder: number;
  isActive: boolean;
}

// A resolved PLAIN/HEAVY_WEIGHT_CALC charge line frozen onto a Quote at distribute (cores + selected).
export interface ResolvedChargeLine {
  definitionKey: string;
  role: ChargeLineRole;
  inputType: ChargeLineInputType;
  zone: ChargeZone | null;
  label: string;
}

// The per-quote frozen snapshot (design §5.4 / §7).
export interface ChargeConfigSnapshot {
  lines: ResolvedChargeLine[]; // PLAIN + HEAVY_WEIGHT_CALC, all mandatory-to-price
  warehouseIncluded: boolean;
}

/**
 * Resolve the effective mandatory-to-price charge set for a leg at distribute (design §7).
 * CORE lines are always included; STANDARD lines only when their key is selected; TAG_DRIVEN
 * lines need BOTH — selected AND their `tagKey` present among `packageTags` (the leg's union of
 * package `effectiveTags`) — the two-gate (design §13). TRUCKING/WAREHOUSE_STAGING lines are
 * excluded here — they are priced via the draft's `trucking`/`warehouse` arrays; warehouse
 * presence is governed by `warehouseIncluded`. `lines` includes PLAIN and HEAVY_WEIGHT_CALC
 * inputTypes (both freeze onto the Quote at distribute; HEAVY_WEIGHT_CALC is priced via
 * computeHeavyWeightAmount rather than a flat amount).
 */
export function resolveChargeConfig(
  definitions: ChargeLineDefinitionDto[],
  selectedKeys: string[],
  warehouseIncluded: boolean,
  packageTags: ReferenceTag[] = [],
): ChargeConfigSnapshot {
  const selected = new Set(selectedKeys);
  const tagSet = new Set<string>(packageTags);
  const lines: ResolvedChargeLine[] = definitions
    .filter((d) => d.isActive && (d.inputType === "PLAIN" || d.inputType === "HEAVY_WEIGHT_CALC"))
    .filter((d) => {
      if (d.role === "CORE") return true;
      if (d.role === "STANDARD") return selected.has(d.key);
      if (d.role === "TAG_DRIVEN")
        return selected.has(d.key) && d.tagKey != null && tagSet.has(d.tagKey);
      return false;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => ({
      definitionKey: d.key,
      role: d.role,
      inputType: d.inputType,
      zone: d.zone,
      label: d.label,
    }));
  return { lines, warehouseIncluded };
}
