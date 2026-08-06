import type { FreightMode } from "./config";

export const ChargeZone = { ORIGIN: "ORIGIN", MAIN_FREIGHT: "MAIN_FREIGHT", DESTINATION: "DESTINATION" } as const;
export type ChargeZone = (typeof ChargeZone)[keyof typeof ChargeZone];
export const CHARGE_ZONES = Object.values(ChargeZone) as [ChargeZone, ...ChargeZone[]];

export const TruckingType = { DEDICATED: "DEDICATED", GROUPAGE: "GROUPAGE" } as const;
export type TruckingType = (typeof TruckingType)[keyof typeof TruckingType];
export const TRUCKING_TYPES = Object.values(TruckingType) as [TruckingType, ...TruckingType[]];

export const TruckingBasis = { PER_TRUCK: "PER_TRUCK", PER_CBM: "PER_CBM", PER_TON: "PER_TON", FIXED: "FIXED" } as const;
export type TruckingBasis = (typeof TruckingBasis)[keyof typeof TruckingBasis];
export const TRUCKING_BASES = Object.values(TruckingBasis) as [TruckingBasis, ...TruckingBasis[]];

export const WarehousePosition = { ORIGIN: "ORIGIN", DESTINATION: "DESTINATION" } as const;
export type WarehousePosition = (typeof WarehousePosition)[keyof typeof WarehousePosition];
export const WAREHOUSE_POSITIONS = Object.values(WarehousePosition) as [WarehousePosition, ...WarehousePosition[]];

// ── v2 dual-rate / calc option-sets (design §7) ──
export const ChargeRateVariant = { DEDICATED: "DEDICATED", GROUPAGE: "GROUPAGE", FCL: "FCL", LCL: "LCL" } as const;
export type ChargeRateVariant = (typeof ChargeRateVariant)[keyof typeof ChargeRateVariant];
export const CHARGE_RATE_VARIANTS = Object.values(ChargeRateVariant) as [ChargeRateVariant, ...ChargeRateVariant[]];

export const TruckTonnage = {
  T_1: "T_1", T_2: "T_2", T_3_5: "T_3_5", T_5: "T_5", T_7: "T_7", T_9: "T_9",
  T_12: "T_12", T_16: "T_16", T_20: "T_20", T_25: "T_25", TRAILER_30_40T: "TRAILER_30_40T",
} as const;
export type TruckTonnage = (typeof TruckTonnage)[keyof typeof TruckTonnage];
export const TRUCK_TONNAGES = Object.values(TruckTonnage) as [TruckTonnage, ...TruckTonnage[]];
const TRUCK_TONNAGE_LABELS: Record<TruckTonnage, string> = {
  T_1: "1 T", T_2: "2 T", T_3_5: "3.5 T", T_5: "5 T", T_7: "7 T", T_9: "9 T",
  T_12: "12 T", T_16: "16 T", T_20: "20 T", T_25: "25 T", TRAILER_30_40T: "Trailer 30–40 T",
};
export function truckTonnageLabel(t: TruckTonnage): string { return TRUCK_TONNAGE_LABELS[t] ?? t; }

export const ContainerSize = { TWENTY: "TWENTY", FORTY: "FORTY", FORTY_FIVE_HC: "FORTY_FIVE_HC" } as const;
export type ContainerSize = (typeof ContainerSize)[keyof typeof ContainerSize];
export const CONTAINER_SIZES = Object.values(ContainerSize) as [ContainerSize, ...ContainerSize[]];
const CONTAINER_SIZE_LABELS: Record<ContainerSize, string> = {
  TWENTY: `20'`, FORTY: `40'`, FORTY_FIVE_HC: `45' HC`,
};
export function containerSizeLabel(c: ContainerSize): string { return CONTAINER_SIZE_LABELS[c] ?? c; }

const CHARGE_RATE_VARIANT_LABELS: Record<ChargeRateVariant, string> = {
  DEDICATED: "Dedicated", GROUPAGE: "Groupage", FCL: "FCL", LCL: "LCL",
};
export function rateVariantLabel(v: ChargeRateVariant): string { return CHARGE_RATE_VARIANT_LABELS[v] ?? v; }

export const BillOfLadingType = { ORIGINAL: "ORIGINAL", TELEX: "TELEX" } as const;
export type BillOfLadingType = (typeof BillOfLadingType)[keyof typeof BillOfLadingType];
export const BILL_OF_LADING_TYPES = Object.values(BillOfLadingType) as [BillOfLadingType, ...BillOfLadingType[]];

export const WarehouseSide = { DROP: "DROP", PICKUP: "PICKUP" } as const;
export type WarehouseSide = (typeof WarehouseSide)[keyof typeof WarehouseSide];
export const WAREHOUSE_SIDES = Object.values(WarehouseSide) as [WarehouseSide, ...WarehouseSide[]];

// ── QuoteDraft: the single engine input (server-authoritative + client-live, §6.3) ──
export interface QuoteDraftCargo {
  packageId: string;
  grossWtKg: number;             // display only (canonical kg from the manifest)
  cbm: number;                   // m³ (display only)
  chargedWeightKg: number | null; // FF-entered chargeable weight (kg)
}
export interface QuoteDraftCharge {
  zone: ChargeZone | null; definitionKey?: string | null; presetKey: string | null;
  label: string; amount: number | null; note?: string;
  billOfLadingType?: BillOfLadingType | null;            // Sea B/L line
  pieceWeightKg?: number | null;                         // HEAVY_WEIGHT_CALC inputs
  airlineLimitKg?: number | null;
  ratePerExcessKg?: number | null;
}
export interface QuoteDraftTrucking {
  legEndpointPointId: string; truckingType: TruckingType; basis: TruckingBasis;
  amount: number | null; remarks?: string;
  rateVariant: ChargeRateVariant;        // DEDICATED | GROUPAGE
  tonnage: TruckTonnage | null;          // Dedicated only
}
export interface QuoteDraftSeaRate {
  rateVariant: ChargeRateVariant;        // FCL | LCL
  containerSize: ContainerSize | null;   // FCL only
  amount: number | null; remarks?: string;
}
export interface QuoteDraftWarehouse {
  warehousePointId: string; position: WarehousePosition; label: string;
  amount: number | null; cargoAcceptanceWindow?: string;
  cfsCode?: string | null; side?: WarehouseSide | null;
}
export interface QuoteDraftTransit {
  departureDate: string | null; arrivalDate: string | null;
  carrier?: string | null; flightVoyageNo?: string | null;
  carrierSurcharge?: number | null; guaranteedTransitDays: number | null; // now mandatory (gate)
  plannedPickupDate?: string | null;                                       // Road
  airline?: string | null; flightNumber?: string | null; plannedDeparture?: string | null; plannedArrival?: string | null; // Air
  shippingLine?: string | null; vesselVoyage?: string | null; etd?: string | null; eta?: string | null; // Sea
}
export interface QuoteDraft {
  legId: string;
  mode: FreightMode | null;
  currency: string | null;
  quoteValidityUntil: string | null; // ISO
  cargo: QuoteDraftCargo[];
  charges: QuoteDraftCharge[];        // Air/Sea zone lines
  trucking: QuoteDraftTrucking[];     // Road blocks
  seaRates: QuoteDraftSeaRate[];      // Sea FCL/LCL rate rows
  warehouse: QuoteDraftWarehouse[];
  transit: QuoteDraftTransit | null;
  dgSurchargeNote: string | null;
  termsConditions: string | null;
}

// ── Charge-line presets (spec §7.4.3.1 Air / §7.4.3.2 Sea), in display order ──
export interface ChargePreset { zone: ChargeZone; presetKey: string; label: string; }
export const AIR_CHARGE_PRESETS: ChargePreset[] = [
  { zone: "ORIGIN", presetKey: "AIR_ORIGIN_EXPORT_CLEARANCE", label: "Export Customs Clearance" },
  { zone: "ORIGIN", presetKey: "AIR_ORIGIN_DOCUMENTATION", label: "Documentation Charges" },
  { zone: "ORIGIN", presetKey: "AIR_ORIGIN_THC", label: "Origin THC / Airport Handling" },
  { zone: "ORIGIN", presetKey: "AIR_ORIGIN_SECURITY", label: "Security / Screening Charges" },
  { zone: "ORIGIN", presetKey: "AIR_ORIGIN_WAREHOUSE_PRESTORAGE", label: "Warehouse / Pre-storage at OAP" },
  { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_FREIGHT", label: "Air Freight Charges" },
  { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_SEC", label: "Security Exchange (SEC)" },
  { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_CARRIER_SURCHARGE", label: "Airline / Carrier Surcharge" },
  { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_HEAVY_WEIGHT", label: "Heavy Weight Surcharge" },
  { zone: "DESTINATION", presetKey: "AIR_DEST_THC", label: "Destination THC / Airport Handling" },
  { zone: "DESTINATION", presetKey: "AIR_DEST_IMPORT_CLEARANCE", label: "Import Customs Clearance" },
  { zone: "DESTINATION", presetKey: "AIR_DEST_LAST_MILE", label: "Last Mile Handling / Lift Gate" },
  { zone: "DESTINATION", presetKey: "AIR_DEST_STORAGE", label: "Storage 1 Free Day Charges" },
];
export const SEA_CHARGE_PRESETS: ChargePreset[] = [
  { zone: "ORIGIN", presetKey: "SEA_ORIGIN_EXPORT_CLEARANCE", label: "Export Customs Clearance" },
  { zone: "ORIGIN", presetKey: "SEA_ORIGIN_DOCUMENTATION", label: "Documentation Charges" },
  { zone: "ORIGIN", presetKey: "SEA_ORIGIN_THC", label: "Origin THC (Terminal Handling Charge)" },
  { zone: "ORIGIN", presetKey: "SEA_ORIGIN_BILL_OF_LADING", label: "Bill of Lading" },
  { zone: "ORIGIN", presetKey: "SEA_ORIGIN_WAREHOUSE", label: "Warehouse Charges" },
  { zone: "MAIN_FREIGHT", presetKey: "SEA_MAIN_FREIGHT", label: "Sea Freight Charges" },
  { zone: "DESTINATION", presetKey: "SEA_DEST_THC", label: "Destination THC / Handling Charges" },
  { zone: "DESTINATION", presetKey: "SEA_DEST_IMPORT_CLEARANCE", label: "Import Customs Clearance" },
  { zone: "DESTINATION", presetKey: "SEA_DEST_DELIVERY", label: "Delivery (Last Mile — Door to Door)" },
  { zone: "DESTINATION", presetKey: "SEA_DEST_LAST_MILE", label: "Last Mile Handling / Lift Gate" },
  { zone: "DESTINATION", presetKey: "SEA_DEST_STORAGE", label: "Storage 1 Free Day Charges" },
];
