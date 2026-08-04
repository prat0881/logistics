import { Injectable } from "@nestjs/common";

export interface ChangeLogEntry {
  queryId: string;
  entity: string;
  entityId: string;
  changeType: string; // "change-order"
  actorId?: string | null;
  payload: Record<string, unknown>;
}

export const CHANGE_LOG = Symbol("CHANGE_LOG");

export interface ChangeLog {
  record(entry: ChangeLogEntry): Promise<void>;
}

// Superseded by PrismaChangeLog (SB6, Task 6) as the CHANGE_LOG binding — kept as a reusable
// no-op ChangeLog for tests/contexts that don't want to touch the DB.
@Injectable()
export class NoopChangeLog implements ChangeLog {
  async record(_entry: ChangeLogEntry): Promise<void> {
    /* no-op */
  }
}
