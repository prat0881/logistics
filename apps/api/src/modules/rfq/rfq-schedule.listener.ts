import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Prisma } from "@prisma/client";
import { QuoteEvent, QuoteStatus } from "@svyft/shared";
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
    try {
      const rfq = await this.prisma.rfq.findUnique({
        where: { id: p.entityId },
        select: {
          rfqNumber: true,
          queryId: true,
          tenantId: true,
          freightForwarder: { select: { companyName: true, email: true } },
        },
      });
      if (!rfq) return;

      const openQuotes = await this.prisma.quote.findMany({
        where: { rfqId: p.entityId, status: QuoteStatus.RFQ_SENT },
        select: { id: true, legId: true, leg: { select: { legCode: true } } },
      });
      if (openQuotes.length === 0) return;

      const query = await this.prisma.query.findUnique({
        where: { id: rfq.queryId },
        select: { assignedUserId: true },
      });
      let execIds: string[] = query?.assignedUserId ? [query.assignedUserId] : [];
      if (execIds.length === 0) {
        const execs = await this.prisma.user.findMany({
          where: { role: "EXECUTIVE", isActive: true },
          select: { id: true },
        });
        execIds = execs.map((u) => u.id);
      }

      for (const q of openQuotes) {
        // discard the unsubmitted draft (permanent, spec S8/E3), then fire EXPIRE (the one door, after the write)
        await this.prisma.quote.update({ where: { id: q.id }, data: { draftJson: Prisma.DbNull } });
        await this.status.fire("quote", q.id, QuoteEvent.EXPIRE, { queryId: rfq.queryId });

        await this.dispatcher.dispatch("rfq.expiry", {
          scope: { entityType: "QUERY", entityId: rfq.queryId },
          tokens: {
            RFQ_Number: rfq.rfqNumber,
            FF_Name: rfq.freightForwarder?.companyName ?? "",
            Leg_Name: q.leg.legCode,
          },
          recipients: {
            EMAIL: rfq.freightForwarder?.email ? [rfq.freightForwarder.email] : [],
            IN_APP: execIds,
          },
          tenantId: rfq.tenantId,
        });
      }

      // no more reminders once the window closed
      await this.scheduled.cancel("RFQ", p.entityId, "rfq.reminder");
    } catch (err) {
      this.logger.error(`onExpiry failed for rfq ${p.entityId}`, err as Error);
    }
  }
}
