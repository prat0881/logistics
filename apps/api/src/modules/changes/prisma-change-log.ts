import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { ChangeLog, ChangeLogEntry } from "./change-log";

// Durable sink (§7.7) — writes to the ChangeLog table (Task 1). Bound to CHANGE_LOG by
// ChangesModule; ChangeLogPolicy decides which paths ever reach it.
@Injectable()
export class PrismaChangeLog implements ChangeLog {
  constructor(private readonly prisma: PrismaService) {}
  async record(entry: ChangeLogEntry): Promise<void> {
    await this.prisma.changeLog.create({
      data: {
        queryId: entry.queryId,
        entity: entry.entity,
        entityId: entry.entityId,
        changeType: entry.changeType,
        actorId: entry.actorId ?? null,
        payload: entry.payload as Prisma.InputJsonValue,
      },
    });
  }
}
