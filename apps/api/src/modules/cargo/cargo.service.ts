import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { CargoCreateInput, CargoUpdateInput } from "@svyft/shared";
import { randomUUID } from "node:crypto";
import type { RequestUser } from "../auth/types";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { FilesService, type MsdsUpload } from "../files/files.service";
import { QueriesService } from "../queries/queries.service";

@Injectable()
export class CargoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly queries: QueriesService,
    private readonly files: FilesService,
  ) {}

  private async assertQueryExists(queryId: string): Promise<void> {
    if (!(await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } })))
      throw new NotFoundException("Query not found");
  }

  private async load(queryId: string, cid: string) {
    const row = await this.prisma.cargoItem.findFirst({ where: { id: cid, queryId } });
    if (!row) throw new NotFoundException("Cargo row not found");
    return row;
  }

  // Mediated @create: assign the next rowIndex, persist the row, re-sync dgIndicator — all
  // inside the Free-path strategy's transaction.
  async create(queryId: string, input: CargoCreateInput, user: RequestUser) {
    await this.assertQueryExists(queryId);
    const id = randomUUID();
    let created: unknown;
    await this.mediator.apply(
      { entity: "cargo", id, action: "@create", queryId, actorId: user.userId },
      async (tx) => {
        // KNOWN RACE (deferred, not fixed): this is a read-then-write (MAX(rowIndex)+1) inside
        // a READ COMMITTED tx with no unique constraint on (queryId, rowIndex). Two concurrent
        // POST /queries/:id/cargo on the *same* query can both read the same max and each
        // create their own row with the same rowIndex — a duplicate ordinal, not data loss (both
        // rows persist). Accepted for Stage 3 per spec §8.5 ("last-write-wins, no record
        // locking"). Reads order by rowIndex with a createdAt/id tie-break (see
        // QueriesService.getWithin), so display order stays deterministic even if a duplicate
        // occurs. Follow-up (Stage 3, not scheduled): harden with a unique (queryId, rowIndex)
        // constraint + retry-on-conflict, or a per-query atomic counter (à la QuerySequence).
        const max = await tx.cargoItem.aggregate({ where: { queryId }, _max: { rowIndex: true } });
        created = await tx.cargoItem.create({
          data: {
            id,
            queryId,
            tenantId: user.tenantId,
            rowIndex: (max._max.rowIndex ?? 0) + 1,
            poReference: input.poReference,
            productName: input.productName,
            referenceTags: input.referenceTags ?? [],
            hsCode: input.hsCode ?? null,
            packageType: input.packageType,
            isDangerous: input.isDangerous ?? false,
            qty: input.qty,
            dimL: input.dimL,
            dimW: input.dimW,
            dimH: input.dimH,
            netWt: input.netWt ?? null,
            grossWt: input.grossWt,
          },
        });
        await this.queries.syncDgIndicator(queryId, tx);
      },
    );
    return created;
  }

  async update(queryId: string, cid: string, input: CargoUpdateInput, user: RequestUser) {
    await this.load(queryId, cid);
    const fields = Object.keys(input);
    if (fields.length === 0) return this.load(queryId, cid);
    let updated: unknown;
    await this.mediator.apply(
      {
        entity: "cargo",
        id: cid,
        field: this.impacts.highestImpactField("cargo", fields),
        patch: input,
        queryId,
        actorId: user.userId,
      },
      async (tx) => {
        updated = await tx.cargoItem.update({
          where: { id: cid },
          data: input as Prisma.CargoItemUncheckedUpdateInput,
        });
        await this.queries.syncDgIndicator(queryId, tx);
      },
    );
    return updated;
  }

  async remove(queryId: string, cid: string, user: RequestUser) {
    await this.load(queryId, cid);
    await this.mediator.apply(
      { entity: "cargo", id: cid, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        await tx.cargoItem.delete({ where: { id: cid } });
        await this.queries.syncDgIndicator(queryId, tx);
      },
    );
  }

  // Store the PDF + FileAsset, then link cargo.msdsFileId through the mediator (Corrective).
  // ORDERING IS LOAD-BEARING: `load` (queryId+cid scoped findFirst) MUST run before
  // `storeMsds` — it verifies the cargo row exists under this exact query, so a
  // malformed/mismatched queryId 404s/P2023s here rather than storeMsds ever writing a
  // FileAsset (or interpolating an attacker-controlled queryId into the storage path) for a
  // row that isn't there.
  async attachMsds(queryId: string, cid: string, file: MsdsUpload | undefined, user: RequestUser) {
    await this.load(queryId, cid);
    const asset = await this.files.storeMsds(queryId, file, user.userId); // 400s a non-PDF/no-file
    let updated: unknown;
    await this.mediator.apply(
      {
        entity: "cargo",
        id: cid,
        field: "msdsFileId",
        patch: { msdsFileId: asset.id },
        queryId,
        actorId: user.userId,
      },
      async (tx) => {
        updated = await tx.cargoItem.update({ where: { id: cid }, data: { msdsFileId: asset.id } });
      },
    );
    return updated;
  }
}
