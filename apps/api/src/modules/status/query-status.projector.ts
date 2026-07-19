import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { deriveQueryStatus } from "@svyft/shared";
import type { LegStatus, QueryMilestones, QueryStatus } from "@svyft/shared";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { StatusChangedEvent } from "./status.service";

// Derived/rollup query status is a PROJECTION, not a machine (§7.2). THE one door that
// persists Query.status. Plan 4 has no legs, so status is driven by query-level
// milestones (rfqReadyAt); the leg rollup fills in when legs land (Plan 5).
@Injectable()
export class QueryStatusProjector {
  private readonly logger = new Logger(QueryStatusProjector.name);
  constructor(private readonly prisma: PrismaService) {}

  project(legStatuses: LegStatus[], milestones: QueryMilestones = {}): QueryStatus {
    return deriveQueryStatus(legStatuses, milestones);
  }

  @OnEvent("leg.status.changed")
  async onLegStatusChanged(event: StatusChangedEvent): Promise<void> {
    try {
      await this.recompute(event.queryId);
    } catch (err) {
      this.logger.error(`query-status recompute failed for ${event.queryId}`, err as Error);
    }
  }

  // Persist the projected status. `client` lets a caller (Create Query) run this inside
  // its own transaction. Loads real leg statuses (Plan 5).
  async recompute(
    queryId?: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    if (!queryId) return;
    const q = await client.query.findUnique({ where: { id: queryId }, select: { rfqReadyAt: true } });
    if (!q) return;
    const legs = await client.leg.findMany({ where: { queryId }, select: { status: true } });
    const legStatuses = legs.map((l) => l.status) as LegStatus[];
    // `created` is emergent from the leg rollup now — only the rfqReady milestone is passed.
    const status = this.project(legStatuses, { rfqReady: !!q.rfqReadyAt });
    await client.query.update({ where: { id: queryId }, data: { status } });
  }
}
