import { Injectable } from "@nestjs/common";
import type { FindingScope } from "@svyft/shared";

export interface ChangeLogEntry {
  entity: string;
  id: string;
  field?: string;
  action?: string;
  reason?: string;
  affected: FindingScope[];
  actorId?: string | null;
}

export const CHANGE_LOG = Symbol("CHANGE_LOG");

export interface ChangeLog {
  record(entry: ChangeLogEntry): Promise<void>;
}

// No-op sink now; the durable change-log lands with the Stage-4 cascade (§7.7).
@Injectable()
export class NoopChangeLog implements ChangeLog {
  async record(_entry: ChangeLogEntry): Promise<void> {
    /* reserved seam — no-op in Stage 3 */
  }
}
