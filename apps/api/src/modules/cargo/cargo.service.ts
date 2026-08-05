import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { CargoCreateInput, CargoDto, CargoUpdateInput } from "@svyft/shared";
import { randomUUID } from "node:crypto";
import type { RequestUser } from "../auth/types";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { shapeCargo } from "./cargo-shape";

@Injectable()
export class CargoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
  ) {}

  private async assertQueryExists(queryId: string): Promise<void> {
    if (!(await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } })))
      throw new NotFoundException("Query not found");
  }

  private async load(queryId: string, cid: string) {
    const row = await this.prisma.cargo.findFirst({ where: { id: cid, queryId } });
    if (!row) throw new NotFoundException("Cargo not found");
    return row;
  }

  // Re-reads one cargo with its full packages->items tree, shaped. Used for GET-by-id-ish call
  // sites (a no-op `update` and, later, any single-cargo read).
  private async getOne(queryId: string, cid: string): Promise<CargoDto> {
    const row = await this.prisma.cargo.findFirst({
      where: { id: cid, queryId },
      include: {
        packages: {
          orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          include: { items: { orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }] } },
        },
      },
    });
    if (!row) throw new NotFoundException("Cargo not found");
    return shapeCargo(row);
  }

  // Reads the full Query -> Cargo -> Package -> Item tree for a query, each cargo shaped with
  // its derived header (H4-H8). Same deterministic tie-break at every level (rowIndex asc, then
  // createdAt/id asc) as the pre-re-model CargoItem list, so display order stays stable even if
  // the known create-race (see `create` below) ever produces a duplicate rowIndex.
  async getTree(queryId: string): Promise<CargoDto[]> {
    await this.assertQueryExists(queryId);
    const rows = await this.prisma.cargo.findMany({
      where: { queryId },
      orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      include: {
        packages: {
          orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          include: { items: { orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }] } },
        },
      },
    });
    return rows.map(shapeCargo);
  }

  // Mediated @create: mint the next rowIndex, insert, shape the result (packages is always []
  // for a brand-new cargo) — all inside the Free-path strategy's transaction.
  async create(queryId: string, input: CargoCreateInput, user: RequestUser): Promise<CargoDto> {
    await this.assertQueryExists(queryId);
    const id = randomUUID();
    let shaped: CargoDto | undefined;
    const result = await this.mediator.apply(
      { entity: "cargo", id, action: "@create", queryId, actorId: user.userId },
      async (tx) => {
        // KNOWN RACE (deferred, not fixed): this is a read-then-write (MAX(rowIndex)+1) inside
        // a READ COMMITTED tx with no unique constraint on (queryId, rowIndex). Two concurrent
        // POST /queries/:id/cargo on the *same* query can both read the same max and each
        // create their own row with the same rowIndex — a duplicate ordinal, not data loss (both
        // rows persist). Accepted for Stage 3 per spec §8.5 ("last-write-wins, no record
        // locking") — same acceptance as the pre-re-model CargoItem.create this replaces. Reads
        // order by rowIndex with a createdAt/id tie-break (see getTree/getOne above), so display
        // order stays deterministic even if a duplicate occurs.
        const max = await tx.cargo.aggregate({ where: { queryId }, _max: { rowIndex: true } });
        const created = await tx.cargo.create({
          data: {
            id,
            queryId,
            tenantId: user.tenantId,
            rowIndex: (max._max.rowIndex ?? 0) + 1,
            poReference: input.poReference ?? null,
            label: input.label ?? null,
            dimUnit: input.dimUnit,
            weightUnit: input.weightUnit,
          },
        });
        shaped = shapeCargo({ ...created, packages: [] });
      },
    );
    if (result.needsConfirmation) {
      throw new ConflictException({
        message: "Change requires confirmation",
        needsChangeOrder: true,
        preview: result.preview,
      });
    }
    return shaped!;
  }

  // Mediated field edit: poReference/label/dimUnit/weightUnit are all Corrective (see
  // cargo.impact.ts) — a cargo grouping carries no RfqDefining fields of its own (those live on
  // Package). No `reason` to strip here: unlike packageUpdateSchema/itemUpdateSchema,
  // cargoUpdateSchema has no `reason` field (Corrective edits never need change-order
  // justification).
  async update(
    queryId: string,
    cid: string,
    input: CargoUpdateInput,
    user: RequestUser,
  ): Promise<CargoDto> {
    await this.load(queryId, cid);
    const fields = Object.keys(input);
    if (fields.length === 0) return this.getOne(queryId, cid);
    let shaped: CargoDto | undefined;
    const result = await this.mediator.apply(
      {
        entity: "cargo",
        id: cid,
        field: this.impacts.highestImpactField("cargo", fields),
        patch: input,
        queryId,
        actorId: user.userId,
      },
      async (tx) => {
        const updated = await tx.cargo.update({
          where: { id: cid },
          data: input as Prisma.CargoUncheckedUpdateInput,
        });
        const packages = await tx.package.findMany({
          where: { cargoId: cid },
          orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          include: { items: { orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }] } },
        });
        shaped = shapeCargo({ ...updated, packages });
      },
    );
    if (result.needsConfirmation) {
      throw new ConflictException({
        message: "Change requires confirmation",
        needsChangeOrder: true,
        preview: result.preview,
      });
    }
    return shaped!;
  }

  // Mediated @delete. Package/Item cascade via the schema's onDelete: Cascade (Cargo->Package,
  // Package->Item), so no extra cleanup is needed here.
  async remove(queryId: string, cid: string, user: RequestUser): Promise<void> {
    await this.load(queryId, cid);
    const result = await this.mediator.apply(
      { entity: "cargo", id: cid, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        await tx.cargo.delete({ where: { id: cid } });
      },
    );
    if (result.needsConfirmation) {
      throw new ConflictException({
        message: "Change requires confirmation",
        needsChangeOrder: true,
        preview: result.preview,
      });
    }
  }
}
