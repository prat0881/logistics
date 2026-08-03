import { PrismaClient } from "@prisma/client";
import { ORG_TIMEZONE_KEY, DEFAULT_ORG_TIMEZONE } from "@svyft/shared";
import { RFQ_DEADLINE_HOURS_KEY, RFQ_REMINDER_OFFSETS_KEY, DEFAULT_RFQ_DEADLINE_HOURS, DEFAULT_RFQ_REMINDER_OFFSETS } from "@svyft/shared";
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
