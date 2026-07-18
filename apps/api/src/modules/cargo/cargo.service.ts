import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { CargoCreateInput, CargoUpdateInput } from "@svyft/shared";
import { randomUUID } from "node:crypto";
import type { RequestUser } from "../auth/types";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { QueriesService } from "../queries/queries.service";

@Injectable()
export class CargoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly queries: QueriesService,
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
}
