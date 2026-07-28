import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { FreightForwarder, FreightMode } from "@prisma/client";
import type { FreightForwarderCreateInput, FreightForwarderUpdateInput, Paginated } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class FreightForwardersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { q?: string; status?: string; page: number; pageSize: number }): Promise<Paginated<unknown>> {
    const where: Prisma.FreightForwarderWhereInput = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { companyName: { contains: params.q, mode: "insensitive" } },
              { freightForwarderCode: { contains: params.q, mode: "insensitive" } },
              { pic: { contains: params.q, mode: "insensitive" } },
              { email: { contains: params.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.freightForwarder.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.freightForwarder.count({ where }),
    ]);
    return { items, total, page: params.page, pageSize: params.pageSize };
  }

  async get(id: string) {
    const ff = await this.prisma.freightForwarder.findUnique({ where: { id } });
    if (!ff) throw new NotFoundException("Freight forwarder not found");
    return ff;
  }

  async create(input: FreightForwarderCreateInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.codeSequence.upsert({
          where: { key: "FREIGHT_FORWARDER" },
          create: { key: "FREIGHT_FORWARDER", lastNumber: 1 },
          update: { lastNumber: { increment: 1 } },
        });
        const freightForwarderCode = `FF-${String(row.lastNumber).padStart(4, "0")}`;
        return tx.freightForwarder.create({ data: { freightForwarderCode, ...input } });
      });
    } catch (e) {
      throw this.mapUnique(e);
    }
  }

  async update(id: string, input: FreightForwarderUpdateInput) {
    await this.get(id);
    try {
      return await this.prisma.freightForwarder.update({ where: { id }, data: input });
    } catch (e) {
      throw this.mapUnique(e);
    }
  }

  async findEligible(criteria: {
    countries: string[];
    mode: FreightMode | null;
    requireDg: boolean;
    broaden: boolean;
  }): Promise<FreightForwarder[]> {
    const active = await this.prisma.freightForwarder.findMany({
      where: { status: "ACTIVE", ...(criteria.requireDg ? { handleDg: true } : {}) },
      orderBy: { companyName: "asc" },
    });
    if (criteria.broaden) return active;
    return active.filter((ff) => {
      const modeOk = criteria.mode === null || ff.modes.includes(criteria.mode);
      const countryOk =
        criteria.countries.length === 0 ||
        criteria.countries.every((c) => ff.availableCountries.includes(c));
      return modeOk && countryOk;
    });
  }

  private mapUnique(e: unknown): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return new ConflictException("A freight forwarder with that company name already exists");
    }
    return e;
  }
}
