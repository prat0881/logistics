// apps/api/src/modules/award/query-lock.service.ts
import { ConflictException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/** The one copy string for a refused write on a locked query. One constant because it is asserted
 *  in e2e and rendered by the compare screen — the two must not drift. */
export const QUERY_LOCKED_MESSAGE =
  "This query is being quoted to the client — reopen the comparison before changing anything";

/**
 * QueryLockService — the ONE definition of "this query is locked" (S5.9.5 design D6).
 *
 * Locked means `Query.awardSnapshot != null`, which is exactly the condition
 * `query-status.projector.ts` reads to derive QUOTING_CLIENT and, once a letter is issued,
 * AWAITING_CLIENT_DECISION. Before this service five sites checked that column ad hoc; the point
 * of centralising is that a new write cannot be added without a single, obvious call to make.
 *
 * Two callers deliberately do NOT use this — see D6:
 *   - `reopenComparison` is the door out and asserts the OPPOSITE (it 409s when NOT locked).
 *   - Everything under `queries/:id/quotation`: the locked state exists so that the client
 *     quotation can be composed and issued, so gating it would forbid the only work it allows.
 */
@Injectable()
export class QueryLockService {
  constructor(private readonly prisma: PrismaService) {}

  async assertUnlocked(queryId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    const query = await client.query.findUnique({
      where: { id: queryId },
      select: { awardSnapshot: true },
    });
    // A missing query is NOT this service's error to raise — every caller already 404s on its own
    // read, and answering "locked" for a row that does not exist would turn a 404 into a 409.
    if (query?.awardSnapshot != null) throw new ConflictException(QUERY_LOCKED_MESSAGE);
  }
}
