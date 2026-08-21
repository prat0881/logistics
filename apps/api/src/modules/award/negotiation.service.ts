import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { AwardDecisionStatus, Prisma, type Quote } from "@prisma/client";
import {
  LegEvent,
  LegStatus,
  QuoteEvent,
  QuoteStatus,
  type RequestRequoteInput,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import type { RequestUser } from "../auth/types";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";
import { RfqService } from "../rfq/rfq.service";
import { QueryStatusProjector } from "../status/query-status.projector";
import { StatusService } from "../status/status.service";

// Quote statuses a re-quote can legally be requested against — a live offer (QUOTED) or one
// already provisionally selected (APPROVED, design §5). Anything else (RFQ_SENT — no price to
// negotiate yet; EXPIRED/INVALID/CLOSED/REQUOTED — already not-live) is a 409.
const REQUOTABLE_STATUSES: readonly string[] = [QuoteStatus.QUOTED, QuoteStatus.APPROVED];

// S5.5 (Technical Design §10.1) — the negotiation core: an Executive asks a single FF to
// revise their price. Unlike SB6's change-order path (a field edit that invalidates whatever
// was quoted), this is a dedicated per-(leg,quote) action that deliberately RETAINS the
// earlier price (badged stale in the comparison) while the FF's portal reopens for a fresh
// submission. Mirrors award.service.ts's convention: each status change is its own
// `StatusService.fire` (own transaction), plain-Prisma writes elsewhere, sequential — a
// partial failure between steps is an accepted risk, same as approve()/reject().
@Injectable()
export class NegotiationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly status: StatusService,
    private readonly rfq: RfqService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly projector: QueryStatusProjector,
  ) {}

  async requestRequote(
    queryId: string,
    legId: string,
    quoteId: string,
    input: RequestRequoteInput,
    user: RequestUser,
  ): Promise<Quote> {
    // Ownership scoping mirrors sendForApproval/requireDecidable's `{ id, queryId }` pattern
    // (award.service.ts) — a mismatched queryId OR legId in the URL must 404, not silently
    // thread the wrong query/leg into the fires/audit trail below.
    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, queryId, legId },
      select: {
        id: true,
        status: true,
        rfqId: true,
        freightForwarderId: true,
        leg: { select: { status: true } },
      },
    });
    if (!quote) throw new NotFoundException("Quote not found");

    // B1 / D5 — the compare screen has disabled Negotiate at PENDING_APPROVAL since S5.7 while
    // this endpoint still accepted it, silently wiping a decision a checker was mid-review of.
    // Worse now that leg status moves too: an accepted call would park the leg at
    // PENDING_APPROVAL with a DRAFT decision — a state no screen can act on. Checked against the
    // LEG's decision, not the targeted quote's own status: REQUOTABLE_STATUSES below only gates
    // the quote NAMED in this call, so a still-QUOTED sibling quote on the same leg would
    // otherwise sail through it and reset a decision a checker is mid-review of on a DIFFERENT,
    // already-shortlisted quote. Reject first, then re-negotiate (design §9).
    const existingDecision = await this.prisma.legAwardDecision.findUnique({ where: { legId } });
    if (existingDecision?.status === AwardDecisionStatus.PENDING_APPROVAL) {
      throw new ConflictException(
        "This leg is pending approval — it must be rejected before a re-quote can be requested",
      );
    }

    if (!REQUOTABLE_STATUSES.includes(quote.status)) {
      throw new ConflictException(
        "Only a live (QUOTED) or provisionally APPROVED quote can be re-negotiated",
      );
    }
    // Structurally unreachable — a QUOTED/APPROVED quote only ever gets there via distribution,
    // which always sets rfqId — but the column is nullable; fail clean rather than crash below
    // (mirrors award.service.ts's MIN-1 defensive guards).
    if (!quote.rfqId) {
      throw new ConflictException("This quote has no RFQ to re-quote against");
    }

    const wasApproved = quote.leg.status === LegStatus.APPROVED;

    // 1) Quote: QUOTED|APPROVED -> REQUOTED. The edge has no `effect` (award.module.ts), so
    // draftJson is untouched — the earlier price stays visible, exactly as design §10.1 wants.
    await this.status.fire("quote", quoteId, QuoteEvent.REQUEST_REQUOTE, {
      queryId,
      actorId: user.userId,
      reason: input.comment,
    });

    // 2) Leg: only reopen if the negotiated quote had actually carried an approval — a leg
    // whose shortlist was merely QUOTED (never sent/approved) stays exactly where it was.
    // CORRECTED (S5.9 Task 5 review) — this used to claim LegQuoteProjector's own listener on
    // quote.status.changed is a no-op here because REQUOTED isn't one of the "resolved" statuses
    // `rollupLegTarget` (status.ts) treats as settled, so it "computes no forward target off this
    // event". That is only true for a single-quote leg. On a multi-forwarder leg with a sibling
    // still QUOTED, `rollupLegTarget` DOES compute a real target (PARTIALLY_QUOTED —
    // `distributed.some(s => s === QUOTED)` is true). What actually keeps the leg from walking
    // backwards in that case is `LegQuoteProjector.recomputeLeg`'s own never-walk-backwards
    // backstop (leg-quote.projector.ts): it only fires QUOTE_PARTIAL when `leg.status ===
    // RFQ_SENT`, and a leg that just carried an APPROVED decision was FULLY_QUOTED (never
    // RFQ_SENT) beforehand, so the projector returns without firing regardless of what
    // `rollupLegTarget` computed. Fired
    // BEFORE step 3's transaction, deliberately: fire() commits its own tx and only emits its
    // event after that commit (status.service.ts), so by the time this call resolves the leg
    // row is durably FULLY_QUOTED — which step 3's own QueryStatusProjector.recompute needs to
    // see, not the stale APPROVED value, to land the query on the right post-teardown status.
    if (wasApproved) {
      await this.status.fire("leg", legId, LegEvent.REOPEN_AWARD, {
        queryId,
        actorId: user.userId,
      });
    }

    // 3) Decision: reset to a clean DRAFT slate (the basis changed) + audit event, PLUS —
    // whole-branch review, task 2 — tear down QUOTING_CLIENT if this query had already been
    // generated (Query.awardSnapshot set by generateClientQuote). generateClientQuote's A6 gate
    // requires EVERY leg APPROVED before it will freeze a snapshot, so `wasApproved` above can
    // only be true here if this query really could be QUOTING_CLIENT — a frozen snapshot naming
    // this leg's now-REQUOTED "winner" (decision now DRAFT) would otherwise survive untouched,
    // and deriveQueryStatus's `quotingClient` milestone short-circuits ahead of the leg rollup,
    // so the query would keep reporting QUOTING_CLIENT with a stale client-facing total forever
    // (nothing else forces a recompute of a query whose milestone is still true). Mirrors
    // award-change-order.listener.ts's identical §10.2 teardown exactly: Prisma.DbNull (a
    // nullable Json column -> SQL NULL, not the JSON null literal, which would read back truthy
    // and defeat the projector's `!!` check) + recompute inside the same tx. Bundled into this
    // transaction rather than its own — one more plain write with no external side effects, same
    // reasoning as the decision reset itself.
    await this.prisma.$transaction(async (tx) => {
      const decision = await tx.legAwardDecision.findUnique({ where: { legId } });
      if (decision) {
        await tx.legAwardDecision.update({
          where: { legId },
          data: {
            status: AwardDecisionStatus.DRAFT,
            shortlistedQuoteId: null,
            shortlistedVariant: null,
            sentByUserId: null,
            decidedByUserId: null,
            decidedAt: null,
            rejectionReason: null,
          },
        });
      }
      await tx.awardDecisionEvent.create({
        data: {
          legId,
          queryId,
          type: "REQUEST_REQUOTE",
          quoteId,
          reason: input.comment,
          actorId: user.userId,
        },
      });

      const query = await tx.query.findUnique({
        where: { id: queryId },
        select: { awardSnapshot: true },
      });
      if (query?.awardSnapshot != null) {
        await tx.query.update({ where: { id: queryId }, data: { awardSnapshot: Prisma.DbNull } });
        await this.projector.recompute(queryId, tx);
      }
    });

    // 4) Reset the RFQ's submission window + re-arm reminder/expiry ScheduledEvents off the
    // new deadline (D-A: Rfq is @@unique([queryId, freightForwarderId]) — this resets the
    // whole window shared by every leg this FF still holds open on the query, per design §10.1
    // ("reset that RFQ's submissionDeadline"); accepted, flagged in the task report).
    await this.rfq.resetDeadlineAndRearm(quote.rfqId, user.tenantId);

    // 5) Notify the FF with the negotiation comment + their EXISTING portal link.
    const [ff, rfqRow] = await Promise.all([
      this.prisma.freightForwarder.findUnique({
        where: { id: quote.freightForwarderId },
        select: { email: true },
      }),
      this.prisma.rfq.findUnique({
        where: { id: quote.rfqId },
        select: { rfqNumber: true, accessToken: true },
      }),
    ]);
    // D7 — the token is NOT rotated (see rfq.service.ts's reissueToken doc). The forwarder's
    // existing link keeps working, which matters most for a forwarder holding several legs open
    // on this query across rounds. The Stage-4 Regenerate button (RegeneratePortalLink.tsx ->
    // RfqService.reissueToken) remains the only way to rotate it.
    // D8 — `accessToken` is nullable: a row created before this migration never had its raw
    // token persisted (only the hash was ever stored, and the raw value existed solely inside
    // the original emailed link). A backfill from MessageLog.tokens is possible but deliberately
    // out of scope — this degrades to a fallback string rather than emailing a broken link.
    const base = process.env.PORTAL_BASE_URL ?? "";
    const link = rfqRow?.accessToken
      ? `${base}/ff/rfq/${rfqRow.accessToken}`
      : "the portal link in your original RFQ email";
    await this.dispatcher.dispatch("rfq.requote_requested", {
      scope: { entityType: "RFQ", entityId: quote.rfqId },
      tokens: {
        RFQ_Number: rfqRow?.rfqNumber ?? "",
        Comment: input.comment,
        Access_Link: link,
      },
      recipients: { EMAIL: ff?.email ? [ff.email] : [] },
      tenantId: user.tenantId,
    });

    return this.prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  }
}
