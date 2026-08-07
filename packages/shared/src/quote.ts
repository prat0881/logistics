import type { FreightMode } from "./config";

export const ChargeZone = {
  ORIGIN: "ORIGIN",
  MAIN_FREIGHT: "MAIN_FREIGHT",
  DESTINATION: "DESTINATION",
} as const;
export type ChargeZone = (typeof ChargeZone)[keyof typeof ChargeZone];
export const CHARGE_ZONES = Object.values(ChargeZone) as [ChargeZone, ...ChargeZone[]];

export const TruckingType = { DEDICATED: "DEDICATED", GROUPAGE: "GROUPAGE" } as const;
export type TruckingType = (typeof TruckingType)[keyof typeof TruckingType];
export const TRUCKING_TYPES = Object.values(TruckingType) as [TruckingType, ...TruckingType[]];

export const TruckingBasis = {
  PER_TRUCK: "PER_TRUCK",
  PER_CBM: "PER_CBM",
  PER_TON: "PER_TON",
  FIXED: "FIXED",
} as const;
export type TruckingBasis = (typeof TruckingBasis)[keyof typeof TruckingBasis];
export const TRUCKING_BASES = Object.values(TruckingBasis) as [TruckingBasis, ...TruckingBasis[]];

export const WarehousePosition = { ORIGIN: "ORIGIN", DESTINATION: "DESTINATION" } as const;
export type WarehousePosition = (typeof WarehousePosition)[keyof typeof WarehousePosition];
export const WAREHOUSE_POSITIONS = Object.values(WarehousePosition) as [
  WarehousePosition,
  ...WarehousePosition[],
];

// ── v2 dual-rate / calc option-sets (design §7) ──
export const ChargeRateVariant = {
  DEDICATED: "DEDICATED",
  GROUPAGE: "GROUPAGE",
  FCL: "FCL",
  LCL: "LCL",
} as const;
export type ChargeRateVariant = (typeof ChargeRateVariant)[keyof typeof ChargeRateVariant];
export const CHARGE_RATE_VARIANTS = Object.values(ChargeRateVariant) as [
  ChargeRateVariant,
  ...ChargeRateVariant[],
];

export const TruckTonnage = {
  T_1: "T_1",
  T_2: "T_2",
  T_3_5: "T_3_5",
  T_5: "T_5",
  T_7: "T_7",
  T_9: "T_9",
  T_12: "T_12",
  T_16: "T_16",
  T_20: "T_20",
  T_25: "T_25",
  TRAILER_30_40T: "TRAILER_30_40T",
} as const;
export type TruckTonnage = (typeof TruckTonnage)[keyof typeof TruckTonnage];
export const TRUCK_TONNAGES = Object.values(TruckTonnage) as [TruckTonnage, ...TruckTonnage[]];
const TRUCK_TONNAGE_LABELS: Record<TruckTonnage, string> = {
  T_1: "1 T",
  T_2: "2 T",
  T_3_5: "3.5 T",
  T_5: "5 T",
  T_7: "7 T",
  T_9: "9 T",
  T_12: "12 T",
  T_16: "16 T",
  T_20: "20 T",
  T_25: "25 T",
  TRAILER_30_40T: "Trailer 30–40 T",
};
export function truckTonnageLabel(t: TruckTonnage): string {
  return TRUCK_TONNAGE_LABELS[t] ?? t;
}

export const ContainerSize = {
  TWENTY: "TWENTY",
  FORTY: "FORTY",
  FORTY_FIVE_HC: "FORTY_FIVE_HC",
} as const;
export type ContainerSize = (typeof ContainerSize)[keyof typeof ContainerSize];
export const CONTAINER_SIZES = Object.values(ContainerSize) as [ContainerSize, ...ContainerSize[]];
const CONTAINER_SIZE_LABELS: Record<ContainerSize, string> = {
  TWENTY: `20'`,
  FORTY: `40'`,
  FORTY_FIVE_HC: `45' HC`,
};
export function containerSizeLabel(c: ContainerSize): string {
  return CONTAINER_SIZE_LABELS[c] ?? c;
}

const CHARGE_RATE_VARIANT_LABELS: Record<ChargeRateVariant, string> = {
  DEDICATED: "Dedicated",
  GROUPAGE: "Groupage",
  FCL: "FCL",
  LCL: "LCL",
};
export function rateVariantLabel(v: ChargeRateVariant): string {
  return CHARGE_RATE_VARIANT_LABELS[v] ?? v;
}

export const BillOfLadingType = { ORIGINAL: "ORIGINAL", TELEX: "TELEX" } as const;
export type BillOfLadingType = (typeof BillOfLadingType)[keyof typeof BillOfLadingType];
export const BILL_OF_LADING_TYPES = Object.values(BillOfLadingType) as [
  BillOfLadingType,
  ...BillOfLadingType[],
];

export const WarehouseSide = { DROP: "DROP", PICKUP: "PICKUP" } as const;
export type WarehouseSide = (typeof WarehouseSide)[keyof typeof WarehouseSide];
export const WAREHOUSE_SIDES = Object.values(WarehouseSide) as [WarehouseSide, ...WarehouseSide[]];

// ── QuoteDraft: the single engine input (server-authoritative + client-live, §6.3) ──
export interface QuoteDraftCargo {
  packageId: string;
  grossWtKg: number; // display only (canonical kg from the manifest)
  cbm: number; // m³ (display only)
}
export interface QuoteDraftCharge {
  zone: ChargeZone | null;
  definitionKey?: string | null;
  presetKey: string | null;
  label: string;
  amount: number | null;
  rateVariant: ChargeRateVariant | null; // v3: which column this cell prices; null = single-column/Air or a non-variant line
  note?: string;
  billOfLadingType?: BillOfLadingType | null; // Sea B/L line
  pieceWeightKg?: number | null; // HEAVY_WEIGHT_CALC inputs
  airlineLimitKg?: number | null;
  ratePerExcessKg?: number | null;
}
export interface QuoteDraftTrucking {
  legEndpointPointId: string;
  truckingType: TruckingType;
  basis: TruckingBasis;
  amount: number | null;
  remarks?: string;
  rateVariant: ChargeRateVariant; // DEDICATED | GROUPAGE
  tonnage: TruckTonnage | null; // Dedicated only
}
export interface QuoteDraftSeaRate {
  rateVariant: ChargeRateVariant; // FCL | LCL
  containerSize: ContainerSize | null; // FCL only
  amount: number | null;
  remarks?: string;
}
export interface QuoteDraftWarehouse {
  warehousePointId: string;
  position: WarehousePosition;
  label: string;
  amount: number | null;
  cargoAcceptanceWindow?: string;
  cfsCode?: string | null;
  side?: WarehouseSide | null;
}
export interface QuoteDraftTransit {
  departureDate: string | null;
  arrivalDate: string | null;
  carrier?: string | null;
  flightVoyageNo?: string | null;
  carrierSurcharge?: number | null;
  // v3: one Guaranteed Transit Time per rate variant (design §3.1/D3), keyed by ChargeRateVariant.
  // Air has a single implicit column — see AIR_VARIANT_KEY (ChargeRateVariant has no AIR member;
  // QuoteDraftCharge instead models Air as rateVariant: null — this map still needs a concrete
  // object key, so Air's one slot is addressed via that fixed technical key).
  guaranteedTransitDaysByVariant: Partial<Record<ChargeRateVariant, number>>;
  plannedPickupDate?: string | null; // Road
  airline?: string | null;
  flightNumber?: string | null;
  plannedDeparture?: string | null;
  plannedArrival?: string | null; // Air
  shippingLine?: string | null;
  vesselVoyage?: string | null;
  etd?: string | null;
  eta?: string | null; // Sea
}
export interface QuoteDraft {
  legId: string;
  mode: FreightMode | null;
  currency: string | null;
  quoteValidityUntil: string | null; // ISO
  chargedWeightKg: number | null; // v3: one leg-level chargeable weight (kg), informational (design §3.1/D2)
  notes: string | null; // v3: FF free-text notes (design §3.1, distinct from dgSurchargeNote/termsConditions)
  cargo: QuoteDraftCargo[];
  charges: QuoteDraftCharge[]; // Air/Sea zone lines, now per-variant via QuoteDraftCharge.rateVariant
  trucking: QuoteDraftTrucking[]; // Road blocks
  seaRates: QuoteDraftSeaRate[]; // Sea FCL/LCL rate rows
  warehouse: QuoteDraftWarehouse[];
  transit: QuoteDraftTransit | null;
  dgSurchargeNote: string | null;
  termsConditions: string | null;
}

// ── v3 per-variant columns (design §3.1/D1) ──
// Air has no dual-rate columns to compare — the matrix degrades to a single implicit column.
// `ChargeRateVariant` deliberately stays 4-valued (DEDICATED|GROUPAGE|FCL|LCL): Air's charges use
// `rateVariant: null` (see QuoteDraftCharge) and variantsForMode("AIR") returns [null] rather than
// adding a 5th "AIR" member — QuoteDraftTrucking/QuoteDraftSeaRate's non-nullable
// `rateVariant: ChargeRateVariant` would then structurally (if nonsensically) admit it too.
/** The columns a mode's charge/transit matrix renders, in display order. Road → Dedicated/Groupage,
 *  Sea → FCL/LCL, Air (or an unset mode) → a single implicit column (`null`). */
export function variantsForMode(mode: FreightMode | null): (ChargeRateVariant | null)[] {
  if (mode === "ROAD") return [ChargeRateVariant.DEDICATED, ChargeRateVariant.GROUPAGE];
  if (mode === "SEA") return [ChargeRateVariant.FCL, ChargeRateVariant.LCL];
  return [null]; // AIR, and a not-yet-resolved mode: single column
}

/** Air's fixed technical key into `guaranteedTransitDaysByVariant` (a `Partial<Record<
 *  ChargeRateVariant, number>>`, shared across all modes). Air has exactly one implicit column
 *  (`variantsForMode("AIR") === [null]`) but that map has no `null`-keyable slot, so Air's single
 *  transit-days value is written/read under this constant instead — never compared against a
 *  real Road/Sea variant. Not a `ChargeRateVariant` member (see the file-level note above). */
export const AIR_VARIANT_KEY = "AIR" as ChargeRateVariant;
