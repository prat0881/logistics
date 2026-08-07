import { PrismaClient } from "@prisma/client";
import { ORG_TIMEZONE_KEY, DEFAULT_ORG_TIMEZONE } from "@svyft/shared";
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

type ChargeDef = {
  key: string;
  mode: "ROAD" | "AIR" | "SEA";
  role: "CORE" | "STANDARD" | "TAG_DRIVEN" | "WAREHOUSE";
  inputType?: "PLAIN" | "TRUCKING" | "WAREHOUSE_STAGING" | "HEAVY_WEIGHT_CALC";
  zone?: "ORIGIN" | "MAIN_FREIGHT" | "DESTINATION" | null;
  tagKey?: string | null;
  label: string;
  sortOrder: number;
  isActive?: boolean;
};
const CHARGE_LINE_DEFINITIONS: ChargeDef[] = [
  // ── AIR cores (Zones 1-2) ──
  {
    key: "AIR_ORIGIN_EXPORT_CLEARANCE",
    mode: "AIR",
    role: "CORE",
    zone: "ORIGIN",
    label: "Export Customs Clearance",
    sortOrder: 1,
  },
  {
    key: "AIR_ORIGIN_DOCUMENTATION",
    mode: "AIR",
    role: "CORE",
    zone: "ORIGIN",
    label: "Documentation Charges",
    sortOrder: 2,
  },
  {
    key: "AIR_ORIGIN_THC",
    mode: "AIR",
    role: "CORE",
    zone: "ORIGIN",
    label: "Origin THC / Airport Handling",
    sortOrder: 3,
  },
  {
    key: "AIR_ORIGIN_SECURITY",
    mode: "AIR",
    role: "CORE",
    zone: "ORIGIN",
    label: "Security / Screening Charges",
    sortOrder: 4,
  },
  {
    key: "AIR_ORIGIN_WAREHOUSE_PRESTORAGE",
    mode: "AIR",
    role: "CORE",
    zone: "ORIGIN",
    label: "Warehouse / Pre-storage at OAP",
    sortOrder: 5,
  },
  {
    key: "AIR_MAIN_FREIGHT",
    mode: "AIR",
    role: "CORE",
    zone: "MAIN_FREIGHT",
    label: "Air Freight Charges",
    sortOrder: 6,
  },
  {
    key: "AIR_MAIN_SEC",
    mode: "AIR",
    role: "CORE",
    zone: "MAIN_FREIGHT",
    label: "Security Exchange (SEC)",
    sortOrder: 7,
  },
  {
    key: "AIR_MAIN_CARRIER_SURCHARGE",
    mode: "AIR",
    role: "CORE",
    zone: "MAIN_FREIGHT",
    label: "Airline / Carrier Surcharge",
    sortOrder: 8,
  },
  {
    key: "AIR_MAIN_HEAVY_WEIGHT",
    mode: "AIR",
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
    role: "CORE",
    zone: "MAIN_FREIGHT",
    label: "Fuel Surcharge (FSC)",
    sortOrder: 10,
  },
  {
    key: "AIR_MAIN_PEAK_SEASON",
    mode: "AIR",
    role: "CORE",
    zone: "MAIN_FREIGHT",
    label: "Peak Season Surcharge",
    sortOrder: 11,
  },
  // ── AIR configurable (destination) ──
  {
    key: "AIR_DEST_THC",
    mode: "AIR",
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Destination THC / Airport Handling",
    sortOrder: 12,
  },
  {
    key: "AIR_DEST_IMPORT_CLEARANCE",
    mode: "AIR",
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Import Customs Clearance",
    sortOrder: 13,
  },
  {
    key: "AIR_DEST_STORAGE",
    mode: "AIR",
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Storage 1 Free Day Charges",
    sortOrder: 14,
  },
  {
    key: "AIR_DEST_LAST_MILE",
    mode: "AIR",
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Last Mile Handling / Lift Gate",
    sortOrder: 15,
    isActive: false,
  },
  {
    key: "AIR_TAG_NON_STACKABLE",
    mode: "AIR",
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "NON_STACKABLE",
    label: "Non-stackable handling",
    sortOrder: 16,
  },
  {
    key: "AIR_TAG_FRAGILE",
    mode: "AIR",
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "FRAGILE",
    label: "Fragile handling",
    sortOrder: 17,
  },
  {
    key: "AIR_TAG_DG",
    mode: "AIR",
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "DG",
    label: "DG handling",
    sortOrder: 18,
  },
  {
    key: "AIR_TAG_OOG",
    mode: "AIR",
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "OUT_OF_GAUGE",
    label: "OOG handling",
    sortOrder: 19,
  },
  {
    key: "AIR_TAG_HEAVY",
    mode: "AIR",
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
    role: "CORE",
    zone: "ORIGIN",
    label: "Export Customs Clearance",
    sortOrder: 1,
  },
  {
    key: "SEA_ORIGIN_DOCUMENTATION",
    mode: "SEA",
    role: "CORE",
    zone: "ORIGIN",
    label: "Documentation Charges",
    sortOrder: 2,
  },
  {
    key: "SEA_ORIGIN_THC",
    mode: "SEA",
    role: "CORE",
    zone: "ORIGIN",
    label: "Origin THC (Terminal Handling Charge)",
    sortOrder: 3,
  },
  {
    key: "SEA_ORIGIN_BILL_OF_LADING",
    mode: "SEA",
    role: "CORE",
    zone: "ORIGIN",
    label: "Bill of Lading",
    sortOrder: 4,
  },
  {
    key: "SEA_ORIGIN_WAREHOUSE",
    mode: "SEA",
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
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Destination THC / Handling Charges",
    sortOrder: 10,
  },
  {
    key: "SEA_DEST_IMPORT_CLEARANCE",
    mode: "SEA",
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Import Customs Clearance",
    sortOrder: 11,
  },
  {
    key: "SEA_DEST_STORAGE",
    mode: "SEA",
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Storage 1 Free Day Charges",
    sortOrder: 12,
  },
  {
    key: "SEA_DEST_DELIVERY",
    mode: "SEA",
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Delivery (Last Mile — Door to Door)",
    sortOrder: 13,
    isActive: false,
  },
  {
    key: "SEA_DEST_LAST_MILE",
    mode: "SEA",
    role: "STANDARD",
    zone: "DESTINATION",
    label: "Last Mile Handling / Lift Gate",
    sortOrder: 14,
    isActive: false,
  },
  {
    key: "SEA_TAG_NON_STACKABLE",
    mode: "SEA",
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "NON_STACKABLE",
    label: "Non-stackable handling",
    sortOrder: 15,
  },
  {
    key: "SEA_TAG_FRAGILE",
    mode: "SEA",
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "FRAGILE",
    label: "Fragile handling",
    sortOrder: 16,
  },
  {
    key: "SEA_TAG_DG",
    mode: "SEA",
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "DG",
    label: "DG handling",
    sortOrder: 17,
  },
  {
    key: "SEA_TAG_OOG",
    mode: "SEA",
    role: "TAG_DRIVEN",
    zone: "DESTINATION",
    tagKey: "OUT_OF_GAUGE",
    label: "OOG handling",
    sortOrder: 18,
  },
  {
    key: "SEA_TAG_HEAVY",
    mode: "SEA",
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
    role: "CORE",
    inputType: "TRUCKING",
    zone: null,
    label: "Road Trucking",
    sortOrder: 1,
  },
  {
    key: "ROAD_STD_TAIL_LIFT",
    mode: "ROAD",
    role: "STANDARD",
    zone: null,
    label: "Tail-lift / lift-gate",
    sortOrder: 10,
  },
  {
    key: "ROAD_STD_T1_DOCUMENT",
    mode: "ROAD",
    role: "STANDARD",
    zone: null,
    label: "T1 document",
    sortOrder: 11,
  },
  {
    key: "ROAD_STD_OTHER_DOCUMENTS",
    mode: "ROAD",
    role: "STANDARD",
    zone: null,
    label: "Other documents",
    sortOrder: 12,
  },
  {
    key: "ROAD_STD_REPACKING",
    mode: "ROAD",
    role: "STANDARD",
    zone: null,
    label: "Re-packing",
    sortOrder: 13,
  },
  {
    key: "ROAD_STD_WEEKEND_SURCHARGE",
    mode: "ROAD",
    role: "STANDARD",
    zone: null,
    label: "Weekend / Weekday surcharge",
    sortOrder: 14,
  },
  {
    key: "ROAD_STD_SURCHARGES",
    mode: "ROAD",
    role: "STANDARD",
    zone: null,
    label: "Surcharges (general)",
    sortOrder: 15,
  },
  {
    key: "ROAD_STD_INSURANCE",
    mode: "ROAD",
    role: "STANDARD",
    zone: null,
    label: "Insurance",
    sortOrder: 16,
  },
  {
    key: "ROAD_STD_EXTRA_WAITING",
    mode: "ROAD",
    role: "STANDARD",
    zone: null,
    label: "Extra waiting time",
    sortOrder: 17,
  },
  {
    key: "ROAD_TAG_NON_STACKABLE",
    mode: "ROAD",
    role: "TAG_DRIVEN",
    zone: null,
    tagKey: "NON_STACKABLE",
    label: "Non-stackable handling",
    sortOrder: 18,
  },
  {
    key: "ROAD_TAG_FRAGILE",
    mode: "ROAD",
    role: "TAG_DRIVEN",
    zone: null,
    tagKey: "FRAGILE",
    label: "Fragile handling",
    sortOrder: 19,
  },
  {
    key: "ROAD_TAG_DG",
    mode: "ROAD",
    role: "TAG_DRIVEN",
    zone: null,
    tagKey: "DG",
    label: "DG handling",
    sortOrder: 20,
  },
  {
    key: "ROAD_TAG_OOG",
    mode: "ROAD",
    role: "TAG_DRIVEN",
    zone: null,
    tagKey: "OUT_OF_GAUGE",
    label: "OOG handling",
    sortOrder: 21,
  },
  {
    key: "ROAD_TAG_HEAVY",
    mode: "ROAD",
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
  for (const d of CHARGE_LINE_DEFINITIONS) {
    // create-only: never overwrite an admin's edited charge-line catalogue row
    await prisma.chargeLineDefinition.upsert({
      where: { key: d.key },
      create: {
        key: d.key,
        mode: d.mode,
        role: d.role,
        inputType: d.inputType ?? "PLAIN",
        zone: d.zone ?? null,
        tagKey: d.tagKey ?? null,
        label: d.label,
        sortOrder: d.sortOrder,
        isActive: d.isActive ?? true,
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
