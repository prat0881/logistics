import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Paginated, VesselCreateInput, VesselUpdateInput } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class VesselsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: {
    q?: string;
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<Paginated<unknown>> {
    const where: Prisma.VesselWhereInput = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { name: { contains: params.q, mode: "insensitive" } },
              { vesselCode: { contains: params.q, mode: "insensitive" } },
              { imoNumber: { contains: params.q, mode: "insensitive" } },
              { shippingLine: { contains: params.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.vessel.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.vessel.count({ where }),
    ]);
    return { items, total, page: params.page, pageSize: params.pageSize };
  }

  async get(id: string) {
    const vessel = await this.prisma.vessel.findUnique({ where: { id } });
    if (!vessel) throw new NotFoundException("Vessel not found");
    return vessel;
  }

  async create(input: VesselCreateInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.codeSequence.upsert({
          where: { key: "VESSEL" },
          create: { key: "VESSEL", lastNumber: 1 },
          update: { lastNumber: { increment: 1 } },
        });
        const vesselCode = `VS-${String(row.lastNumber).padStart(4, "0")}`;
        return tx.vessel.create({ data: { vesselCode, ...input } });
      });
    } catch (e) {
      throw this.mapUnique(e);
    }
  }

  async update(id: string, input: VesselUpdateInput) {
    await this.get(id);
    try {
      return await this.prisma.vessel.update({ where: { id }, data: input });
    } catch (e) {
      throw this.mapUnique(e);
    }
  }

  private mapUnique(e: unknown): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return new ConflictException("A vessel with that IMO number already exists");
    }
    return e;
  }
}
