import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class ScheduledEventService {
  private readonly logger = new Logger(ScheduledEventService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async schedule(
    entityType: string,
    entityId: string,
    eventKey: string,
    entries: { tier: string; dueAt: Date }[],
    opts: { tenantId?: string | null; now?: Date } = {},
  ): Promise<void> {
    const now = opts.now ?? new Date();
    for (const e of entries) {
      if (e.dueAt.getTime() <= now.getTime()) continue; // skip past-due tiers
      await this.prisma.scheduledEvent.upsert({
        where: { entityType_entityId_eventKey_tier: { entityType, entityId, eventKey, tier: e.tier } },
        create: { entityType, entityId, eventKey, tier: e.tier, dueAt: e.dueAt, tenantId: opts.tenantId ?? null },
        update: {},
      });
    }
  }

  async cancel(entityType: string, entityId: string, eventKey: string): Promise<void> {
    await this.prisma.scheduledEvent.updateMany({
      where: { entityType, entityId, eventKey, firedAt: null, cancelledAt: null },
      data: { cancelledAt: new Date() },
    });
  }

  async runDue(now: Date = new Date()): Promise<{ fired: number }> {
    const due = await this.prisma.scheduledEvent.findMany({
      where: { dueAt: { lte: now }, firedAt: null, cancelledAt: null },
    });
    let fired = 0;
    for (const ev of due) {
      // Claim first (idempotent under a racing cron): only proceed if WE set firedAt.
      const claim = await this.prisma.scheduledEvent.updateMany({
        where: { id: ev.id, firedAt: null, cancelledAt: null },
        data: { firedAt: now },
      });
      if (claim.count === 0) continue;
      try {
        await this.events.emitAsync(ev.eventKey, {
          entityType: ev.entityType,
          entityId: ev.entityId,
          tier: ev.tier,
          scheduledEventId: ev.id,
        });
      } catch (err) {
        this.logger.error(`runDue emit failed for scheduled-event ${ev.id}`, err as Error);
        continue;
      }
      fired++;
    }
    return { fired };
  }
}
