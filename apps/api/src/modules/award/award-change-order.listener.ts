import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { AwardDecisionStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { QueryStatusProjector } from "../status/query-status.projector";
import type { ChangeOrderReopenedEvent } from "../changes/change-order.strategy";

// S5.5 Task 4 (design §10.2) — the payoff of the change-order reversal loop. By the time this
// fires, ChangeOrderStrategy.apply (ChangesModule) has ALREADY committed the quote INVALIDATE +
// leg REOPEN status transitions and emitted this event (change-order.strategy.ts, right after
// those fires) — this listener does NOT re-fire any status transition. It only tears down the
// AWARD-side state that those transitions just made stale:
//   (a) any LegAwardDecision on a reopened leg is void — the basis it was decided against just
//       changed — reset it to a clean DRAFT so the leg can be re-shortlisted from scratch. A leg
//       that was never awarded (no LegAwardDecision row) is left alone — `updateMany` is a no-op
//       in that case, never a throw, and no audit event is written for it.
//   (b) if the query had been rolled up to QUOTING_CLIENT (Query.awardSnapshot set by
//       generateClientQuote), that frozen snapshot named a winner on the now-reopened leg and is
//       stale too — clear it exactly as AwardService.reopenComparison does (award.service.ts) so
//       the query rolls back out of QUOTING_CLIENT via the normal projector recompute.
//       🔴 (b) IS DEAD under S5.9.5 D6 and is described above as originally built, not as live
//       behaviour — the field edit that emits this event is now itself refused while the snapshot
//       is frozen. See the marker at the branch itself.
//
// Registered as a bare provider in AwardModule — system-internal, no controller route (Global
// Constraint, S5.5 plan). `ChangeOrderReopenedEvent` is imported `type`-only: no DI coupling to
// ChangesModule, no import cycle — EventEmitter2 is global, so the producer (ChangeOrderStrategy)
// and this consumer stay decoupled, same pattern as the sibling RfqNotificationsService.onLegReopened.
//
// The try/catch is kept for attributable error logging, defense-in-depth against a future
// refactor of the strategy's own catch, and consistency with the sibling listeners below — NOT
// because an uncaught throw here would otherwise break the caller. "changeorder.leg.reopened" is
// emitted directly by ChangeOrderStrategy.apply (change-order.strategy.ts, its OWN
// `this.events.emitAsync(...)` call, already wrapped in its own try/catch that logs a `warn` and
// continues — "cascade already applied"), not via StatusService.fire's `${key}.status.changed`
// emit; an uncaught throw here would surface as that `warn`, and only roll back this listener's
// own transaction — it would not fail or roll back the change-order edit itself. Mirrors
// LegQuoteProjector / QueryStatusProjector.onLegStatusChanged / RfqNotificationsService.onLegReopened.
@Injectable()
export class AwardChangeOrderListener {
  private readonly logger = new Logger(AwardChangeOrderListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projector: QueryStatusProjector,
  ) {}

  @OnEvent("changeorder.leg.reopened")
  async onLegReopened(event: ChangeOrderReopenedEvent): Promise<void> {
    try {
      // perFf[].legIds are the reopened legs — dedupe across FF groups (a query-wide edit can
      // reopen several legs across several FFs; a leg only ever needs one reset regardless of
      // how many of the event's groups happen to name it).
      const legIds = [...new Set(event.perFf.flatMap((f) => f.legIds))];

      await this.prisma.$transaction(async (tx) => {
        for (const legId of legIds) {
          // updateMany on {legId} (not update) is deliberately a no-op — not a throw — when the
          // leg was never awarded. `count` doubles as "did a decision actually exist", so a
          // REOPEN audit event is only written for legs that had one.
          // recommendedQuoteId/recommendedVariant/overrideReason are deliberately left alone —
          // they're re-derived the next time this leg is shortlisted, not this reversal's job.
          const reset = await tx.legAwardDecision.updateMany({
            where: { legId },
            data: {
              status: AwardDecisionStatus.DRAFT,
              shortlistedQuoteId: null,
              shortlistedVariant: null,
              sentByUserId: null,
              decidedByUserId: null,
              decidedAt: null,
              rejectionReason: null,
            },
          });
          if (reset.count > 0) {
            await tx.awardDecisionEvent.create({
              data: {
                legId,
                queryId: event.queryId,
                type: "REOPEN",
                reason: event.reason,
                actorId: null, // system action — cascaded from the change-order, no human decider
              },
            });
          }
        }

        // QUOTING_CLIENT teardown — only if this query had actually been generated. Same
        // Prisma.DbNull convention as reopenComparison (a nullable Json column -> SQL NULL, not
        // the JSON null literal, which would read back truthy and defeat the projector's `!!`
        // check).
        // 🔴 DEAD BRANCH under S5.9.5 D6 — kept as a safety net, not because it fires. D6 gates every
        // query-scoped write on `awardSnapshot == null`, including the change-order field edit that emits the event this
        // listener consumes, so nothing can reach this
        // line with a snapshot still frozen and the condition below is never true. Design doc D6 carries
        // the correction and the instruction: it stays because deleting it is a behaviour change nobody
        // has ruled on, it has no e2e coverage, and it must be REMOVED DELIBERATELY rather than
        // discovered. Do not "restore" reachability by relaxing the lock.
        const query = await tx.query.findUnique({
          where: { id: event.queryId },
          select: { awardSnapshot: true },
        });
        if (query?.awardSnapshot != null) {
          await tx.query.update({
            where: { id: event.queryId },
            data: { awardSnapshot: Prisma.DbNull },
          });
          await this.projector.recompute(event.queryId, tx);
        }
      });
    } catch (err) {
      this.logger.error(`award reversal on change-order failed for query ${event.queryId}`, err as Error);
    }
  }
}
