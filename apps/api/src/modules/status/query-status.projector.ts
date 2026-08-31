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
    const q = await client.query.findUnique({
      where: { id: queryId },
      select: { rfqReadyAt: true, awardSnapshot: true },
    });
    if (!q) return;
    const legs = await client.leg.findMany({ where: { queryId }, select: { status: true } });
    const legStatuses = legs.map((l) => l.status) as LegStatus[];

    // NO_RESPONSE (§9.3): a leg whose FFs ALL expired/invalidated still rolls up to
    // FULLY_QUOTED (leg-quote projector counts EXPIRED as "resolved") — so the query would
    // otherwise misreport QUOTED even though nobody actually quoted. Distinguish that case by
    // checking the query's own quotes directly: ≥1 distributed quote (not SELECT), none QUOTED,
    // and every one of them EXPIRED/INVALID.
    const quotes = await client.quote.findMany({
      where: { queryId, status: { not: "SELECT" } },
      select: { status: true },
    });
    const noResponse =
      quotes.length > 0 &&
      quotes.every((qt) => qt.status === "EXPIRED" || qt.status === "INVALID") &&
      !quotes.some((qt) => qt.status === "QUOTED");

    // `created` is emergent from the leg rollup now — only the rfqReady milestone is passed.
    // `quotingClient` (S5.4 Task 4): sourced straight from Query.awardSnapshot's presence — the
    // frozen award snapshot IS the signal (generateClientQuote writes it in the same
    // transaction as this recompute; reopenComparison clears it back to null, same transaction).
    // `awaitingClientDecision` (S5.8 Task 4): sourced the same way, from a persisted fact — an
    // ISSUED quotation exists for the query. quotation.service.ts's issue() writes that row (and
    // award.service.ts's reopenComparison supersedes it back out) in the same transaction as
    // this recompute, so the count below always reflects the just-committed write.
    // deriveQueryStatus checks awaitingClientDecision BEFORE quotingClient (status.ts), so an
    // issued quotation correctly outranks a merely-frozen award.
    const issued = await client.quotation.count({ where: { queryId, status: "ISSUED" } });
    const status = this.project(legStatuses, {
      rfqReady: !!q.rfqReadyAt,
      noResponse,
      quotingClient: !!q.awardSnapshot,
      awaitingClientDecision: issued > 0,
    });
    await client.query.update({ where: { id: queryId }, data: { status } });
  }
}
