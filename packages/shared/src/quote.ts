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
  // v4 (design D1, partially reverses v3): every `charges` row is now COMMON — one row per
  // definitionKey (or one row per ad-hoc [+ Add Charge] custom line), priced ONCE, not once per
  // rate variant. `rateVariant` stays on the shape (mirrors the still-nullable `ChargeLine.
  // rateVariant` DB column 1:1) but is now ALWAYS `null` — narrowed to the literal so writing a
  // real ChargeRateVariant here is a compile error, not a silent v3 regression. Freight is the
  // one exception that STAYS per-variant, but it never lived in this array — Road prices it via
  // `QuoteDraft.trucking`, Sea via `QuoteDraft.seaRates`; Air's freight (AIR_MAIN_FREIGHT) is
  // simply another common charge here, same as any other line.
  rateVariant: null;
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
  // Guaranteed Transit Time, keyed by TransitVariantKey (design §3.1/D2-D3). v4 (partially
  // reverses v3): Road STAYS per-variant — DEDICATED and GROUPAGE can each commit to a different
  // GTT, keyed directly by their ChargeRateVariant. Sea is now COMMON — ONE value covers both
  // FCL/LCL (a ship doesn't arrive twice), written/read under the fixed SEA_VARIANT_KEY sentinel
  // rather than "FCL"/"LCL" individually. Air keeps its v3 single implicit column, under
  // AIR_VARIANT_KEY. Sea/Air's sentinels exist for the same reason: this map needs a concrete,
  // parseable object key (Zod's z.record can't validate a `null` key) even though both modes
  // conceptually have "no real variant" here — see variantsForTransit below, and AIR_VARIANT_KEY/
  // SEA_VARIANT_KEY's own doc comments for the full rationale.
  guaranteedTransitDaysByVariant: Partial<Record<TransitVariantKey, number>>;
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
  charges: QuoteDraftCharge[]; // v4: ONE common row per definitionKey (rateVariant always null) — Air/Road/Sea zone lines, Bill-of-Lading, HEAVY_WEIGHT_CALC, and ad-hoc [+ Add Charge] lines
  trucking: QuoteDraftTrucking[]; // Road blocks
  seaRates: QuoteDraftSeaRate[]; // Sea FCL/LCL rate rows
  warehouse: QuoteDraftWarehouse[];
  transit: QuoteDraftTransit | null;
  dgSurchargeNote: string | null;
  termsConditions: string | null;
}

// ── v4 per-mode columns (design §3.1/D1-D3; partially reverses v3) ──
// Two DIFFERENT column concepts now exist, and they diverge for Sea:
//  - variantsForMode: the FREIGHT-RATE columns (QuoteDraft.trucking/seaRates), and historically
//    the charge-matrix columns too — since v4 makes `charges` common (one row, full stop), this is
//    now used for freight only. Road → Dedicated/Groupage, Sea → FCL/LCL, Air (or an unset mode) →
//    a single implicit column (`null`).
//  - variantsForTransit: the Guaranteed Transit Time columns (QuoteDraftTransit.
//    guaranteedTransitDaysByVariant). Road still matches variantsForMode (a Dedicated truck and a
//    Groupage truck can genuinely have different transit times) — but Sea COLLAPSES to one common
//    value (unlike variantsForMode("SEA")'s two columns: an FCL and an LCL booking on the same
//    vessel/voyage arrive on the same day, so tracking two independent GTTs was never meaningful).
//    Air is unchanged, one implicit column either way.
// `ChargeRateVariant` deliberately stays 4-valued (DEDICATED|GROUPAGE|FCL|LCL): Air's charges use
// `rateVariant: null` (see QuoteDraftCharge — v4: ALL charges do) and variantsForMode("AIR")
// returns [null] rather than adding a 5th "AIR" member — QuoteDraftTrucking/QuoteDraftSeaRate's
// non-nullable `rateVariant: ChargeRateVariant` would then structurally (if nonsensically) admit
// it too. `guaranteedTransitDaysByVariant` is the exception: it needs an actual object key for
// Air's AND Sea's single/common slot (Zod's z.record can't validate a `null` key), so ONLY that
// field's key type is widened into `TransitVariantKey` (`ChargeRateVariant | typeof
// AIR_VARIANT_KEY | typeof SEA_VARIANT_KEY`) — `ChargeRateVariant` itself, and every other field
// typed with it, is untouched.
/** The columns a mode's FREIGHT-RATE matrix renders (`QuoteDraft.trucking`/`seaRates`), in display
 *  order. Road → Dedicated/Groupage, Sea → FCL/LCL, Air (or an unset mode) → a single implicit
 *  column (`null`) — Air has no separate rate cell at all; see AIR_VARIANT_KEY. v4: `charges` no
 *  longer fans out over these columns (every charge is common) — this function is now purely
 *  about freight + the historical Air/null single-column convention. */
export function variantsForMode(mode: FreightMode | null): (ChargeRateVariant | null)[] {
  if (mode === "ROAD") return [ChargeRateVariant.DEDICATED, ChargeRateVariant.GROUPAGE];
  if (mode === "SEA") return [ChargeRateVariant.FCL, ChargeRateVariant.LCL];
  return [null]; // AIR, and a not-yet-resolved mode: single column
}

/** Air's fixed technical key into `guaranteedTransitDaysByVariant`. Air has exactly one implicit
 *  column (`variantsForMode("AIR") === [null]`, and no separate freight-rate cell at all — its
 *  freight is the AIR_MAIN_FREIGHT charge line), but the map needs a real, parseable object key
 *  (not `null`), so Air's single transit-days value is written/read under this constant instead —
 *  never compared against a real Road/Sea variant. Own literal type `"AIR"` (NOT cast to
 *  `ChargeRateVariant` — that type stays exactly 4-valued everywhere else, see the file-level
 *  note above); `quoteDraftSchema` (ff-portal.ts) widens its `guaranteedTransitDaysByVariant` key
 *  enum with this same constant so a submitted `{AIR: n}` map parses instead of 400ing. */
export const AIR_VARIANT_KEY = "AIR";

/** Sea's fixed technical key into `guaranteedTransitDaysByVariant` (design D2, v4 — NEW, partially
 *  reverses v3's per-FCL/LCL transit days). Sea still has TWO freight-rate columns
 *  (`variantsForMode("SEA") === [FCL, LCL]` — an FCL and an LCL booking can carry very different
 *  rates), but only ONE Guaranteed Transit Time: both ride the same vessel/voyage, so a second,
 *  independently-editable GTT field had no real-world meaning and just invited the two to drift.
 *  Same rationale/shape as AIR_VARIANT_KEY (a real, parseable object key standing in for "no real
 *  per-variant split here"), own literal type `"SEA"` (not a 5th ChargeRateVariant member, for the
 *  same reason AIR_VARIANT_KEY isn't — see the file-level note above). The DB mirrors this at
 *  materialize: Sea is expected to write exactly one `TransitPlan` row with `rateVariant: null`
 *  (the same convention Air's single row already uses) — `SEA_VARIANT_KEY` is the in-memory/
 *  wire-format address for that one row; `null` is its DB address. NOT YET added to
 *  `ff-portal.ts`'s `TRANSIT_VARIANT_KEYS` — a submitted `{SEA: n}` map will 400 at the PATCH
 *  endpoint until that follow-up lands (flagged in Task 1's report; out of this task's file list). */
export const SEA_VARIANT_KEY = "SEA";

/** The technical keys `guaranteedTransitDaysByVariant` can be addressed by (design §3.1/D2-D3,
 *  v4): Road's two real ChargeRateVariant members, plus the two single/common-slot sentinels
 *  above. Real object keys only (never `null`) — see AIR_VARIANT_KEY's doc comment for why. */
export type TransitVariantKey = ChargeRateVariant | typeof AIR_VARIANT_KEY | typeof SEA_VARIANT_KEY;

/** The technical keys `guaranteedTransitDaysByVariant` must be populated under for a given mode
 *  (design §3.1/D2-D3, v4). Road → its two real ChargeRateVariant members (still per-variant,
 *  matching variantsForMode). Sea → ONE common key (SEA_VARIANT_KEY) regardless of which of
 *  FCL/LCL is priced — DELIBERATELY narrower than variantsForMode("SEA")'s two freight columns.
 *  Air (or an unset mode) → ONE common key (AIR_VARIANT_KEY), same shape as v3. Unlike
 *  variantsForMode, never returns `null` — every result here is a real, parseable object key,
 *  ready to index `guaranteedTransitDaysByVariant` directly. */
export function variantsForTransit(mode: FreightMode | null): TransitVariantKey[] {
  if (mode === "ROAD") return [ChargeRateVariant.DEDICATED, ChargeRateVariant.GROUPAGE];
  if (mode === "SEA") return [SEA_VARIANT_KEY];
  return [AIR_VARIANT_KEY]; // AIR, and a not-yet-resolved mode: one common slot
}
