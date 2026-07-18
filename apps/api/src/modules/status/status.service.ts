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
          actorId: ctx.actorId ?? null,
          tenantId: ctx.tenantId ?? null,
        },
      });

      if (transition.effect) await transition.effect({ ...ctx, tx });

      return { from: current, to: transition.to, transitionId: row.id };
    });

    // Emit AFTER commit so subscribers observe committed state.
    const payload: StatusChangedEvent = {
      entity: key,
      entityId,
      from,
      to,
      event,
      actorId: ctx.actorId ?? null,
      queryId: ctx.queryId,
    };
    this.events.emit(`${key}.status.changed`, payload);

    return { entity: key, entityId, from, to, event, transitionId };
  }
}
