import type { FreightMode } from "./config";
import type { ChargeZone } from "./quote";

// Role = when/how a catalogue line is included on the FF portal.
export const ChargeLineRole = {
  CORE: "CORE",           // always shown & priced (Air/Sea Zones 1-2, Road trucking)
  STANDARD: "STANDARD",   // Executive-selected (popover "Standard")
  TAG_DRIVEN: "TAG_DRIVEN", // Executive-selected (popover "Tag-driven"); tagKey inert this build (design §13)
  WAREHOUSE: "WAREHOUSE", // included via the per-leg warehouse toggle, never the popover
} as const;
export type ChargeLineRole = (typeof ChargeLineRole)[keyof typeof ChargeLineRole];
export const CHARGE_LINE_ROLES = Object.values(ChargeLineRole) as [ChargeLineRole, ...ChargeLineRole[]];

// InputType = how the FF prices it / which instance table stores the amount.
export const ChargeLineInputType = {
  PLAIN: "PLAIN",                       // ChargeLine {amount, note}
  TRUCKING: "TRUCKING",                 // TruckingCharge {type, basis, amount, remarks}
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
  zone: ChargeZone | null;   // ORIGIN|MAIN_FREIGHT|DESTINATION for Air/Sea; null for Road
  tagKey: string | null;     // reserved/inert this build (design §13)
  label: string;
  sortOrder: number;
  isActive: boolean;
}

// A resolved PLAIN charge line frozen onto a Quote at distribute (cores + selected).
export interface ResolvedChargeLine {
  definitionKey: string;
  role: ChargeLineRole;
  inputType: ChargeLineInputType;
  zone: ChargeZone | null;
  label: string;
}

// The per-quote frozen snapshot (design §5.4 / §7).
export interface ChargeConfigSnapshot {
  lines: ResolvedChargeLine[];   // all PLAIN, all mandatory-to-price
  warehouseIncluded: boolean;
}

/**
 * Resolve the effective mandatory-to-price PLAIN charge set for a leg at distribute (design §7).
 * CORE lines are always included; STANDARD/TAG_DRIVEN only when their key is selected.
 * TRUCKING/WAREHOUSE_STAGING lines are excluded here — they are priced via the draft's
 * `trucking`/`warehouse` arrays; warehouse presence is governed by `warehouseIncluded`.
 * No tag filtering (design §13: tag-driven activation is deferred).
 */
export function resolveChargeConfig(
  definitions: ChargeLineDefinitionDto[],
  selectedKeys: string[],
  warehouseIncluded: boolean,
): ChargeConfigSnapshot {
  const selected = new Set(selectedKeys);
  const lines: ResolvedChargeLine[] = definitions
    .filter((d) => d.isActive && d.inputType === "PLAIN")
    .filter((d) => d.role === "CORE" || ((d.role === "STANDARD" || d.role === "TAG_DRIVEN") && selected.has(d.key)))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => ({ definitionKey: d.key, role: d.role, inputType: d.inputType, zone: d.zone, label: d.label }));
  return { lines, warehouseIncluded };
}
