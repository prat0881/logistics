import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { LegEvent, LegStatus, QuoteStatus, rollupLegTarget } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { StatusService } from "../status/status.service";
import type { StatusChangedEvent } from "../status/status.service";

// Legs whose status is owned by the approval flow (send-for-approval / approve / return), never
// by rollup arithmetic, once they reach PENDING_APPROVAL or APPROVED.
//
// CORRECTED (S5.9 Task 2 code review, round 2): an earlier version of this comment claimed that
// without this guard, a straggler forwarder resolving while a leg is under review would fire an
// illegal QUOTE_FULL off PENDING_APPROVAL and leave the leg "permanently un-approvable". That was
// wrong, and the plan doc it was copied from was wrong too. Walk through what actually happens
// without this guard: rollupLegTarget still computes a target (e.g. FULLY_QUOTED), and
// recomputeLeg still calls `this.status.fire("leg", legId, LegEvent.QUOTE_FULL, ...)` — but no
// PENDING_APPROVAL/APPROVED --quote.full/quote.partial--> edge exists on the leg machine, so
// `findTransition` fails INSIDE `StatusService.fire`'s own `$transaction`, which throws before
// the StatusTransition row is written and rolls back atomically — `leg.status` is never touched,
// caught+logged (ERROR) by this class's own try/catch, and swallowed. The leg ends up at
// PENDING_APPROVAL either way; the missing MACHINE EDGE was already what protected it, not this
// guard. Mutation-tested: deleting this line does not turn leg-rollup.e2e-spec.ts's behavioural
// assertion red (see that file's own note) — only a spy on StatusService.fire, asserting no "leg"
// call is even attempted while frozen, can tell the two states apart.
//
// What this guard actually buys, then, is narrower: it suppresses the spurious fire() attempt and
// its ERROR log noise (an operational nuisance, not a correctness bug), and it is defence-in-depth
// against a future PENDING_APPROVAL/APPROVED --quote.full/quote.partial--> edge ever being added —
// which WOULD then silently regress a leg under review, and this guard is the only thing that
// would still stop it.
//
// Unfreeze gap: nothing here recomputes the rollup when a leg LEAVES a frozen status — the only
// trigger this class listens for is "quote.status.changed". A caller that moves a leg OUT of
// PENDING_APPROVAL/APPROVED (RETURN_FULL / RETURN_PARTIAL / REOPEN, or a future approve/reject
// service) owns computing the correct target itself — e.g. by calling `rollupLegTarget` directly
// — this projector will not fix the leg up afterward.
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
