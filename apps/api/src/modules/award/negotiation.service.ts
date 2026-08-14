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
    // whose shortlist was merely QUOTED (never sent/approved) stays exactly where it was
    // (LegQuoteProjector's own listener on quote.status.changed is a no-op here too: REQUOTED
    // is not in its RESOLVED set, so it never fires a forward transition off this event). Fired
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

    // 4) Reissue the FF's portal token — fresh accessTokenHash + audit RfqTokenReissue row.
    const { accessToken } = await this.rfq.reissueToken(queryId, quote.freightForwarderId, user);

    // 5) Reset the RFQ's submission window + re-arm reminder/expiry ScheduledEvents off the
    // new deadline (D-A: Rfq is @@unique([queryId, freightForwarderId]) — this resets the
    // whole window shared by every leg this FF still holds open on the query, per design §10.1
    // ("reset that RFQ's submissionDeadline"); accepted, flagged in the task report).
    await this.rfq.resetDeadlineAndRearm(quote.rfqId, user.tenantId);

    // 6) Notify the FF with the negotiation comment + a fresh portal link.
    const [ff, rfqRow] = await Promise.all([
      this.prisma.freightForwarder.findUnique({
        where: { id: quote.freightForwarderId },
        select: { email: true },
      }),
      this.prisma.rfq.findUnique({ where: { id: quote.rfqId }, select: { rfqNumber: true } }),
    ]);
    const base = process.env.PORTAL_BASE_URL ?? "";
    await this.dispatcher.dispatch("rfq.requote_requested", {
      scope: { entityType: "RFQ", entityId: quote.rfqId },
      tokens: {
        RFQ_Number: rfqRow?.rfqNumber ?? "",
        Comment: input.comment,
        Access_Link: `${base}/ff/rfq/${accessToken}`,
      },
      recipients: { EMAIL: ff?.email ? [ff.email] : [] },
      tenantId: user.tenantId,
    });

    return this.prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  }
}
