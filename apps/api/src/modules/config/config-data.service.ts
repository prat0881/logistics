import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { ChecklistItemUpdateInput, DensityFactorUpdateInput } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class ConfigDataService {
  constructor(private readonly prisma: PrismaService) {}

  densityFactors() {
    return this.prisma.freightDensityFactor.findMany({ orderBy: { mode: "asc" } });
  }

  async updateDensityFactor(mode: string, input: DensityFactorUpdateInput) {
    try {
      return await this.prisma.freightDensityFactor.update({
        where: { mode: mode as never },
        data: input,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        throw new NotFoundException("Unknown freight mode");
      }
      throw e;
    }
  }

  checklist() {
    return this.prisma.checklistDefinition.findMany({ orderBy: { order: "asc" } });
  }

  async updateChecklistItem(itemKey: string, input: ChecklistItemUpdateInput) {
    try {
      return await this.prisma.checklistDefinition.update({ where: { itemKey }, data: input });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        throw new NotFoundException("Unknown checklist item");
      }
      throw e;
    }
  }
}
