import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

// How fire learns an entity's current state. Stage 3 ships the log-backed default:
// the latest StatusTransition.to is authoritative (the Stage-4 cascade reads prior
// state from the log too, §7.7). Plan 5 may register a column-backed Leg store.
export interface StatusStateStore {
  load(entity: string, entityId: string, tx: Prisma.TransactionClient): Promise<string | null>;
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
}
