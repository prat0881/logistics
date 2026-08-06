import {
  resolveChargeConfig,
  type ChargeConfigSnapshot,
  type ChargeLineDefinitionDto,
  type ManifestSnapshotCargo,
} from "@svyft/shared";
import type { PrismaService } from "../../prisma/prisma.service";
import type { LegRfqRow } from "./leg-context";

export async function buildChargeConfigSnapshot(
  prisma: Pick<PrismaService, "chargeLineDefinition">,
  leg: LegRfqRow,
  manifestCargo: ManifestSnapshotCargo[],
): Promise<ChargeConfigSnapshot> {
  const defs = await prisma.chargeLineDefinition.findMany({
    where: { mode: leg.mode ?? undefined, isActive: true },
  });
  const dtos: ChargeLineDefinitionDto[] = defs.map((d) => ({
    id: d.id, key: d.key, mode: d.mode, role: d.role, inputType: d.inputType,
    zone: d.zone, tagKey: d.tagKey, label: d.label, sortOrder: d.sortOrder, isActive: d.isActive,
  }));
  const selectedKeys = leg.chargeSelections.map((s) => s.definition.key);
  // The two-gate's tag half (design §13): a TAG_DRIVEN line freezes only when its tagKey is
  // carried by at least one package assigned to THIS leg — the union of the just-frozen
  // manifest's per-package effectiveTags, deduped.
  const packageTags = [...new Set(manifestCargo.flatMap((c) => c.tags))];
  return resolveChargeConfig(dtos, selectedKeys, leg.warehouseHandlingIncluded === true, packageTags);
}
