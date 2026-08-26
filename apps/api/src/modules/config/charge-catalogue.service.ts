import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  chargeLineKey,
  deriveRole,
  deriveZone,
  type ChargeLineCreateInput,
  type ChargeLineDefinitionDto,
  type ChargeLineUpdateInput,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { auditCreate, auditUpdate } from "../../common/audit";
import type { RequestUser } from "../auth/types";

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

  async create(input: ChargeLineCreateInput, user?: RequestUser) {
    const tagKey = input.tagKey ?? null;
    const key = chargeLineKey(input.mode, input.category, input.label);
    const maxSort = await this.prisma.chargeLineDefinition.aggregate({
      where: { mode: input.mode, category: input.category },
      _max: { sortOrder: true },
    });
    try {
      return await this.prisma.chargeLineDefinition.create({
        data: {
          key,
          mode: input.mode,
          variant: input.variant,
          category: input.category,
          label: input.label,
          isAdditional: input.isAdditional,
          tagKey,
          inputType: input.inputType ?? "PLAIN",
          isActive: input.isActive ?? true,
          sortOrder: input.sortOrder ?? (maxSort._max.sortOrder ?? 0) + 10,
          // Derived, never supplied by the caller — the quote layer still reads these.
          zone: deriveZone(input.category, input.mode),
          role: deriveRole(input.isAdditional, tagKey),
          ...auditCreate(user),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException(`A charge line with the key ${key} already exists`);
      }
      throw e;
    }
  }

  async update(id: string, input: ChargeLineUpdateInput, user?: RequestUser) {
    return this.prisma.chargeLineDefinition.update({
      where: { id },
      data: { ...input, ...auditUpdate(user) },
    });
  }

  async remove(id: string) {
    const inUse = await this.prisma.legChargeLineSelection.count({ where: { definitionId: id } });
    if (inUse > 0) {
      throw new ConflictException(
        `This charge line is in use on ${inUse} leg${inUse === 1 ? "" : "s"} and cannot be deleted. Deactivate it instead.`,
      );
    }
    return this.prisma.chargeLineDefinition.delete({ where: { id } });
  }
}
