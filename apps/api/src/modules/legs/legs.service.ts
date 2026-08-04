// apps/api/src/modules/legs/legs.service.ts
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { checkModeEndpoints, formatLegCode, LegEvent, type Finding, type FreightMode, type LegSaveInput } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { StatusService } from "../status/status.service";
import type { RequestUser } from "../auth/types";

@Injectable()
export class LegsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly status: StatusService,
  ) {}

  private async assertQueryExists(queryId: string): Promise<void> {
    const q = await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } });
    if (!q) throw new NotFoundException("Query not found");
  }

  private load(queryId: string, legId: string) {
    return this.prisma.leg
      .findFirst({ where: { id: legId, queryId }, include: { legCargo: { select: { cargoItemId: true } } } })
      .then((l) => {
        if (!l) throw new NotFoundException("Leg not found");
        return l;
      });
  }

  private async assertPointRef(queryId: string, pointId: string | null | undefined): Promise<void> {
    if (!pointId) return;
    const p = await this.prisma.point.findFirst({ where: { id: pointId, queryId }, select: { id: true } });
    if (!p) throw new BadRequestException(`Point ${pointId} does not belong to this query`);
  }

  private async assertCargoRefs(queryId: string, cargoIds: string[]): Promise<void> {
    if (!cargoIds.length) return;
    const found = await this.prisma.cargoItem.count({ where: { queryId, id: { in: cargoIds } } });
    if (found !== new Set(cargoIds).size)
      throw new BadRequestException("One or more assigned cargo rows do not belong to this query");
  }

  // V-M1 (spec §10.4) blocks a leg save with an impossible mode↔endpoint. Only checkable when
  // mode + both endpoints are present; partial legs are allowed (draft).
  private async assertModeEndpoints(
    queryId: string,
    mode: FreightMode | null | undefined,
    originId: string | null | undefined,
    destId: string | null | undefined,
    legId?: string,
  ): Promise<void> {
    if (!mode || !originId || !destId) return;
    const [o, d] = await Promise.all([
      this.prisma.point.findFirst({ where: { id: originId, queryId }, select: { type: true } }),
      this.prisma.point.findFirst({ where: { id: destId, queryId }, select: { type: true } }),
    ]);
    if (o && d && !checkModeEndpoints(mode, o.type, d.type)) {
      const finding: Finding = {
        rule: "V-M1",
        severity: "blocking",
        scope: { type: "leg", ...(legId ? { id: legId } : {}) },
        message: `Leg mode ${mode} is incompatible with its endpoint types`,
      };
      throw new HttpException({ findings: [finding] }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
  }

  async create(queryId: string, input: LegSaveInput, user: RequestUser) {
    await this.assertQueryExists(queryId);
    await this.assertPointRef(queryId, input.originPointId);
    await this.assertPointRef(queryId, input.destinationPointId);
    const cargoIds = input.assignedCargoIds ?? [];
    await this.assertCargoRefs(queryId, cargoIds);
    await this.assertModeEndpoints(queryId, input.mode, input.originPointId, input.destinationPointId);

    const id = randomUUID();
    const result = await this.mediator.apply(
      { entity: "leg", id, action: "@create", queryId, actorId: user.userId },
      async (tx) => {
        const seq = await tx.codeSequence.upsert({
          where: { key: `LEG:${queryId}` },
          create: { key: `LEG:${queryId}`, lastNumber: 1 },
          update: { lastNumber: { increment: 1 } },
        });
        await tx.leg.create({
          data: {
            id,
            queryId,
            tenantId: user.tenantId,
            legCode: formatLegCode(seq.lastNumber),
            legName: input.legName ?? null,
            originPointId: input.originPointId ?? null,
            destinationPointId: input.destinationPointId ?? null,
            mode: input.mode ?? null,
            readyDate: input.readyDate ? new Date(input.readyDate) : null,
            targetDelivery: input.targetDelivery ? new Date(input.targetDelivery) : null,
          },
        });
        if (cargoIds.length)
          await tx.legCargo.createMany({
            data: cargoIds.map((cid) => ({ legId: id, cargoItemId: cid, tenantId: user.tenantId })),
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
    return this.load(queryId, id);
  }

  async update(queryId: string, legId: string, input: LegSaveInput, user: RequestUser) {
    const existing = await this.load(queryId, legId);
    if (input.originPointId !== undefined) await this.assertPointRef(queryId, input.originPointId);
    if (input.destinationPointId !== undefined) await this.assertPointRef(queryId, input.destinationPointId);
    if (input.assignedCargoIds !== undefined) await this.assertCargoRefs(queryId, input.assignedCargoIds);

    const effMode = input.mode !== undefined ? input.mode : existing.mode;
    const effOrigin = input.originPointId !== undefined ? input.originPointId : existing.originPointId;
    const effDest = input.destinationPointId !== undefined ? input.destinationPointId : existing.destinationPointId;
    await this.assertModeEndpoints(queryId, effMode, effOrigin, effDest, legId);

    // `reason` is ChangeRequest metadata, not a leg column — strip it before it can reach
    // `fields`/highestImpactField or the Prisma patch (Task 10, SB6 §7.2).
    const { reason, ...fieldsInput } = input;
    const fields = Object.keys(fieldsInput);
    if (fields.length === 0) return this.load(queryId, legId);

    const { assignedCargoIds, readyDate, targetDelivery, ...rest } = fieldsInput;
    const result = await this.mediator.apply(
      {
        entity: "leg",
        id: legId,
        field: this.impacts.highestImpactField("leg", fields),
        patch: fieldsInput,
        queryId,
        actorId: user.userId,
        reason,
      },
      async (tx) => {
        await tx.leg.update({
          where: { id: legId },
          data: {
            ...rest,
            ...(readyDate !== undefined ? { readyDate: readyDate ? new Date(readyDate) : null } : {}),
            ...(targetDelivery !== undefined ? { targetDelivery: targetDelivery ? new Date(targetDelivery) : null } : {}),
          } as Prisma.LegUncheckedUpdateInput,
        });
        if (assignedCargoIds !== undefined) {
          await tx.legCargo.deleteMany({ where: { legId } });
          if (assignedCargoIds.length)
            await tx.legCargo.createMany({
              data: assignedCargoIds.map((cid) => ({ legId, cargoItemId: cid, tenantId: user.tenantId })),
            });
        }
      },
    );
    if (result.needsConfirmation) {
      throw new ConflictException({
        message: "Change requires confirmation",
        needsChangeOrder: true,
        preview: result.preview,
      });
    }
    return this.load(queryId, legId);
  }

  async remove(queryId: string, legId: string, user: RequestUser) {
    await this.load(queryId, legId);
    const result = await this.mediator.apply(
      { entity: "leg", id: legId, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        await tx.leg.delete({ where: { id: legId } }); // legCargo cascades
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

  // Fire the leg machine forward. THE caller (Create Query) must have validated the whole route
  // first (validateRoute phase='create' clean) — we pass routeValid:true so the guard passes.
  async markReadyForRfq(legId: string, ctx: { queryId: string; actorId?: string | null; tenantId?: string | null }) {
    await this.status.fire("leg", legId, LegEvent.VALIDATE_PASS, {
      routeValid: true,
      queryId: ctx.queryId,
      actorId: ctx.actorId ?? null,
      tenantId: ctx.tenantId ?? null,
    });
  }
}
