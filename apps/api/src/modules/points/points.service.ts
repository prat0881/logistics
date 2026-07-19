// apps/api/src/modules/points/points.service.ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { PointSaveInput, PointUpdateInput } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import type { RequestUser } from "../auth/types";

@Injectable()
export class PointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
  ) {}

  private async assertQueryExists(queryId: string): Promise<void> {
    const q = await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } });
    if (!q) throw new NotFoundException("Query not found");
  }

  private async load(queryId: string, pointId: string) {
    const p = await this.prisma.point.findFirst({ where: { id: pointId, queryId } });
    if (!p) throw new NotFoundException("Point not found");
    return p;
  }

  async create(queryId: string, input: PointSaveInput, user: RequestUser) {
    await this.assertQueryExists(queryId);
    const id = randomUUID();
    let created: unknown;
    await this.mediator.apply(
      { entity: "point", id, action: "@create", queryId, actorId: user.userId },
      async (tx) => {
        created = await tx.point.create({
          data: { id, queryId, tenantId: user.tenantId, ...input } as Prisma.PointUncheckedCreateInput,
        });
      },
    );
    return created;
  }

  async update(queryId: string, pointId: string, input: PointUpdateInput, user: RequestUser) {
    await this.load(queryId, pointId);
    const fields = Object.keys(input);
    if (fields.length === 0) return this.load(queryId, pointId);
    let updated: unknown;
    await this.mediator.apply(
      {
        entity: "point",
        id: pointId,
        field: this.impacts.highestImpactField("point", fields),
        patch: input,
        queryId,
        actorId: user.userId,
      },
      async (tx) => {
        updated = await tx.point.update({
          where: { id: pointId },
          data: input as Prisma.PointUncheckedUpdateInput,
        });
      },
    );
    return updated;
  }

  async remove(queryId: string, pointId: string, user: RequestUser) {
    await this.load(queryId, pointId);
    await this.mediator.apply(
      { entity: "point", id: pointId, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        // Referencing legs' endpoints are nulled by the SetNull FK; revalidation flags them.
        await tx.point.delete({ where: { id: pointId } });
      },
    );
  }
}
