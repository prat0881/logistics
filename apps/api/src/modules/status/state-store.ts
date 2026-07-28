import { Injectable } from "@nestjs/common";
import type { LegStatus, QuoteStatus } from "@svyft/shared";
import type { Prisma } from "@prisma/client";

// How fire reads AND writes an entity's current state (§7.2). Owned statuses (leg) live in a
// column; log-only machines keep the StatusTransition log as their state.
export interface StatusStateStore {
  load(entity: string, entityId: string, tx: Prisma.TransactionClient): Promise<string | null>;
  save(entity: string, entityId: string, to: string, tx: Prisma.TransactionClient): Promise<void>;
}

export const STATUS_STATE_STORE = Symbol("STATUS_STATE_STORE");

@Injectable()
export class LogBackedStateStore implements StatusStateStore {
  async load(
    entity: string,
    entityId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const last = await tx.statusTransition.findFirst({
      where: { entity, entityId },
      orderBy: { seq: "desc" },
      select: { to: true },
    });
    return last?.to ?? null;
  }
  // The StatusTransition row IS the state — nothing else to persist. Declares the full
  // interface arity (vs. a bare `save()`) so DispatchingStateStore can call `this.log.save(...)`
  // against this class's own type without a call-site arity mismatch (TS2554).
  async save(
    _entity: string,
    _entityId: string,
    _to: string,
    _tx: Prisma.TransactionClient,
  ): Promise<void> {
    /* no-op */
  }
}

// Key-aware store (§7.2). `leg` is an OWNED column-backed status; everything else stays
// log-backed. fire always appends a StatusTransition row too (history / the Stage-4 cascade).
@Injectable()
export class DispatchingStateStore implements StatusStateStore {
  private readonly log = new LogBackedStateStore();

  async load(
    entity: string,
    entityId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    if (entity === "leg") {
      const leg = await tx.leg.findUnique({ where: { id: entityId }, select: { status: true } });
      return leg?.status ?? null;
    }
    if (entity === "quote") {
      const quote = await tx.quote.findUnique({ where: { id: entityId }, select: { status: true } });
      return quote?.status ?? null;
    }
    return this.log.load(entity, entityId, tx);
  }

  async save(entity: string, entityId: string, to: string, tx: Prisma.TransactionClient): Promise<void> {
    if (entity === "leg") {
      await tx.leg.update({ where: { id: entityId }, data: { status: to as LegStatus } });
      return;
    }
    if (entity === "quote") {
      await tx.quote.update({ where: { id: entityId }, data: { status: to as QuoteStatus } });
      return;
    }
    return this.log.save(entity, entityId, to, tx);
  }
}
