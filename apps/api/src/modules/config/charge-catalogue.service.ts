import { Injectable } from "@nestjs/common";
import type { ChargeLineDefinitionDto } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class ChargeCatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<ChargeLineDefinitionDto[]> {
    const rows = await this.prisma.chargeLineDefinition.findMany({
      where: { isActive: true },
      orderBy: [{ mode: "asc" }, { sortOrder: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id, key: r.key, mode: r.mode, role: r.role, inputType: r.inputType,
      zone: r.zone, tagKey: r.tagKey, label: r.label, sortOrder: r.sortOrder, isActive: r.isActive,
    }));
  }
}
