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
      // S5.9.2 Q1 — the ONE signal that licenses a backward walk: THIS recompute was triggered by
      // a quote entering REQUOTED. Read off the event's own `to`, i.e. the transition
      // `StatusService.fire` just committed, not off the quote row (which a later concurrent
      // change could already have moved on from) and not off a mere "some sibling is REQUOTED"
      // scan of the leg (which would let any unrelated quote event drag the leg back).
      await this.recomputeLeg(quote.legId, quote.queryId, event.to === QuoteStatus.REQUOTED);
    } catch (err) {
      this.logger.error(`leg rollup from quote failed for ${event.entityId}`, err as Error);
    }
  }

  // S5.9.2 Q1 — the ONE public entry point for a caller that has just moved a leg OUT of a
  // ROLLUP_FROZEN status itself and now owns applying the rollup (the "unfreeze gap" documented
  // on ROLLUP_FROZEN above). Its only caller is `NegotiationService.requestRequote`'s
  // `wasApproved` branch: the quote's own REQUEST_REQUOTE fire hit ROLLUP_FROZEN while the leg
  // was still APPROVED, and the REOPEN_AWARD fire that follows lands the leg on FULLY_QUOTED —
  // which, with a REQUOTED quote on it, is the exact C7 mismatch Q1 removes, just reached by a
  // different door. Deliberately named for the one thing it is allowed to do, so it cannot become
  // a general "recompute this leg however you like" hatch that resurrects the backward walk for
  // unrelated callers.
  async recomputeAfterRequote(legId: string, queryId: string): Promise<void> {
    try {
      await this.recomputeLeg(legId, queryId, true);
    } catch (err) {
      this.logger.error(`leg rollup after re-quote failed for ${legId}`, err as Error);
    }
  }

  private async recomputeLeg(
    legId: string,
    queryId: string,
    requoteTriggered: boolean,
  ): Promise<void> {
    const leg = await this.prisma.leg.findUnique({ where: { id: legId }, select: { status: true } });
    if (!leg) return;
    if (ROLLUP_FROZEN.includes(leg.status)) return;

    // Only quotes that were actually distributed (RFQ_SENT+ / not SELECT) count.
    const quotes = await this.prisma.quote.findMany({
      where: { legId, status: { not: QuoteStatus.SELECT } },
      select: { status: true },
    });
    const target = rollupLegTarget(quotes.map((q) => q.status));

    // ── Forward rollup — unchanged. ────────────────────────────────────────────────────────
    if (target !== null && target !== leg.status) {
      if (target === LegStatus.FULLY_QUOTED) {
        await this.status.fire("leg", legId, LegEvent.QUOTE_FULL, { queryId });
        return;
      }
      if (leg.status === LegStatus.RFQ_SENT) {
        // PARTIALLY_QUOTED is only ever entered FORWARD from RFQ_SENT. This is the
        // never-walk-backwards backstop: it is what discards an otherwise-correct
        // PARTIALLY_QUOTED target computed for an already-further-along leg.
        await this.status.fire("leg", legId, LegEvent.QUOTE_PARTIAL, { queryId });
        return;
      }
    }

    // ── S5.9.2 Q1 (register C7): the backward walk. ────────────────────────────────────────
    //
    // EXACTLY ONE input reaches this block: a `quote.status.changed` event whose `to` is
    // REQUOTED (or `recomputeAfterRequote`, which is the same event on the leg's other door —
    // see its doc). Every other quote event — submit, expire, invalidate, send, approve, return,
    // send-for-approval — returns above with `requoteTriggered === false`, so the backstop still
    // holds for all of them verbatim: the only status change that can now move a leg backwards
    // is an executive asking a forwarder to re-quote, which is precisely the state change the
    // leg was previously lying about.
    if (!requoteTriggered) return;
    // Second narrowing: only the two states a re-quote can legitimately fall FROM. A leg at
    // DRAFT/READY_FOR_RFQ/RFQ_SENT has nothing to walk back (and no such edge exists);
    // PENDING_APPROVAL/APPROVED already returned at ROLLUP_FROZEN above.
    if (leg.status !== LegStatus.FULLY_QUOTED && leg.status !== LegStatus.PARTIALLY_QUOTED) return;

    // `rollupLegTarget` returns `null` for "nothing to say" — for a leg with distributed quotes
    // and no comparable one left, that means we are back to waiting on forwarders, i.e. RFQ_SENT.
    // (`null` with NO distributed quotes at all stays null: nothing was ever sent.)
    const backTarget =
      target ?? (quotes.length > 0 ? LegStatus.RFQ_SENT : null);
    if (backTarget === null || backTarget === leg.status) return;

    if (backTarget === LegStatus.PARTIALLY_QUOTED) {
      // Only reachable from FULLY_QUOTED (backTarget !== leg.status narrows the other source).
      await this.status.fire("leg", legId, LegEvent.REQUOTE_PARTIAL, { queryId });
    } else if (backTarget === LegStatus.RFQ_SENT) {
      await this.status.fire("leg", legId, LegEvent.REQUOTE_OUTSTANDING, { queryId });
    }
  }
}
