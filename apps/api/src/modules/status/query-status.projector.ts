import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { deriveQueryStatus } from "@svyft/shared";
import type { LegStatus, QueryMilestones, QueryStatus } from "@svyft/shared";
import type { StatusChangedEvent } from "./status.service";

// Derived/rollup query status is a PROJECTION, not a machine (§7.2). This subscriber
// recomputes it whenever a leg status changes. Plan 3 has no Query/Leg tables yet, so
// `recompute` records intent; Plan 5 loads the query's leg statuses + milestones and
// persists Query.status via `project()`.
@Injectable()
export class QueryStatusProjector {
  private readonly logger = new Logger(QueryStatusProjector.name);

  project(legStatuses: LegStatus[], milestones: QueryMilestones = {}): QueryStatus {
    return deriveQueryStatus(legStatuses, milestones);
  }

  @OnEvent("leg.status.changed")
  async onLegStatusChanged(event: StatusChangedEvent): Promise<void> {
    await this.recompute(event.queryId);
  }

  async recompute(queryId?: string): Promise<void> {
    if (!queryId) return;
    // Plan 5:
    //   const legs = await prisma.leg.findMany({ where: { queryId } });
    //   const status = this.project(legs.map((l) => l.status as LegStatus), milestones);
    //   await prisma.query.update({ where: { id: queryId }, data: { status } });
    this.logger.debug(`recompute query status for ${queryId} (persistence lands in Plan 5)`);
  }
}
