import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  collectCreateFindings,
  formatQueryCode,
  Role,
  type ChangeRequest,
  type QuerySaveInput,
} from "@svyft/shared";
import type { RequestUser } from "../auth/types";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { QueryStatusProjector } from "../status/query-status.projector";

@Injectable()
export class QueriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly projector: QueryStatusProjector,
  ) {}

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
        // rowIndex asc is the primary sort; createdAt/id are a stable tie-break for the rare
        // case of a duplicate rowIndex (see CargoService.create — concurrent-create race,
        // deferred per spec §8.5) so display order stays deterministic either way.
        cargo: { orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
        checklist: { orderBy: { itemKey: "asc" } },
        files: true,
      },
    });
    if (!query) throw new NotFoundException("Query not found");
    return query;
  }

  // PATCH /queries/:id (§5.2): one mediator call per PATCH (= per wizard step). Missing
  // query → 404 before the mediator runs; queryDate is Admin-only (backdate guard, §7.2);
  // an empty patch is a no-op read. The uow applies the whole validated patch + re-syncs
  // dgIndicator inside the strategy's transaction (Free path → apply → revalidate → log).
  async patch(id: string, input: QuerySaveInput, user: RequestUser) {
    const existing = await this.prisma.query.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException("Query not found");

    if (input.queryDate !== undefined && user.role !== Role.ADMINISTRATOR) {
      throw new ForbiddenException("Only an Administrator may edit the Query Date");
    }
    await this.assertRefsExist(input);

    const fields = Object.keys(input);
    if (fields.length === 0) return this.get(id);
    const data = this.toData(input);

    const req: ChangeRequest = {
      entity: "query",
      id,
      field: this.impacts.highestImpactField("query", fields),
      patch: input,
      queryId: id,
      actorId: user.userId,
    };
    await this.mediator.apply(req, async (tx) => {
      await tx.query.update({ where: { id }, data: data as Prisma.QueryUncheckedUpdateInput });
      await this.syncDgIndicator(id, tx);
    });
    return this.get(id);
  }

  // dgIndicator is auto-TRUE when any cargo is DG; manual true stands; never auto-cleared
  // (§4.5 / §7.2). Called after any cargo mutation and at create.
  async syncDgIndicator(queryId: string, tx: Prisma.TransactionClient): Promise<void> {
    const dgCount = await tx.cargoItem.count({ where: { queryId, isDangerous: true } });
    if (dgCount > 0) await tx.query.update({ where: { id: queryId }, data: { dgIndicator: true } });
  }

  // Create Query (§13): run the create-phase field/cargo catalogue (F1/F6; F2–F5 already
  // enforced at save). Route rules R1–R9 + the leg rollup are Plan 5. On pass, set the
  // rfqReadyAt milestone and let the projector persist RFQ_READY (never hand-write status).
  async createQuery(id: string, _user: RequestUser) {
    const q = await this.prisma.query.findUnique({
      where: { id },
      include: {
        cargo: { select: { id: true, isDangerous: true, msdsFileId: true, poReference: true } },
      },
    });
    if (!q) throw new NotFoundException("Query not found");

    const findings = collectCreateFindings(
      {
        id: q.id,
        clientId: q.clientId,
        contactName: q.contactName,
        contactEmail: q.contactEmail,
        contactPhone: q.contactPhone,
        readyDate: q.readyDate,
        targetDelivery: q.targetDelivery,
        incoterms: q.incoterms,
      },
      q.cargo,
    );
    if (findings.length > 0) throw new HttpException({ findings }, HttpStatus.UNPROCESSABLE_ENTITY);

    await this.prisma.$transaction(async (tx) => {
      await tx.query.update({ where: { id }, data: { rfqReadyAt: new Date() } });
      await this.projector.recompute(id, tx); // persists RFQ_READY
    });
    const updated = await this.prisma.query.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    return updated!;
  }
}
