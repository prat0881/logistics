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
import { LegQuoteProjector } from "../rfq/leg-quote.projector";
import { RfqService } from "../rfq/rfq.service";
import { QueryStatusProjector } from "../status/query-status.projector";
import { StatusService } from "../status/status.service";
import { QueryLockService } from "./query-lock.service";

// Quote statuses a re-quote can legally be requested against — a live offer (QUOTED), one already
// provisionally selected (APPROVED, design §5), or one whose re-quote window closed with the
// forwarder silent (EXPIRED, S5.9.5 D4 — their price survives the sweep now, so asking again is
// the only way back into a conversation with them — on a leg whose decision is not APPROVED; on
// one that is, D1's guard below means the way back is a checker's Reject first). Anything else
// (RFQ_SENT — no price to negotiate yet; INVALID/CLOSED/REQUOTED — already not-live, or already
// being asked) is a 409.
//
// `APPROVED` STAYS, deliberately (S5.9.5 review round 1 IMPORTANT 1), even though the D1 decision
// guard added in `requestRequote` below now rejects the ordinary path to it. Two reasons, both the
// same discipline `SENDABLE_STATUSES` keeps in award.service.ts:
//   1. This list must stay in lock-step with the `REQUEST_REQUOTE` sources the quote machine
//      registers (award.module.ts:85-92: QUOTED, PENDING_APPROVAL, APPROVED, EXPIRED). Removing a
//      status here that the machine still accepts makes the two lists disagree, which is the exact
//      drift the constant exists to prevent.
//   2. It is not strictly dead. The decision guard reads `LegAwardDecision.status`; this one reads
//      `Quote.status`. `approve()` writes both, but in two separate commits, and `reject()` reverses
//      them the same way — so a partial failure between them can leave an APPROVED *quote* under a
//      DRAFT *decision*. In that drifted row the decision guard passes and this list is what
//      answers. Keeping it means the machine, not an `IllegalTransitionError` out of a post-commit
//      fire, decides the outcome.
// The reachable-in-practice members after D1 are QUOTED and EXPIRED.
const REQUOTABLE_STATUSES: readonly string[] = [
  QuoteStatus.QUOTED,
  QuoteStatus.APPROVED,
  QuoteStatus.EXPIRED,
];

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
    private readonly legRollup: LegQuoteProjector,
    private readonly lock: QueryLockService,
  ) {}

  async requestRequote(
    queryId: string,
    legId: string,
    quoteId: string,
    input: RequestRequoteInput,
    user: RequestUser,
  ): Promise<Quote> {
    // S5.9.5 (D6) — a locked query (`awardSnapshot != null`, i.e. QUOTING_CLIENT /
    // AWAITING_CLIENT_DECISION) refuses every write. First, before any other read, so a locked
    // query never does partial work.
    await this.lock.assertUnlocked(queryId);
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
    //
    // S5.9.5 (design D1), review round 1 IMPORTANT 1 — APPROVED is refused here too, and this is
    // the THIRD instance of the same shape closed on this branch (register B1; D3's
    // `@Roles(EXECUTIVE)`; this). D1's words are "Executive, Manager and Administrator alike take
    // **no** action on a leg whose decision is `APPROVED`", and until now only the UI honoured that
    // for negotiation. What the server accepted was worse than a stale affordance: with the leg's
    // decision APPROVED, `REQUOTABLE_STATUSES` admits the APPROVED quote, so the accepted call fell
    // through to `wasApproved` below and performed a COMPLETE REVERSAL of an approval — quote
    // APPROVED -> REQUOTED, leg reopened, decision back to DRAFT with `decidedByUserId`,
    // `decidedAt` and `sentByUserId` all nulled — carried out by the one role D2 deliberately
    // excludes from Reject, with no four-eyes and no reason recorded anywhere a checker would read
    // it. The remedy named in the message is the real one (D2): a checker rejects the leg, which
    // reverses the approval with a reason on the audit trail, and negotiation is available again
    // the moment the decision is back to DRAFT.
    const existingDecision = await this.prisma.legAwardDecision.findUnique({ where: { legId } });
    if (existingDecision?.status === AwardDecisionStatus.PENDING_APPROVAL) {
      throw new ConflictException(
        "This leg is pending approval — it must be rejected before a re-quote can be requested",
      );
    }
    if (existingDecision?.status === AwardDecisionStatus.APPROVED) {
      throw new ConflictException(
        "This leg is approved — a checker must reject it before a re-quote can be requested",
      );
    }

    if (!REQUOTABLE_STATUSES.includes(quote.status)) {
      throw new ConflictException(
        "Only a live, provisionally approved, or expired quote can be re-negotiated",
      );
    }
    // Structurally unreachable — a REQUOTABLE quote only ever gets to one of those statuses via
    // distribution, which always sets rfqId (EXPIRED included: the sweep that mints it is keyed on
    // an RFQ) — but the column is nullable; fail clean rather than crash below
    // (mirrors award.service.ts's MIN-1 defensive guards).
    if (!quote.rfqId) {
      throw new ConflictException("This quote has no RFQ to re-quote against");
    }

    // 🔴 EFFECTIVELY DEAD under S5.9.5 D1 — kept as a safety net, not because it fires. Traced:
    // `LegStatus.APPROVED` has exactly one edge in (award.module.ts:108,
    // `PENDING_APPROVAL --APPROVE--> APPROVED`) and exactly one caller for it, `AwardService.approve`,
    // which writes `AwardDecisionStatus.APPROVED` in its own transaction and fires that leg edge
    // straight after. So a leg at `APPROVED` carries an `APPROVED` decision, which the guard above
    // now refuses before this line is reached.
    //
    // NOT claiming it is unreachable, because it is not: approve() and reject() each commit the
    // decision write BEFORE firing the leg transition (an accepted partial-failure risk this file's
    // own header documents), so a failure in that window can leave `leg.status = APPROVED` under a
    // DRAFT decision. That drifted row passes the guard and lands here — which is precisely why the
    // branch stays. Same treatment as the QUOTING_CLIENT teardown below and as the change-order
    // teardown design D6 records: removed deliberately, if ever, never discovered.
    const wasApproved = quote.leg.status === LegStatus.APPROVED;

    // 1) Quote: QUOTED|APPROVED|EXPIRED -> REQUOTED. The edge has no `effect` (award.module.ts), so
    // neither JSON column is touched. `submittedJson` surviving is what keeps the earlier price
    // visible on the compare screen, exactly as design §10.1 wants (S5.9.6, register A6 — that
    // used to be attributed to `draftJson`); `draftJson` surviving is what pre-fills the reopened
    // portal with their previous numbers instead of a blank matrix.
    // S5.9.5 (D4): that also holds for the EXPIRED source, so re-negotiating a price the expiry
    // sweep preserved does not discard it either.
    await this.status.fire("quote", quoteId, QuoteEvent.REQUEST_REQUOTE, {
      queryId,
      actorId: user.userId,
      reason: input.comment,
    });

    // 2) Leg: only reopen if the negotiated quote had actually carried an approval — a leg
    // whose shortlist was merely QUOTED (never sent/approved) stays exactly where it was.
    //
    // Why step 1's quote fire alone never moves the leg while `wasApproved` is true (i.e. inside
    // THIS `if`): `StatusService.fire` does `await this.events.emitAsync(...)` AFTER its own
    // commit (status.service.ts), so `fire()` itself does not resolve until every listener —
    // here, `LegQuoteProjector.onQuoteStatusChanged` — has finished running SYNCHRONOUSLY inside
    // step 1's `await` above, before this `if` is even reached, let alone before REOPEN_AWARD
    // below has fired. At that moment `leg.status` is still `APPROVED` (nothing has changed it
    // yet), so `recomputeLeg` returns immediately at its own `ROLLUP_FROZEN.includes(leg.status)`
    // guard (leg-quote.projector.ts) — it never reaches `rollupLegTarget` at all on this branch.
    //
    // CORRECTED TWICE (S5.9 Task 5 review round 2) — the previous version of this comment named
    // the WRONG guard here: LegQuoteProjector's never-walk-backwards RFQ_SENT backstop (it only
    // fires QUOTE_PARTIAL when `leg.status === RFQ_SENT`), with `rollupLegTarget` computing a
    // real PARTIALLY_QUOTED target that the backstop then suppresses. That mechanism is real, but
    // it answers the OTHER branch — `!wasApproved`, e.g. a multi-forwarder FULLY_QUOTED leg with
    // a sibling quote still QUOTED — where the leg is NOT in ROLLUP_FROZEN and `recomputeLeg`
    // genuinely reaches `rollupLegTarget`. On THIS branch ROLLUP_FROZEN intercepts first, so the
    // RFQ_SENT backstop is never reached at all. Fired
    // BEFORE step 3's transaction, deliberately: fire() commits its own tx and only emits its
    // event after that commit (status.service.ts), so by the time this call resolves the leg
    // row is durably reopened — which step 3's own QueryStatusProjector.recompute needs to
    // see, not the stale APPROVED value, to land the query on the right post-teardown status.
    //
    // S5.9.2 Q1 (register C7) — REOPEN_AWARD lands the leg on FULLY_QUOTED, which after Q1 is a
    // LIE on this branch: the quote it was approved off is now REQUOTED, so we are waiting on a
    // forwarder again and the leg must fall to PARTIALLY_QUOTED/RFQ_SENT like any other
    // re-quoted leg. The projector cannot do it for us — its own `quote.status.changed` listener
    // already ran during step 1's fire and hit ROLLUP_FROZEN while the leg was still APPROVED,
    // and REOPEN_AWARD emits `leg.status.changed`, which it does not listen for. This is exactly
    // the "unfreeze gap" leg-quote.projector.ts documents ("a caller that moves a leg OUT of
    // PENDING_APPROVAL/APPROVED owns computing the correct target itself"), so this caller owns
    // it — through the projector's own narrow re-quote entry point, so the rule stays in ONE
    // place (D4) rather than being re-derived here. Sequenced after REOPEN_AWARD because the
    // backward edges start from FULLY_QUOTED/PARTIALLY_QUOTED, and still before step 3, for the
    // same durability reason as above.
    if (wasApproved) {
      await this.status.fire("leg", legId, LegEvent.REOPEN_AWARD, {
        queryId,
        actorId: user.userId,
      });
      await this.legRollup.recomputeAfterRequote(legId, queryId);
    }

    // 3) Decision: reset to a clean DRAFT slate (the basis changed) + audit event, PLUS —
    // whole-branch review, task 2 — tear down QUOTING_CLIENT if this query had already been
    // generated (Query.awardSnapshot set by generateClientQuote).
    // 🔴 That teardown is DEAD under S5.9.5 D6: this method now refuses a locked query outright
    // (the `assertUnlocked` at the top), so it can never run against a frozen snapshot. The rest
    // of this paragraph is the reasoning it was BUILT on, preserved for the reader who wonders why
    // it exists; it is not a claim that it still fires. See the marker at the branch itself. generateClientQuote's A6 gate
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

      // 🔴 DEAD BRANCH under S5.9.5 D6 — kept as a safety net, not because it fires. D6 gates every
      // query-scoped write on `awardSnapshot == null`, `requestRequote` itself included (this method's own guard, at the top), so nothing can reach this
      // line with a snapshot still frozen and the condition below is never true.
      // DOUBLY unreachable after review round 1's D1 guard: `generateClientQuote`'s A6 gate only
      // freezes a snapshot once EVERY leg is APPROVED, and an APPROVED leg's decision is now
      // refused at the top of this method — so even without the lock, a frozen snapshot could no
      // longer coexist with a call that reaches here. Design doc D6 carries
      // the correction and the instruction: it stays because deleting it is a behaviour change nobody
      // has ruled on, it has no e2e coverage, and it must be REMOVED DELIBERATELY rather than
      // discovered. Do not "restore" reachability by relaxing the lock.
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
