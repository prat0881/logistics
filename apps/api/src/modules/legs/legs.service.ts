// apps/api/src/modules/legs/legs.service.ts
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  checkModeEndpoints,
  formatLegCode,
  LegEvent,
  type Finding,
  type FreightMode,
  type LegSaveInput,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { assertApplied } from "../changes/assert-applied";
import { StatusService } from "../status/status.service";
import type { RequestUser } from "../auth/types";
import { warehousePointIds, findWarehouseYesConflict } from "../rfq/warehouse.util";
import { QueryLockService } from "../award/query-lock.service";

@Injectable()
export class LegsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly status: StatusService,
    private readonly lock: QueryLockService,
  ) {}

  private async assertQueryExists(queryId: string): Promise<void> {
    const q = await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } });
    if (!q) throw new NotFoundException("Query not found");
  }

  private load(queryId: string, legId: string) {
    return this.prisma.leg
      .findFirst({
        where: { id: legId, queryId },
        include: { legPackages: { select: { packageId: true } } },
      })
      .then((l) => {
        if (!l) throw new NotFoundException("Leg not found");
        return l;
      });
  }

  private async assertPointRef(queryId: string, pointId: string | null | undefined): Promise<void> {
    if (!pointId) return;
    const p = await this.prisma.point.findFirst({
      where: { id: pointId, queryId },
      select: { id: true },
    });
    if (!p) throw new BadRequestException(`Point ${pointId} does not belong to this query`);
  }

  private async assertPackageRefs(queryId: string, packageIds: string[]): Promise<void> {
    if (!packageIds.length) return;
    const found = await this.prisma.package.count({ where: { queryId, id: { in: packageIds } } });
    if (found !== new Set(packageIds).size)
      throw new BadRequestException("One or more assigned packages do not belong to this query");
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

  // F8 (Task 10, design §10): a leg being turned to warehouseHandlingIncluded=true must not
  // share a warehouse point with a sibling leg that already carries Yes for it. Distribute-time
  // already enforces this (rfq.service.ts validateLegForDistribution); this is the write-time
  // mirror so the conflict surfaces immediately on the PATCH instead of only at distribute.
  private async assertWarehouseExclusivity(queryId: string, legId: string): Promise<void> {
    const leg = await this.prisma.leg.findUnique({
      where: { id: legId },
      select: {
        originPoint: { select: { id: true, type: true } },
        destinationPoint: { select: { id: true, type: true } },
      },
    });
    const whIds = warehousePointIds([leg?.originPoint, leg?.destinationPoint]);
    const conflict = await findWarehouseYesConflict(this.prisma, {
      queryId,
      legId,
      warehousePointIds: whIds,
    });
    if (conflict)
      throw new UnprocessableEntityException({
        findings: [
          {
            rule: "F8",
            severity: "blocking",
            scope: { type: "leg", id: legId },
            message: "Another leg already carries warehouse handling for this warehouse.",
          },
        ],
      });
  }

  async create(queryId: string, input: LegSaveInput, user: RequestUser) {
    // S5.9.5 (D6) — a locked query (`awardSnapshot != null`, i.e. QUOTING_CLIENT /
    // AWAITING_CLIENT_DECISION) refuses every write. First, before any other read, so a locked
    // query never does partial work.
    await this.lock.assertUnlocked(queryId);
    await this.assertQueryExists(queryId);
    await this.assertPointRef(queryId, input.originPointId);
    await this.assertPointRef(queryId, input.destinationPointId);
    const packageIds = input.assignedPackageIds ?? [];
    await this.assertPackageRefs(queryId, packageIds);
    await this.assertModeEndpoints(
      queryId,
      input.mode,
      input.originPointId,
      input.destinationPointId,
    );

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
        if (packageIds.length)
          await tx.legPackage.createMany({
            data: packageIds.map((pid) => ({ legId: id, packageId: pid, tenantId: user.tenantId })),
          });
      },
    );
    assertApplied(result);
    return this.load(queryId, id);
  }

  async update(queryId: string, legId: string, input: LegSaveInput, user: RequestUser) {
    // S5.9.5 (D6) — a locked query (`awardSnapshot != null`, i.e. QUOTING_CLIENT /
    // AWAITING_CLIENT_DECISION) refuses every write. First, before any other read, so a locked
    // query never does partial work.
    await this.lock.assertUnlocked(queryId);
    const existing = await this.load(queryId, legId);
    if (input.originPointId !== undefined) await this.assertPointRef(queryId, input.originPointId);
    if (input.destinationPointId !== undefined)
      await this.assertPointRef(queryId, input.destinationPointId);
    if (input.assignedPackageIds !== undefined)
      await this.assertPackageRefs(queryId, input.assignedPackageIds);

    const effMode = input.mode !== undefined ? input.mode : existing.mode;
    const effOrigin =
      input.originPointId !== undefined ? input.originPointId : existing.originPointId;
    const effDest =
      input.destinationPointId !== undefined
        ? input.destinationPointId
        : existing.destinationPointId;
    await this.assertModeEndpoints(queryId, effMode, effOrigin, effDest, legId);

    // `reason` is ChangeRequest metadata, not a leg column — strip it before it can reach
    // `fields`/highestImpactField or the Prisma patch (Task 10, SB6 §7.2).
    const { reason, ...fieldsInput } = input;
    const fields = Object.keys(fieldsInput);
    if (fields.length === 0) return this.load(queryId, legId);

    // Task 11: turning the warehouse toggle ON must not collide with a sibling leg that
    // already carries Yes for the same warehouse point (F8) — checked eagerly, before the
    // mediator runs, so a conflict never even reaches the free/change-order fork.
    if (input.warehouseHandlingIncluded === true)
      await this.assertWarehouseExclusivity(queryId, legId);

    const { assignedPackageIds, chargeLineDefinitionIds, readyDate, targetDelivery, ...rest } =
      fieldsInput;
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
            ...(readyDate !== undefined
              ? { readyDate: readyDate ? new Date(readyDate) : null }
              : {}),
            ...(targetDelivery !== undefined
              ? { targetDelivery: targetDelivery ? new Date(targetDelivery) : null }
              : {}),
          } as Prisma.LegUncheckedUpdateInput,
        });
        if (assignedPackageIds !== undefined) {
          await tx.legPackage.deleteMany({ where: { legId } });
          if (assignedPackageIds.length)
            await tx.legPackage.createMany({
              data: assignedPackageIds.map((pid) => ({
                legId,
                packageId: pid,
                tenantId: user.tenantId,
              })),
            });
        }
        // chargeLineDefinitionIds is not a Leg column (LegChargeLineSelection is its own
        // table) — replace-set semantics, same shape as the assignedPackageIds block above.
        if (chargeLineDefinitionIds !== undefined) {
          await tx.legChargeLineSelection.deleteMany({ where: { legId } });
          if (chargeLineDefinitionIds.length)
            await tx.legChargeLineSelection.createMany({
              data: chargeLineDefinitionIds.map((definitionId) => ({
                legId,
                definitionId,
                tenantId: user.tenantId,
              })),
            });
        }
      },
    );
    assertApplied(result);
    return this.load(queryId, legId);
  }

  async remove(queryId: string, legId: string, user: RequestUser) {
    // S5.9.5 (D6) — a locked query (`awardSnapshot != null`, i.e. QUOTING_CLIENT /
    // AWAITING_CLIENT_DECISION) refuses every write. First, before any other read, so a locked
    // query never does partial work.
    await this.lock.assertUnlocked(queryId);
    await this.load(queryId, legId);
    const result = await this.mediator.apply(
      { entity: "leg", id: legId, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        await tx.leg.delete({ where: { id: legId } }); // legPackage cascades
      },
    );
    assertApplied(result);
  }

  // Fire the leg machine forward. THE caller (Create Query) must have validated the whole route
  // first (validateRoute phase='create' clean) — we pass routeValid:true so the guard passes.
  async markReadyForRfq(
    legId: string,
    ctx: { queryId: string; actorId?: string | null; tenantId?: string | null },
  ) {
    await this.status.fire("leg", legId, LegEvent.VALIDATE_PASS, {
      routeValid: true,
      queryId: ctx.queryId,
      actorId: ctx.actorId ?? null,
      tenantId: ctx.tenantId ?? null,
    });
  }
}
