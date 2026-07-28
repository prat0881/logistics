import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { formatRfqNumber } from "@svyft/shared";

@Injectable()
export class RfqNumberService {
  async next(queryId: string, tx: Prisma.TransactionClient): Promise<string> {
    const query = await tx.query.findUnique({ where: { id: queryId }, select: { queryCode: true } });
    if (!query) throw new NotFoundException("Query not found");
    const row = await tx.rfqSequence.upsert({
      where: { queryId },
      create: { queryId, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
    });
    return formatRfqNumber(query.queryCode, row.lastNumber);
  }
}
