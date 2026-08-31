import { Inject, Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { findTransition } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { StatusRegistry } from "./status.registry";
import { STATUS_STATE_STORE, type StatusStateStore } from "./state-store";
import { IllegalTransitionError, TransitionBlockedError } from "./errors";
import type { FireContext } from "./status.types";

export interface StatusChangedEvent {
  entity: string;
  entityId: string;
  from: string;
  to: string;
  event: string;
  actorId: string | null;
  queryId?: string;
}

export interface FireResult {
  entity: string;
  entityId: string;
  from: string;
  to: string;
  event: string;
  transitionId: string;
}

// THE ONE DOOR to any owned status change (§7.2). load → match → guard → append
// StatusTransition (same tx) → run effect (same tx) → emit after commit.
@Injectable()
export class StatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: StatusRegistry,
    @Inject(STATUS_STATE_STORE) private readonly store: StatusStateStore,
    private readonly events: EventEmitter2,
  ) {}

  async fire(
    key: string,
    entityId: string,
    event: string,
    ctx: FireContext = {},
  ): Promise<FireResult> {
    // Concurrency: current state is read then a new transition row is appended within one
    // READ COMMITTED tx, without a row lock. Per spec §8.5 the system is last-write-wins with
    // no record locking; two concurrent fires on the same (entity,entityId) can both append —
    // a duplicate SAME-transition row is benign (end state is unchanged). Exclusivity hardening
    // (row lock / serializable + retry) is deferred to Plan 4/5, where the change-order cascade
    // reads prior state from this log and ordering starts to matter.
    const machine = this.registry.get(key);

    const { from, to, transitionId } = await this.prisma.$transaction(async (tx) => {
      const current = (await this.store.load(key, entityId, tx)) ?? machine.initial;

      const transition = findTransition(machine, current, event);
      if (!transition) throw new IllegalTransitionError(key, current, event);

      const guardResult = transition.guard ? transition.guard({ ...ctx, tx }) : true;
      if (guardResult !== true) throw new TransitionBlockedError(guardResult);

      const row = await tx.statusTransition.create({
        data: {
          entity: key,
          entityId,
          from: current,
          to: transition.to,
          event,
          reason: ctx.reason ?? null,
          actorId: ctx.actorId ?? null,
          tenantId: ctx.tenantId ?? null,
        },
      });

      // Owned statuses persist their column in the SAME tx (log-backed keys → no-op).
      await this.store.save(key, entityId, transition.to, tx);

      if (transition.effect) await transition.effect({ ...ctx, tx });

      return { from: current, to: transition.to, transitionId: row.id };
    });

    // Emit AFTER commit so subscribers observe committed state. Awaited (emitAsync, not
    // emit) so `fire()` does not resolve until the projector's rollup has actually landed —
    // a fire-and-forget emit here raced a caller that fires N legs then immediately does its
    // OWN authoritative recompute (Create Query, Plan 5 Task 9): the projector's stale
    // in-flight recompute (still reading rfqReadyAt as null) could commit AFTER the caller's
    // final write and silently regress RFQ_READY back to CREATED. Only ever one listener
    // (QueryStatusProjector.onLegStatusChanged), which already swallows its own errors, so
    // awaiting it cannot turn a projector failure into a fire() failure.
    const payload: StatusChangedEvent = {
      entity: key,
      entityId,
      from,
      to,
      event,
      actorId: ctx.actorId ?? null,
      queryId: ctx.queryId,
    };
    await this.events.emitAsync(`${key}.status.changed`, payload);

    return { entity: key, entityId, from, to, event, transitionId };
  }
}
