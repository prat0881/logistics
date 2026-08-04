import { resolveChargeConfig, type ChargeConfigSnapshot, type ChargeLineDefinitionDto } from "@svyft/shared";
import type { PrismaService } from "../../prisma/prisma.service";
import type { LegRfqRow } from "./leg-context";

export async function buildChargeConfigSnapshot(
  prisma: Pick<PrismaService, "chargeLineDefinition">,
  leg: LegRfqRow,
): Promise<ChargeConfigSnapshot> {
  const defs = await prisma.chargeLineDefinition.findMany({
    where: { mode: leg.mode ?? undefined, isActive: true },
  });
  const dtos: ChargeLineDefinitionDto[] = defs.map((d) => ({
    id: d.id, key: d.key, mode: d.mode, role: d.role, inputType: d.inputType,
    zone: d.zone, tagKey: d.tagKey, label: d.label, sortOrder: d.sortOrder, isActive: d.isActive,
  }));
  const selectedKeys = leg.chargeSelections.map((s) => s.definition.key);
  return resolveChargeConfig(dtos, selectedKeys, leg.warehouseHandlingIncluded === true);
}
