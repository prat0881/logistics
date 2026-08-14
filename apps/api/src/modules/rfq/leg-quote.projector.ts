import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { LegEvent, LegStatus, QuoteStatus } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { StatusService } from "../status/status.service";
import type { StatusChangedEvent } from "../status/status.service";

// Terminal quote states that count as "resolved" for the leg rollup (spec §9.2). APPROVED
// (S5.3 award edge, QUOTED -> APPROVED) counts too, so approving a quote doesn't strand the leg
// short of FULLY_QUOTED. REQUOTED is deliberately excluded — a re-quote in flight is genuinely
// not resolved.
const RESOLVED: string[] = [
  QuoteStatus.QUOTED,
  QuoteStatus.EXPIRED,
  QuoteStatus.CLOSED,
  QuoteStatus.APPROVED,
];

@Injectable()
export class LegQuoteProjector {
  private readonly logger = new Logger(LegQuoteProjector.name);
  constructor(private readonly prisma: PrismaService, private readonly status: StatusService) {}

  @OnEvent("quote.status.changed")
  async onQuoteStatusChanged(event: StatusChangedEvent): Promise<void> {
    try {
      const quote = await this.prisma.quote.findUnique({
        where: { id: event.entityId },
        select: { legId: true, queryId: true },
      });
      if (!quote) return;
      await this.recomputeLeg(quote.legId, quote.queryId);
    } catch (err) {
      this.logger.error(`leg rollup from quote failed for ${event.entityId}`, err as Error);
    }
  }

  // Only quotes that were actually distributed (RFQ_SENT+ / not SELECT) count.
  private async recomputeLeg(legId: string, queryId: string): Promise<void> {
    const leg = await this.prisma.leg.findUnique({ where: { id: legId }, select: { status: true } });
    if (!leg) return;
    const quotes = await this.prisma.quote.findMany({
      where: { legId, status: { not: QuoteStatus.SELECT } },
      select: { status: true },
    });
    if (quotes.length === 0) return;
    const resolved = quotes.filter((q) => RESOLVED.includes(q.status)).length;
    const anyQuoted = quotes.some((q) => q.status === QuoteStatus.QUOTED);

    // Fire only when the target differs from the current leg status (fire throws on illegal edges).
    if (resolved === quotes.length && leg.status !== LegStatus.FULLY_QUOTED) {
      await this.status.fire("leg", legId, LegEvent.QUOTE_FULL, { queryId });
    } else if (anyQuoted && leg.status === LegStatus.RFQ_SENT) {
      await this.status.fire("leg", legId, LegEvent.QUOTE_PARTIAL, { queryId });
    }
  }
}
