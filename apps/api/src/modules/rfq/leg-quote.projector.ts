import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { LegEvent, LegStatus, QuoteStatus, rollupLegTarget } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { StatusService } from "../status/status.service";
import type { StatusChangedEvent } from "../status/status.service";

// Legs whose status is owned by the approval flow, not by the quote rollup. A straggler
// forwarder resolving while a leg is under review used to fire QUOTE_FULL off PENDING_APPROVAL —
// an illegal edge, caught and logged, which left the leg permanently un-approvable (S5.9 §4.4).
const ROLLUP_FROZEN: string[] = [LegStatus.PENDING_APPROVAL, LegStatus.APPROVED];

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

  private async recomputeLeg(legId: string, queryId: string): Promise<void> {
    const leg = await this.prisma.leg.findUnique({ where: { id: legId }, select: { status: true } });
    if (!leg) return;
    if (ROLLUP_FROZEN.includes(leg.status)) return;

    // Only quotes that were actually distributed (RFQ_SENT+ / not SELECT) count.
    const quotes = await this.prisma.quote.findMany({
      where: { legId, status: { not: QuoteStatus.SELECT } },
      select: { status: true },
    });
    const target = rollupLegTarget(quotes.map((q) => q.status));
    if (target === null || target === leg.status) return;

    if (target === LegStatus.FULLY_QUOTED) {
      await this.status.fire("leg", legId, LegEvent.QUOTE_FULL, { queryId });
    } else if (leg.status === LegStatus.RFQ_SENT) {
      // PARTIALLY_QUOTED is only ever entered from RFQ_SENT — never walk a leg backwards.
      await this.status.fire("leg", legId, LegEvent.QUOTE_PARTIAL, { queryId });
    }
  }
}
