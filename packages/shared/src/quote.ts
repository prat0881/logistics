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

// ── QuoteDraft: the single engine input (server-authoritative + client-live, §6.3) ──
export interface QuoteDraftCargo {
  cargoItemId: string;
  grossWtT: number;       // TONNES (caller converts the manifest's grossWt kg → /1000)
  cbm: number;            // m³
  isDangerous: boolean;
  freightDensity: number | null; // kg/CBM (seeded from FreightDensityFactor, editable)
}
export interface QuoteDraftCharge {
  zone: ChargeZone | null; definitionKey?: string | null; presetKey: string | null; label: string; amount: number | null; note?: string;
}
export interface QuoteDraftTrucking {
  legEndpointPointId: string; truckingType: TruckingType; basis: TruckingBasis; amount: number | null; remarks?: string;
}
export interface QuoteDraftWarehouse {
  warehousePointId: string; position: WarehousePosition; label: string; amount: number | null; cargoAcceptanceWindow?: string;
}
export interface QuoteDraftTransit {
  departureDate: string | null; arrivalDate: string | null;
  carrier?: string | null; flightVoyageNo?: string | null; carrierSurcharge?: number | null; guaranteedTransitDays?: number | null;
}
export interface QuoteDraft {
  legId: string;
  mode: FreightMode | null;
  currency: string | null;
  quoteValidityUntil: string | null; // ISO
  cargo: QuoteDraftCargo[];
  charges: QuoteDraftCharge[];        // Air/Sea zone lines
  trucking: QuoteDraftTrucking[];     // Road blocks
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
