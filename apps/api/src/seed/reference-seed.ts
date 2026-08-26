import { PrismaClient } from "@prisma/client";
import { ORG_TIMEZONE_KEY, DEFAULT_ORG_TIMEZONE, deriveZone, deriveRole } from "@svyft/shared";
import type { ChargeCategory, ChargeVariant, ReferenceTag } from "@svyft/shared";
import {
  RFQ_DEADLINE_HOURS_KEY,
  RFQ_REMINDER_OFFSETS_KEY,
  DEFAULT_RFQ_DEADLINE_HOURS,
  DEFAULT_RFQ_REMINDER_OFFSETS,
} from "@svyft/shared";
import { seedMessageTemplates } from "./message-templates.seed";

const DENSITY: { mode: "ROAD" | "AIR" | "SEA"; kgPerCbm: number }[] = [
  { mode: "ROAD", kgPerCbm: 333 },
  { mode: "AIR", kgPerCbm: 167 },
  { mode: "SEA", kgPerCbm: 1000 },
];

const CHECKLIST: { itemKey: string; label: string; order: number; dgConditional?: boolean }[] = [
  { itemKey: "weight-confirmed", label: "Weight confirmed", order: 1 },
  { itemKey: "dimensions-confirmed", label: "Dimensions confirmed", order: 2 },
  { itemKey: "hs-code-received", label: "HS / HSN code received", order: 3 },
  { itemKey: "dg-confirmed", label: "DG / Non-DG confirmed", order: 4 },
  { itemKey: "msds-received", label: "MSDS received", order: 5, dgConditional: true },
  { itemKey: "commercial-invoice", label: "Commercial invoice received", order: 6 },
  { itemKey: "packing-list", label: "Packing list received", order: 7 },
  { itemKey: "pickup-address", label: "Pickup address confirmed", order: 8 },
  { itemKey: "delivery-address", label: "Delivery address confirmed", order: 9 },
];

export type ChargeDef = {
  key: string;
  mode: "ROAD" | "AIR" | "SEA";
  // Optional now: for any def with `category` set, the upsert loop below computes role (and
  // zone) via deriveRole/deriveZone and that always wins over whatever's here. Only
  // ROAD_WH_HANDLING has no category (warehousing is deferred), so it is the one def that must
  // still supply role/zone directly — see the upsert loop's `derived` fallback branch.
  role?: "CORE" | "STANDARD" | "TAG_DRIVEN" | "WAREHOUSE";
  inputType?: "PLAIN" | "TRUCKING" | "WAREHOUSE_STAGING" | "HEAVY_WEIGHT_CALC";
  zone?: "ORIGIN" | "MAIN_FREIGHT" | "DESTINATION" | null;
  tagKey?: string | null;
  label: string;
  // Optional on the literal: the 19 new lines omit it and get one computed by
  // withComputedSortOrder() below (mirrors ChargeCatalogueService.create()'s convention),
  // rather than tying at the schema's sortOrder default of 0 and sorting above every existing
  // row the moment one is selected.
  sortOrder?: number;
  isActive?: boolean;
  // category/variant/isAdditional are the new admin-facing columns (Task 10/12): zone and role
  // are derived from them via deriveZone/deriveRole below rather than hardcoded, so the seed and
  // the catalogue service (packages/shared/src/masters/charge-catalogue.ts) share one derivation
  // and cannot drift. ROAD_WH_HANDLING has neither — warehousing is deferred (no category).
  category?: ChargeCategory;
  variant?: ChargeVariant;
  isAdditional?: boolean;
};
/**
 * The 51 charge lines that predate the category/variant/isAdditional columns. 50 of them carry
 * BOTH the new admin-facing fields AND the legacy `role:`/`zone:` literals the upsert loop below
 * now overrides via deriveZone/deriveRole. Those literals are therefore dead at runtime — but
 * they are an independent, hand-authored record of what the derivation is SUPPOSED to produce,
 * which is why they were kept rather than deleted, and why this array is exported:
 * test/charge-derivation.spec.ts asserts the two derivation functions still reproduce all 50.
 * (The 51st, ROAD_WH_HANDLING, has no category — warehousing is deferred — and is the one row
 * whose role/zone literals are still load-bearing; see the loop's `derived` fallback branch.)
 */
export const CHARGE_LINE_DEFINITIONS: ChargeDef[] = [
  // ── AIR cores (Zones 1-2) ──
  {
    key: "AIR_ORIGIN_EXPORT_CLEARANCE",
    mode: "AIR",
    category: "ORIGIN",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "ORIGIN",
    label: "Export Customs Clearance",
    sortOrder: 1,
  },
  {
    key: "AIR_ORIGIN_DOCUMENTATION",
    mode: "AIR",
    category: "ORIGIN",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "ORIGIN",
    label: "Documentation Charges",
    sortOrder: 2,
  },
  {
    key: "AIR_ORIGIN_THC",
    mode: "AIR",
    category: "ORIGIN",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "ORIGIN",
    label: "Origin THC / Airport Handling",
    sortOrder: 3,
  },
  {
    key: "AIR_ORIGIN_SECURITY",
    mode: "AIR",
    category: "ORIGIN",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "ORIGIN",
    label: "Security / Screening Charges",
    sortOrder: 4,
  },
  {
    key: "AIR_ORIGIN_WAREHOUSE_PRESTORAGE",
    mode: "AIR",
    category: "ORIGIN",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "ORIGIN",
    label: "Warehouse / Pre-storage at OAP",
    sortOrder: 5,
  },
  {
    key: "AIR_MAIN_FREIGHT",
    mode: "AIR",
    category: "FREIGHT",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "MAIN_FREIGHT",
    label: "Air Freight Charges",
    sortOrder: 6,
  },
  {
    key: "AIR_MAIN_SEC",
    mode: "AIR",
    category: "FREIGHT",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "MAIN_FREIGHT",
    label: "Security Exchange (SEC)",
    sortOrder: 7,
  },
  {
    key: "AIR_MAIN_CARRIER_SURCHARGE",
    mode: "AIR",
    category: "FREIGHT",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "MAIN_FREIGHT",
    label: "Airline / Carrier Surcharge",
    sortOrder: 8,
  },
  {
    key: "AIR_MAIN_HEAVY_WEIGHT",
    mode: "AIR",
    category: "FREIGHT",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    inputType: "HEAVY_WEIGHT_CALC",
    zone: "MAIN_FREIGHT",
    label: "Heavy Weight Surcharge",
    sortOrder: 9,
  },
  // sortOrder is Int (Prisma) — these were briefly 9.1/9.2 and got silently truncated to 9 by
  // Postgres, tying with AIR_MAIN_HEAVY_WEIGHT (3-way, nondeterministic display order). Renumbered
  // as whole integers so FSC/Peak slot in right after Heavy Weight without colliding; everything
  // from the old AIR_DEST_THC=10 onward shifts +2 (see the paired sortOrder-fix migration).
  {
    key: "AIR_MAIN_FSC",
    mode: "AIR",
    category: "FREIGHT",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "MAIN_FREIGHT",
    label: "Fuel Surcharge (FSC)",
    sortOrder: 10,
  },
  {
    key: "AIR_MAIN_PEAK_SEASON",
    mode: "AIR",
    category: "FREIGHT",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "MAIN_FREIGHT",
    label: "Peak Season Surcharge",
    sortOrder: 11,
  },
  // ── AIR configurable (destination) ──
  {
    key: "AIR_DEST_THC",
    mode: "AIR",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Destination THC / Airport Handling",
    sortOrder: 12,
  },
  {
    key: "AIR_DEST_IMPORT_CLEARANCE",
    mode: "AIR",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Import Customs Clearance",
    sortOrder: 13,
  },
  {
    key: "AIR_DEST_STORAGE",
    mode: "AIR",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Storage 1 Free Day Charges",
    sortOrder: 14,
  },
  {
    key: "AIR_DEST_LAST_MILE",
    mode: "AIR",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Last Mile Handling / Lift Gate",
    sortOrder: 15,
    isActive: false,
  },
  {
    key: "AIR_TAG_NON_STACKABLE",
    mode: "AIR",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "NON_STACKABLE",
    label: "Non-stackable handling",
    sortOrder: 16,
  },
  {
    key: "AIR_TAG_FRAGILE",
    mode: "AIR",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "FRAGILE",
    label: "Fragile handling",
    sortOrder: 17,
  },
  {
    key: "AIR_TAG_DG",
    mode: "AIR",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "DG",
    label: "DG handling",
    sortOrder: 18,
  },
  {
    key: "AIR_TAG_OOG",
    mode: "AIR",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "OUT_OF_GAUGE",
    label: "OOG handling",
    sortOrder: 19,
  },
  {
    key: "AIR_TAG_HEAVY",
    mode: "AIR",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "HEAVY",
    label: "Heavy handling",
    sortOrder: 20,
  },
  // ── SEA cores ──
  {
    key: "SEA_ORIGIN_EXPORT_CLEARANCE",
    mode: "SEA",
    category: "ORIGIN",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "ORIGIN",
    label: "Export Customs Clearance",
    sortOrder: 1,
  },
  {
    key: "SEA_ORIGIN_DOCUMENTATION",
    mode: "SEA",
    category: "ORIGIN",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "ORIGIN",
    label: "Documentation Charges",
    sortOrder: 2,
  },
  {
    key: "SEA_ORIGIN_THC",
    mode: "SEA",
    category: "ORIGIN",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "ORIGIN",
    label: "Origin THC (Terminal Handling Charge)",
    sortOrder: 3,
  },
  {
    key: "SEA_ORIGIN_BILL_OF_LADING",
    mode: "SEA",
    category: "ORIGIN",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "ORIGIN",
    label: "Bill of Lading",
    sortOrder: 4,
  },
  {
    key: "SEA_ORIGIN_WAREHOUSE",
    mode: "SEA",
    category: "ORIGIN",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "ORIGIN",
    label: "Warehouse Charges",
    sortOrder: 5,
  },
  // Retired (design §5.2): sea freight is now the structured seaRates[] dual-rate, which
  // REPLACES this flat CORE/PLAIN line. Left active it would be priced twice — via
  // draft.charges AND seaRates — and double-counted by computeQuoteTotals. Seed is create-only
  // (upsert … update:{}), so an already-seeded row needs the paired data migration
  // prisma/migrations/20260806010000_retire_sea_main_freight to flip isActive on :5433/prod.
  {
    key: "SEA_MAIN_FREIGHT",
    mode: "SEA",
    category: "FREIGHT",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    zone: "MAIN_FREIGHT",
    label: "Sea Freight Charges",
    sortOrder: 6,
    isActive: false,
  },
  // ── SEA configurable (destination) ──
  {
    key: "SEA_DEST_THC",
    mode: "SEA",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Destination THC / Handling Charges",
    sortOrder: 10,
  },
  {
    key: "SEA_DEST_IMPORT_CLEARANCE",
    mode: "SEA",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Import Customs Clearance",
    sortOrder: 11,
  },
  {
    key: "SEA_DEST_STORAGE",
    mode: "SEA",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Storage 1 Free Day Charges",
    sortOrder: 12,
  },
  {
    key: "SEA_DEST_DELIVERY",
    mode: "SEA",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Delivery (Last Mile — Door to Door)",
    sortOrder: 13,
    isActive: false,
  },
  {
    key: "SEA_DEST_LAST_MILE",
    mode: "SEA",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Last Mile Handling / Lift Gate",
    sortOrder: 14,
    isActive: false,
  },
  {
    key: "SEA_TAG_NON_STACKABLE",
    mode: "SEA",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "NON_STACKABLE",
    label: "Non-stackable handling",
    sortOrder: 15,
  },
  {
    key: "SEA_TAG_FRAGILE",
    mode: "SEA",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "FRAGILE",
    label: "Fragile handling",
    sortOrder: 16,
  },
  {
    key: "SEA_TAG_DG",
    mode: "SEA",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "DG",
    label: "DG handling",
    sortOrder: 17,
  },
  {
    key: "SEA_TAG_OOG",
    mode: "SEA",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "OUT_OF_GAUGE",
    label: "OOG handling",
    sortOrder: 18,
  },
  {
    key: "SEA_TAG_HEAVY",
    mode: "SEA",
    category: "DESTINATION",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "HEAVY",
    label: "Heavy handling",
    sortOrder: 19,
  },
  // ── ROAD ──
  {
    key: "ROAD_CORE_TRUCKING",
    mode: "ROAD",
    category: "FREIGHT",
    variant: "BOTH",
    isAdditional: false,
    role: "CORE",
    inputType: "TRUCKING",
    zone: null,
    label: "Road Trucking",
    sortOrder: 1,
  },
  {
    key: "ROAD_STD_TAIL_LIFT",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: null,
    label: "Tail-lift / lift-gate",
    sortOrder: 10,
  },
  {
    key: "ROAD_STD_T1_DOCUMENT",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: null,
    label: "T1 document",
    sortOrder: 11,
  },
  {
    key: "ROAD_STD_OTHER_DOCUMENTS",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: null,
    label: "Other documents",
    sortOrder: 12,
  },
  {
    key: "ROAD_STD_REPACKING",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: null,
    label: "Re-packing",
    sortOrder: 13,
  },
  {
    key: "ROAD_STD_WEEKEND_SURCHARGE",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: null,
    label: "Weekend / Weekday surcharge",
    sortOrder: 14,
  },
  {
    key: "ROAD_STD_SURCHARGES",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: null,
    label: "Surcharges (general)",
    sortOrder: 15,
  },
  {
    key: "ROAD_STD_INSURANCE",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: null,
    label: "Insurance",
    sortOrder: 16,
  },
  {
    key: "ROAD_STD_EXTRA_WAITING",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "STANDARD",
    zone: null,
    label: "Extra waiting time",
    sortOrder: 17,
  },
  {
    key: "ROAD_TAG_NON_STACKABLE",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: null,
    tagKey: "NON_STACKABLE",
    label: "Non-stackable handling",
    sortOrder: 18,
  },
  {
    key: "ROAD_TAG_FRAGILE",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: null,
    tagKey: "FRAGILE",
    label: "Fragile handling",
    sortOrder: 19,
  },
  {
    key: "ROAD_TAG_DG",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: null,
    tagKey: "DG",
    label: "DG handling",
    sortOrder: 20,
  },
  {
    key: "ROAD_TAG_OOG",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: null,
    tagKey: "OUT_OF_GAUGE",
    label: "OOG handling",
    sortOrder: 21,
  },
  {
    key: "ROAD_TAG_HEAVY",
    mode: "ROAD",
    category: "ADDITIONAL",
    variant: "BOTH",
    isAdditional: true,
    role: "TAG_DRIVEN",
    zone: null,
    tagKey: "HEAVY",
    label: "Heavy handling",
    sortOrder: 22,
  },
  {
    key: "ROAD_WH_HANDLING",
    mode: "ROAD",
    role: "WAREHOUSE",
    inputType: "WAREHOUSE_STAGING",
    zone: null,
    label: "Warehouse handling",
    sortOrder: 23,
  },
];

// Assigns each def a sortOrder equal to MAX(sortOrder) among rows sharing its mode+category,
// plus 10 — mirroring ChargeCatalogueService.create()'s convention for admin-created lines
// (apps/api/src/modules/config/charge-catalogue.service.ts), rather than tying at the schema's
// default of 0. `seed` supplies the starting max per group; `running` is updated after each
// assignment so several new lines sharing a group (e.g. the 8 new SEA_DEST_* lines) land in a
// stable, spaced sequence instead of colliding with each other. Never touches a def that already
// has a sortOrder, so no existing row is renumbered.
function withComputedSortOrder(defs: ChargeDef[], seed: ChargeDef[]): ChargeDef[] {
  const running = new Map<string, number>();
  for (const d of seed) {
    if (!d.category) continue;
    const group = `${d.mode}:${d.category}`;
    running.set(group, Math.max(running.get(group) ?? 0, d.sortOrder ?? 0));
  }
  return defs.map((d) => {
    if (d.sortOrder != null || !d.category) return d;
    const group = `${d.mode}:${d.category}`;
    const next = (running.get(group) ?? 0) + 10;
    running.set(group, next);
    return { ...d, sortOrder: next };
  });
}

// Task 12: the 19 charge lines named in the client's workbook with no existing definition.
// AIR_ORIGIN_INSURANCE / SEA_ORIGIN_CONTAINER_TRANSPORT / SEA_ORIGIN_LSS are always-included
// (isAdditional: false, so deriveRole gives them CORE) — seeding them active would price on
// every future Air/Sea RFQ the moment this seed ran, so they ship isActive: false (D17). The
// other 16 are executive-selected (isAdditional: true) and merely appear in a selection list.
const NEW_CHARGE_LINES: ChargeDef[] = withComputedSortOrder([
  // Air — origin
  { key: "AIR_ORIGIN_INSURANCE", mode: "AIR", category: "ORIGIN", variant: "BOTH", label: "Insurance", isAdditional: false, isActive: false },
  { key: "AIR_ORIGIN_MAGNETIC_FEE", mode: "AIR", category: "ORIGIN", variant: "BOTH", label: "Magnetic Fee", isAdditional: true },
  { key: "AIR_ORIGIN_T1_EUROPE", mode: "AIR", category: "ORIGIN", variant: "BOTH", label: "Europe T1 Document", isAdditional: true },
  { key: "AIR_ORIGIN_EDD", mode: "AIR", category: "ORIGIN", variant: "BOTH", label: "EDD Security Check", isAdditional: true },
  // Air — destination
  { key: "AIR_DEST_CUSTOM_DOCS_T1", mode: "AIR", category: "DESTINATION", variant: "BOTH", label: "Custom Documents (T1)", isAdditional: true },
  { key: "AIR_DEST_FILE_OPENING", mode: "AIR", category: "DESTINATION", variant: "BOTH", label: "File Opening Charges", isAdditional: true },
  // Sea — origin
  { key: "SEA_ORIGIN_CONTAINER_TRANSPORT", mode: "SEA", category: "ORIGIN", variant: "BOTH", label: "Container Transport / Loading", isAdditional: false, isActive: false },
  { key: "SEA_ORIGIN_LSS", mode: "SEA", category: "ORIGIN", variant: "BOTH", label: "LSS (Low Sulphur Surcharge)", isAdditional: false, isActive: false },
  // Sea — destination
  { key: "SEA_DEST_CFS", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "CFS Charges", isAdditional: true },
  { key: "SEA_DEST_DO_RELEASE", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "DO Release", isAdditional: true },
  { key: "SEA_DEST_CONTAINER_CLEANING", mode: "SEA", category: "DESTINATION", variant: "FCL", label: "Container Cleaning", isAdditional: true },
  { key: "SEA_DEST_DEVANNING", mode: "SEA", category: "DESTINATION", variant: "FCL", label: "Devanning Charges", isAdditional: true },
  { key: "SEA_DEST_WHARFAGE", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "Wharfage Charges", isAdditional: true },
  { key: "SEA_DEST_BAF", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "BAF (Bunker Adjustment Factor)", isAdditional: true },
  { key: "SEA_DEST_CAF", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "CAF (Currency Adjustment Factor)", isAdditional: true },
  { key: "SEA_DEST_DDF", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "DDF (Document Fee / Admin / Cargo Release)", isAdditional: true },
  // Sea — additional
  { key: "SEA_ADD_GAS_MEASURING", mode: "SEA", category: "ADDITIONAL", variant: "BOTH", label: "Gas Measuring Charges", isAdditional: true },
  { key: "SEA_ADD_EMERGENCY_SURCHARGE", mode: "SEA", category: "ADDITIONAL", variant: "BOTH", label: "Emergency Surcharge", isAdditional: true },
  // Road — additional
  { key: "ROAD_ADD_BONDED_LICENCE", mode: "ROAD", category: "ADDITIONAL", variant: "BOTH", label: "Bonded Licence Fee", isAdditional: true },
], CHARGE_LINE_DEFINITIONS);

export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  for (const key of ["CLIENT", "VESSEL", "FREIGHT_FORWARDER"]) {
    await prisma.codeSequence.upsert({
      where: { key },
      create: { key, lastNumber: 0 },
      update: {},
    });
  }
  for (const d of DENSITY) {
    // create-only: never overwrite an admin's edited kg/CBM
    await prisma.freightDensityFactor.upsert({ where: { mode: d.mode }, create: d, update: {} });
  }
  for (const d of [...CHARGE_LINE_DEFINITIONS, ...NEW_CHARGE_LINES]) {
    // zone/role are derived from category/isAdditional via the same functions the catalogue
    // service uses (packages/shared/src/masters/charge-catalogue.ts), so the two representations
    // cannot drift. ROAD_WH_HANDLING has no category (warehousing is deferred) and keeps
    // whatever zone/role it was given directly.
    const tagKey: ReferenceTag | null = (d.tagKey as ReferenceTag | undefined) ?? null;
    const derived = d.category
      ? { zone: deriveZone(d.category, d.mode), role: deriveRole(d.isAdditional ?? false, tagKey) }
      : { zone: d.zone ?? null, role: d.role! };
    // create-only: never overwrite an admin's edited charge-line catalogue row. Deliberately NOT
    // switched to a full-overwrite `update` (unlike the brief's literal snippet) — this seed
    // re-runs on every production deploy (.github/workflows/deploy.yml) and
    // ChargeCatalogueController (apps/api/src/modules/config/charge-catalogue.controller.ts)
    // lets Admin/Manager PATCH label/sortOrder/isActive/inputType on these same rows today; a
    // full-overwrite `update` would silently revert those edits on the next deploy. See also the
    // "preserves edits" case in reference-seed.e2e-spec.ts for the sibling freightDensityFactor
    // upsert, and the SEA_MAIN_FREIGHT comment below confirming this table is already
    // create-only by design.
    await prisma.chargeLineDefinition.upsert({
      where: { key: d.key },
      create: {
        key: d.key,
        mode: d.mode,
        role: derived.role,
        inputType: d.inputType ?? "PLAIN",
        zone: derived.zone,
        tagKey,
        label: d.label,
        sortOrder: d.sortOrder,
        isActive: d.isActive ?? true,
        category: d.category ?? null,
        variant: d.variant ?? "BOTH",
        isAdditional: d.isAdditional ?? false,
      },
      update: {},
    });
  }
  for (const c of CHECKLIST) {
    await prisma.checklistDefinition.upsert({
      where: { itemKey: c.itemKey },
      create: { ...c, dgConditional: c.dgConditional ?? false },
      update: {},
    });
  }
  await prisma.appSetting.upsert({
    where: { key: ORG_TIMEZONE_KEY },
    create: { key: ORG_TIMEZONE_KEY, value: DEFAULT_ORG_TIMEZONE },
    update: {},
  });
  await prisma.appSetting.upsert({
    where: { key: RFQ_DEADLINE_HOURS_KEY },
    create: { key: RFQ_DEADLINE_HOURS_KEY, value: String(DEFAULT_RFQ_DEADLINE_HOURS) },
    update: {},
  });
  await prisma.appSetting.upsert({
    where: { key: RFQ_REMINDER_OFFSETS_KEY },
    create: { key: RFQ_REMINDER_OFFSETS_KEY, value: DEFAULT_RFQ_REMINDER_OFFSETS.join(",") },
    update: {},
  });
  await seedMessageTemplates(prisma);
}
