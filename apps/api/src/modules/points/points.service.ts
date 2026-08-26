// apps/api/src/modules/points/points.service.ts
import { Injectable, NotFoundException, ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { PointSaveInput, PointUpdateInput } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import type { RequestUser } from "../auth/types";
import { QueryLockService } from "../award/query-lock.service";

@Injectable()
export class PointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly lock: QueryLockService,
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
    // S5.9.5 (D6) — a locked query (`awardSnapshot != null`, i.e. QUOTING_CLIENT /
    // AWAITING_CLIENT_DECISION) refuses every write. First, before any other read, so a locked
    // query never does partial work.
    await this.lock.assertUnlocked(queryId);
    await this.assertQueryExists(queryId);
    const id = randomUUID();
    let created: unknown;
    const result = await this.mediator.apply(
      { entity: "point", id, action: "@create", queryId, actorId: user.userId },
      async (tx) => {
        created = await tx.point.create({
          data: { id, queryId, tenantId: user.tenantId, ...input } as Prisma.PointUncheckedCreateInput,
        });
      },
    );
    if (result.needsConfirmation) {
      throw new ConflictException({
        message: "Change requires confirmation",
        needsChangeOrder: true,
        preview: result.preview,
      });
    }
    return created;
  }

  async update(queryId: string, pointId: string, input: PointUpdateInput, user: RequestUser) {
    // S5.9.5 (D6) — a locked query (`awardSnapshot != null`, i.e. QUOTING_CLIENT /
    // AWAITING_CLIENT_DECISION) refuses every write. First, before any other read, so a locked
    // query never does partial work.
    await this.lock.assertUnlocked(queryId);
    await this.load(queryId, pointId);
    // `reason` is ChangeRequest metadata, not a point column — strip it before it can reach
    // `fields`/highestImpactField or the Prisma patch (Task 10, SB6 §7.2).
    const { reason, ...pointInput } = input;
    const fields = Object.keys(pointInput);
    if (fields.length === 0) return this.load(queryId, pointId);
    let updated: unknown;
    const result = await this.mediator.apply(
      {
        entity: "point",
        id: pointId,
        field: this.impacts.highestImpactField("point", fields),
        patch: pointInput,
        queryId,
        actorId: user.userId,
        reason,
      },
      async (tx) => {
        updated = await tx.point.update({
          where: { id: pointId },
          data: pointInput as Prisma.PointUncheckedUpdateInput,
        });
      },
    );
    if (result.needsConfirmation) {
      throw new ConflictException({
        message: "Change requires confirmation",
        needsChangeOrder: true,
        preview: result.preview,
      });
    }
    return updated;
  }

  async remove(queryId: string, pointId: string, user: RequestUser) {
    // S5.9.5 (D6) — a locked query (`awardSnapshot != null`, i.e. QUOTING_CLIENT /
    // AWAITING_CLIENT_DECISION) refuses every write. First, before any other read, so a locked
    // query never does partial work.
    await this.lock.assertUnlocked(queryId);
    await this.load(queryId, pointId);

    // Guard: a point still used by a leg cannot be deleted. Without this the
    // Leg→Point SetNull FK would silently null the leg's endpoint, manufacturing
    // a dangling (un-drawable, C1-blocking) leg. Mirror of the PointEditor guard.
    const referencingLeg = await this.prisma.leg.findFirst({
      where: { queryId, OR: [{ originPointId: pointId }, { destinationPointId: pointId }] },
      select: { legCode: true },
    });
    if (referencingLeg) {
      throw new ConflictException(
        `Point is referenced by leg ${referencingLeg.legCode} — remove or edit that leg first`,
      );
    }

    const result = await this.mediator.apply(
      { entity: "point", id: pointId, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        await tx.point.delete({ where: { id: pointId } });
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
