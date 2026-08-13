import { Injectable } from "@nestjs/common";
import type { FxRateCreateInput, FxRateDto } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class FxRatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<FxRateDto[]> {
    const rows = await this.prisma.fxRate.findMany({ orderBy: { effectiveFrom: "desc" } });
    return rows.map((r) => ({
      id: r.id,
      currency: r.currency,
      unitsPerUsd: Number(r.unitsPerUsd),
      effectiveFrom: r.effectiveFrom.toISOString(),
      note: r.note,
      createdById: r.createdById,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async create(input: FxRateCreateInput, createdById: string): Promise<FxRateDto> {
    const r = await this.prisma.fxRate.create({
      data: {
        currency: input.currency,
        unitsPerUsd: input.unitsPerUsd,
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
        note: input.note ?? null,
        createdById,
      },
    });
    return {
      id: r.id,
      currency: r.currency,
      unitsPerUsd: Number(r.unitsPerUsd),
      effectiveFrom: r.effectiveFrom.toISOString(),
      note: r.note,
      createdById: r.createdById,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
