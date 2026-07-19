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
  LegStatus,
  Role,
  type ChangeRequest,
  type ChecklistPatchInput,
  type QuerySaveInput,
} from "@svyft/shared";
import type { RequestUser } from "../auth/types";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { QueryStatusProjector } from "../status/query-status.projector";
import { LegsService } from "../legs/legs.service";
import { RoutingService } from "../routing/routing.service";

// Reusable derived-on-read graph shape (§4.5): cargo/checklist/files (Plan 4) + points/legs
// (Plan 5, incl. each leg's legCargo join so `shapeQuery` can compute per-leg roll-ups).
// A `Prisma.validator` (not a plain `satisfies`) is required here — a plain object literal
// widens `"asc"` to `string`, which breaks `Prisma.QueryGetPayload`'s literal SortOrder typing.
const QUERY_GRAPH_ARGS = Prisma.validator<Prisma.QueryDefaultArgs>()({
  include: {
    cargo: { orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
    checklist: { orderBy: { itemKey: "asc" } },
    files: {
      select: {
        id: true,
        kind: true,
        filename: true,
        mime: true,
        sizeBytes: true,
        uploadedById: true,
        createdAt: true,
      },
    },
    points: true,
    legs: { include: { legCargo: { select: { cargoItemId: true } } }, orderBy: { createdAt: "asc" } },
  },
});
type QueryWithGraph = Prisma.QueryGetPayload<typeof QUERY_GRAPH_ARGS>;

@Injectable()
export class QueriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly projector: QueryStatusProjector,
    private readonly legs: LegsService,
    private readonly routing: RoutingService,
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

  // rowIndex asc is the primary cargo sort; createdAt/id are a stable tie-break for the rare
  // case of a duplicate rowIndex (see CargoService.create — concurrent-create race, deferred
  // per spec §8.5) so display order stays deterministic either way. files uses `select` (not
  // `files: true`) to keep the internal storageKey out of the API response.
  private async getWithin(client: Prisma.TransactionClient | PrismaService, id: string) {
    const row = await client.query.findUnique({ where: { id }, ...QUERY_GRAPH_ARGS });
    if (!row) throw new NotFoundException("Query not found");
    return this.shapeQuery(row);
  }

  // Derived-on-read (§4.5), never stored: freightMode (distinct leg modes), origin/destination
  // (pickup/delivery points), and per-leg roll-ups (packages/CBM/gross/net). Zero drift.
  private shapeQuery(row: QueryWithGraph) {
    const num = (d: Prisma.Decimal | null): number => (d == null ? 0 : Number(d));
    const cargoById = new Map(row.cargo.map((c) => [c.id, c] as const));
    const MODE_ORDER: Record<string, number> = { ROAD: 0, AIR: 1, SEA: 2 };
    const freightMode = [...new Set(row.legs.map((l) => l.mode).filter((m): m is NonNullable<typeof m> => !!m))].sort(
      (a, b) => MODE_ORDER[a] - MODE_ORDER[b],
    );
    const pick = (t: string) =>
      row.points.filter((p) => p.type === t).map((p) => ({ id: p.id, name: p.name, city: p.city, country: p.country }));
    const legs = row.legs.map((l) => {
      const { legCargo, ...rest } = l;
      const attached = legCargo.map((lc) => cargoById.get(lc.cargoItemId)).filter((c): c is NonNullable<typeof c> => !!c);
      return {
        ...rest,
        assignedCargoIds: legCargo.map((lc) => lc.cargoItemId),
        rollup: {
          totalPackages: attached.reduce((s, c) => s + c.qty, 0),
          totalCbm: attached.reduce((s, c) => s + num(c.volumeCbm), 0),
          totalGrossWt: attached.reduce((s, c) => s + num(c.grossWt), 0),
          totalNetWt: attached.reduce((s, c) => s + num(c.netWt), 0),
        },
      };
    });
    return { ...row, freightMode, origin: pick("PICKUP"), destination: pick("DELIVERY"), legs };
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

  // Create Query (§13): field catalogue (F1/F6) + the full route catalogue (R1–R9, V-M1, T1–T3,
  // C1–C3) at create phase. On pass: fire every still-DRAFT leg to READY_FOR_RFQ, then set the
  // rfqReadyAt milestone and let the projector roll the query up to RFQ_READY (never hand-write
  // status). Idempotent: a re-submit finds zero DRAFT legs, fires nothing, and just re-projects.
  async createQuery(id: string, user: RequestUser) {
    const q = await this.prisma.query.findUnique({
      where: { id },
      include: { cargo: { select: { id: true, isDangerous: true, msdsFileId: true, poReference: true } } },
    });
    if (!q) throw new NotFoundException("Query not found");

    const fieldFindings = collectCreateFindings(
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
    const routeFindings = await this.routing.validate(id, "create");
    const findings = [...fieldFindings, ...routeFindings];
    if (findings.some((f) => f.severity === "blocking"))
      throw new HttpException({ findings }, HttpStatus.UNPROCESSABLE_ENTITY);

    // Fire only DRAFT legs — makes Create Query idempotent (a re-submit fires nothing and just
    // re-projects RFQ_READY) and lets a partial-failure retry fire only the still-DRAFT legs.
    const legs = await this.prisma.leg.findMany({
      where: { queryId: id, status: LegStatus.DRAFT },
      select: { id: true },
    });
    // Fire each leg forward (own tx per fire — the route already validated, §8.5 last-write-wins).
    for (const leg of legs) {
      await this.legs.markReadyForRfq(leg.id, { queryId: id, actorId: user.userId, tenantId: user.tenantId });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.query.update({ where: { id }, data: { rfqReadyAt: new Date() } });
      await this.projector.recompute(id, tx); // all legs READY_FOR_RFQ + rfqReady ⇒ RFQ_READY
    });

    const updated = await this.prisma.query.findUnique({ where: { id }, select: { id: true, status: true } });
    return updated!;
  }

  // Checklist toggle (§5.2): not a QuerySaveInput field, not mediated — a lightweight
  // per-item boolean flip on the 9 rows seeded at create. Missing/empty checklist (no such
  // query) → 404; any itemKey not among the query's own rows → 400 before any write.
  async patchChecklist(id: string, input: ChecklistPatchInput) {
    const existing = await this.prisma.queryChecklistItem.findMany({
      where: { queryId: id },
      select: { itemKey: true },
    });
    if (existing.length === 0) throw new NotFoundException("Query not found");
    const known = new Set(existing.map((e) => e.itemKey));
    for (const item of input.items) {
      if (!known.has(item.itemKey)) {
        throw new BadRequestException(`Unknown checklist item '${item.itemKey}'`);
      }
    }
    await this.prisma.$transaction(
      input.items.map((item) =>
        this.prisma.queryChecklistItem.updateMany({
          where: { queryId: id, itemKey: item.itemKey },
          data: { checked: item.checked },
        }),
      ),
    );
    return this.get(id);
  }
}
