import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { FreightForwarder, FreightMode } from "@prisma/client";
import type { FreightForwarderCreateInput, FreightForwarderUpdateInput, Paginated } from "@svyft/shared";
import { resolveCountryCode } from "@svyft/shared";
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
    countriesComplete: boolean;
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
      // Country: an FF must cover EVERY endpoint country, and BOTH endpoints must
      // have a resolvable country (`countriesComplete`) — a leg missing/unresolvable
      // endpoint country matches no FF (show none). `criteria.countries` are already
      // ISO codes (resolved in leg-context); resolve the FF's availableCountries too
      // so any legacy/case difference can't cause a false miss.
      const ffCodes = new Set<string>(
        ff.availableCountries
          .map((c): string | null => resolveCountryCode(c))
          .filter((c): c is string => !!c),
      );
      const countryOk =
        criteria.countriesComplete && criteria.countries.every((c) => ffCodes.has(c));
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
