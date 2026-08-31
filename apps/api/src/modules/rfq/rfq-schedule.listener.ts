import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Prisma } from "@prisma/client";
import { QuoteEvent, QuoteStatus, Role } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { StatusService } from "../status/status.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";
import { ScheduledEventService } from "../comms/scheduled-event.service";
import { closedLegReasons } from "../ff-portal/leg-closure";

type TimerPayload = { entityType: string; entityId: string; tier: string };

// Reacts to the generic minute-cron timers seeded at distribute-time (Task 9): a reminder
// nudges the FF before the deadline — unless every leg on the RFQ has been closed to them
// (S5.9.5 D5, see onReminder); the DEADLINE-tier expiry closes out every quote still open
// on the RFQ (discard the draft — RFQ_SENT only, see the loop below → fire EXPIRE → notify →
// cancel the RFQ's remaining reminders). Both handlers swallow their own errors — they run from
// the cron loop (ScheduledEventService.runDue), and a throw here must not abort that loop.
@Injectable()
export class RfqScheduleListener {
  private readonly logger = new Logger(RfqScheduleListener.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly status: StatusService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly scheduled: ScheduledEventService,
  ) {}

  @OnEvent("rfq.reminder")
  async onReminder(p: TimerPayload): Promise<void> {
    try {
      const rfq = await this.prisma.rfq.findUnique({
        where: { id: p.entityId },
        select: {
          rfqNumber: true,
          submissionDeadline: true,
          queryId: true,
          tenantId: true,
          freightForwarder: { select: { email: true } },
        },
      });
      if (!rfq) return;

      // S5.9.5 final review (IMPORTANT 4) — do not nudge a forwarder who has been shut out of
      // every leg this RFQ covers. D5 closes an APPROVED leg to the forwarders who did not win
      // it: the portal renders that leg read-only and `saveDraft`/`submit` 409 them. Until this
      // check, the reminder fired unconditionally, so a forwarder whose only leg on the query had
      // been approved to a rival kept receiving "please submit your quote before the deadline"
      // for a portal that refuses the submission — a forwarder-facing message claiming something
      // is open that the product has closed (vocabulary rule D5).
      //
      // Per LEG, never per RFQ, and that is the whole subtlety: `Rfq` is
      // `@@unique([queryId, freightForwarderId])`, so ONE RFQ covers every leg this forwarder
      // holds on the query. A forwarder approved on LEG-1 but still quoting LEG-2 has real work
      // to do and must keep being reminded — which is exactly what D5's own rationale assumes
      // ("their reminder timers, which are per-RFQ, rightly keep running while LEG-2 is open").
      // So the reminder is skipped only when EVERY leg is closed to them.
      //
      // The rule itself is `closedLegReasons` (ff-portal/leg-closure.ts) — the same one the portal
      // DTO and the write guards use, not a second copy that could disagree about what "closed"
      // means. Deliberately NOT also filtering on quote status: whether an already-submitted
      // forwarder should still be reminded is a separate question nobody has ruled on, and
      // widening this beyond leg closure would change behaviour that is not at issue here.
      //
      // An RFQ with no quotes at all is left alone (nothing is closed, so nothing is skipped) —
      // unchanged behaviour rather than a new refusal for a shape this check has no view on.
      const quotes = await this.prisma.quote.findMany({
        where: { rfqId: p.entityId },
        select: { id: true, legId: true },
      });
      const closed = await closedLegReasons(this.prisma, quotes);
      if (quotes.length > 0 && quotes.every((q) => closed.has(q.legId))) return;

      await this.dispatcher.dispatch("rfq.reminder", {
        scope: { entityType: "QUERY", entityId: rfq.queryId },
        tokens: { RFQ_Number: rfq.rfqNumber, Deadline: rfq.submissionDeadline.toISOString() },
        recipients: { EMAIL: rfq.freightForwarder?.email ? [rfq.freightForwarder.email] : [] },
        tenantId: rfq.tenantId,
      });
    } catch (err) {
      this.logger.error(`onReminder failed for rfq ${p.entityId}`, err as Error);
    }
  }

  @OnEvent("rfq.expiry")
  async onExpiry(p: TimerPayload): Promise<void> {
    const rfqId = p.entityId;
    try {
      const rfq = await this.prisma.rfq.findUnique({
        where: { id: rfqId },
        select: {
          rfqNumber: true,
          queryId: true,
          tenantId: true,
          freightForwarder: { select: { companyName: true, email: true } },
        },
      });
      if (!rfq) return;

      const openQuotes = await this.prisma.quote.findMany({
        where: { rfqId, status: { in: [QuoteStatus.RFQ_SENT, QuoteStatus.REQUOTED] } },
        select: { id: true, legId: true, status: true, leg: { select: { legCode: true } } },
      });

      // Nothing still open → still clear any remaining reminders, then done.
      if (openQuotes.length === 0) {
        await this.scheduled.cancel("RFQ", rfqId, "rfq.reminder");
        return;
      }

      const query = await this.prisma.query.findUnique({
        where: { id: rfq.queryId },
        select: { assignedUserId: true },
      });
      let execIds: string[] = query?.assignedUserId ? [query.assignedUserId] : [];
      if (execIds.length === 0) {
        const execs = await this.prisma.user.findMany({
          where: { role: Role.EXECUTIVE, isActive: true },
          select: { id: true },
        });
        execIds = execs.map((u) => u.id);
      }

      // Cancel reminders EARLY — before any dispatch — so a comms throw can't skip it.
      await this.scheduled.cancel("RFQ", rfqId, "rfq.reminder");

      const FF_Name = rfq.freightForwarder?.companyName ?? "";

      // FF expiry email ONCE per RFQ (EMAIL-only ⇒ only the email template fires), isolated.
      try {
        await this.dispatcher.dispatch("rfq.expiry", {
          scope: { entityType: "QUERY", entityId: rfq.queryId },
          tokens: { RFQ_Number: rfq.rfqNumber, FF_Name },
          recipients: { EMAIL: rfq.freightForwarder?.email ? [rfq.freightForwarder.email] : [] },
          tenantId: rfq.tenantId,
        });
      } catch (err) {
        this.logger.error(`onExpiry FF email failed for rfq ${rfqId}`, err as Error);
      }

      // Each expired quote is processed independently — one leg's failure won't skip the rest.
      for (const q of openQuotes) {
        try {
          // S5.9.5 (D4, register A4) — discard the draft ONLY for a quote that was still RFQ_SENT.
          //
          // WHAT THIS IS NOT (S5.9.6, register A6). The original reason given here was that the
          // retained `draftJson` "is the only thing keeping that offer on the compare screen".
          // That is now FALSE, and it was never a provenance claim to begin with: `draftJson` is
          // the forwarder's SCRATCHPAD — `FfPortalService.saveDraft` overwrites it verbatim with
          // no status guard and no version hash, and `quoteDraftSchema` accepts blanks on purpose,
          // so on a REQUOTED quote it is merely their LAST SAVED STATE, which may be a
          // half-typed, modified, never-submitted bid. S5.9.6 moved the offer to `submittedJson`
          // (written by `submit` alone). The compare grid, the winner pricing and the client
          // letter's cost lines all read THAT column now, so what keeps a re-quoted forwarder's
          // offer on the compare screen through an expiry is `submittedJson`, which this sweep
          // does not touch at all — for RFQ_SENT or for REQUOTED.
          //
          // WHY THE RETENTION STILL EARNS ITS KEEP — PORTAL PRE-FILL, nothing more. `resolveScope`
          // (ff-portal.service.ts) returns `draftJson` as the portal's `draft`, falling back to a
          // blank `seedQuoteDraft` matrix when it is null. A forwarder who is re-negotiated after
          // their window closed, then asked again, must open onto their previous numbers rather
          // than retype everything from scratch. For RFQ_SENT there is nothing worth pre-filling
          // (never submitted, and the blank seed is exactly the right starting point), so the
          // discard there stays. `requestRequote` retains the draft for the same pre-fill reason
          // (negotiation.service.ts fires the status change with no `effect`).
          //
          // The quote still EXPIRES either way: the window really did close and the forwarder's
          // silence must be visible rather than reading as still-pending forever (design D4).
          // (Discard is permanent, spec S8/E3; the EXPIRE fire is the one door, after the write.)
          if (q.status === QuoteStatus.RFQ_SENT) {
            await this.prisma.quote.update({ where: { id: q.id }, data: { draftJson: Prisma.DbNull } });
          }
          await this.status.fire("quote", q.id, QuoteEvent.EXPIRE, { queryId: rfq.queryId });

          // Exec IN_APP notification per leg (IN_APP-only ⇒ only the in-app template fires).
          await this.dispatcher.dispatch("rfq.expiry", {
            scope: { entityType: "QUERY", entityId: rfq.queryId },
            tokens: { RFQ_Number: rfq.rfqNumber, FF_Name, Leg_Name: q.leg.legCode },
            recipients: { IN_APP: execIds },
            tenantId: rfq.tenantId,
          });
        } catch (err) {
          this.logger.error(`onExpiry quote ${q.id} failed for rfq ${rfqId}`, err as Error);
        }
      }
    } catch (err) {
      this.logger.error(`onExpiry failed for rfq ${rfqId}`, err as Error);
    }
  }
}
