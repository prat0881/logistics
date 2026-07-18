import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { formatQueryCode, type QuerySaveInput } from "@svyft/shared";
import type { RequestUser } from "../auth/types";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class QueriesService {
  constructor(private readonly prisma: PrismaService) {}

  // Convert ISO-string date fields in the validated payload to Date for Prisma. Returns a
  // loose record (caller casts to the Prisma create/update input; if `tsc` rejects the
  // direct `as`, use `as unknown as Prisma.Query…Input`).
  private toData(input: Partial<QuerySaveInput>): Record<string, unknown> {
    const dateKeys = [
      "responseDeadline",
      "eta",
      "etb",
      "etd",
      "readyDate",
      "targetDelivery",
      "queryDate",
    ] as const;
    const data: Record<string, unknown> = { ...input };
    for (const k of dateKeys) if (data[k] != null) data[k] = new Date(data[k] as string);
    return data;
  }

  // clientId/vesselId are real FKs (P2003 is NOT mapped by the filter → verify here).
  // assignedUserId is a soft reference (no FK) — the Zod schema already guarantees uuid shape.
  private async assertRefsExist(input: Partial<QuerySaveInput>): Promise<void> {
    if (input.clientId && !(await this.prisma.client.findUnique({ where: { id: input.clientId } })))
      throw new BadRequestException("Unknown clientId");
    if (input.vesselId && !(await this.prisma.vessel.findUnique({ where: { id: input.vesselId } })))
      throw new BadRequestException("Unknown vesselId");
  }

  // First persist (§5): mint queryCode from a row-locked QuerySequence (atomic upsert
  // increment = INSERT … ON CONFLICT DO UPDATE … RETURNING, row-locked), seed the 9
  // checklist items, assign the creator. NOT mediated (entity birth). status = DRAFT default.
  async create(input: QuerySaveInput, user: RequestUser) {
    await this.assertRefsExist(input);
    const year = new Date().getFullYear();
    const data = this.toData(input);
    delete data.queryDate; // set to now() by the column default; backdate is Admin-only via PATCH
    return this.prisma.$transaction(async (tx) => {
      const seq = await tx.querySequence.upsert({
        where: { year },
        create: { year, lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
      });
      const query = await tx.query.create({
        data: {
          queryCode: formatQueryCode(year, seq.lastNumber),
          assignedUserId: input.assignedUserId ?? user.userId,
          tenantId: user.tenantId,
          ...data,
        } as Prisma.QueryUncheckedCreateInput,
      });
      const defs = await tx.checklistDefinition.findMany({ orderBy: { order: "asc" } });
      if (defs.length)
        await tx.queryChecklistItem.createMany({
          data: defs.map((d) => ({
            queryId: query.id,
            itemKey: d.itemKey,
            tenantId: user.tenantId,
          })),
        });
      await this.syncDgIndicator(query.id, tx);
      return this.getWithin(tx, query.id);
    });
  }

  async get(id: string) {
    return this.getWithin(this.prisma, id);
  }

  private async getWithin(client: Prisma.TransactionClient | PrismaService, id: string) {
    const query = await client.query.findUnique({
      where: { id },
      include: {
        cargo: { orderBy: { rowIndex: "asc" } },
        checklist: { orderBy: { itemKey: "asc" } },
        files: true,
      },
    });
    if (!query) throw new NotFoundException("Query not found");
    return query;
  }

  // dgIndicator is auto-TRUE when any cargo is DG; manual true stands; never auto-cleared
  // (§4.5 / §7.2). Called after any cargo mutation and at create.
  async syncDgIndicator(queryId: string, tx: Prisma.TransactionClient): Promise<void> {
    const dgCount = await tx.cargoItem.count({ where: { queryId, isDangerous: true } });
    if (dgCount > 0) await tx.query.update({ where: { id: queryId }, data: { dgIndicator: true } });
  }
}
