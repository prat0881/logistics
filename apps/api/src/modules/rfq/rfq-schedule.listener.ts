import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Prisma } from "@prisma/client";
import { QuoteEvent, QuoteStatus, Role } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { StatusService } from "../status/status.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";
import { ScheduledEventService } from "../comms/scheduled-event.service";

type TimerPayload = { entityType: string; entityId: string; tier: string };

// Reacts to the generic minute-cron timers seeded at distribute-time (Task 9): a reminder
// nudges the FF before the deadline; the DEADLINE-tier expiry closes out any quote the FF
// never submitted (discard draft → fire EXPIRE → notify → cancel the RFQ's remaining
// reminders). Both handlers swallow their own errors — they run from the cron loop
// (ScheduledEventService.runDue), and a throw here must not abort that loop.
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
        where: { rfqId, status: QuoteStatus.RFQ_SENT },
        select: { id: true, legId: true, leg: { select: { legCode: true } } },
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
          // discard the unsubmitted draft (permanent, spec S8/E3), then fire EXPIRE (the one door, after the write)
          await this.prisma.quote.update({ where: { id: q.id }, data: { draftJson: Prisma.DbNull } });
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
