import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  ESCALATION_TIERS, TIER_ROLE, TIER_OFFSET_MS, TIER_LABEL, NotificationType, EmailTemplate,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailsService } from "../emails/emails.service";

@Injectable()
export class EscalationsService {
  private readonly logger = new Logger(EscalationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly emails: EmailsService,
  ) {}

  @OnEvent("query.created")
  async onQueryCreated(e: { queryId: string; createdAt: Date }): Promise<void> {
    try { await this.createForQuery(e.queryId, e.createdAt); }
    catch (err) { this.logger.error(`createForQuery failed for ${e.queryId}`, err as Error); }
  }

  @OnEvent("query.rfq_ready")
  async onQueryRfqReady(e: { queryId: string }): Promise<void> {
    try { await this.cancelForQuery(e.queryId); }
    catch (err) { this.logger.error(`cancelForQuery failed for ${e.queryId}`, err as Error); }
  }

  async createForQuery(queryId: string, createdAt: Date): Promise<void> {
    const q = await this.prisma.query.findUnique({ where: { id: queryId }, select: { tenantId: true } });
    for (const tier of ESCALATION_TIERS) {
      await this.prisma.escalation.upsert({
        where: { queryId_tier: { queryId, tier } },     // @@unique([queryId, tier]) → idempotent
        create: {
          queryId, tier, recipientRole: TIER_ROLE[tier],
          dueAt: new Date(createdAt.getTime() + TIER_OFFSET_MS[tier]), tenantId: q?.tenantId ?? null,
        },
        update: {},
      });
    }
  }

  async cancelForQuery(queryId: string): Promise<void> {
    await this.prisma.escalation.updateMany({
      where: { queryId, firedAt: null, cancelledAt: null }, data: { cancelledAt: new Date() },
    });
  }

  async runDue(now: Date = new Date()): Promise<{ fired: number }> {
    const due = await this.prisma.escalation.findMany({
      where: { dueAt: { lte: now }, firedAt: null, cancelledAt: null },
      include: { query: { select: { queryCode: true, tenantId: true } } },
    });
    let fired = 0;
    for (const esc of due) {
      // Claim the row first (idempotent under a racing cron): only proceed if WE set firedAt.
      const claim = await this.prisma.escalation.updateMany({
        where: { id: esc.id, firedAt: null, cancelledAt: null }, data: { firedAt: now },
      });
      if (claim.count === 0) continue;
      try {
        const users = await this.prisma.user.findMany({
          where: { role: esc.recipientRole, isActive: true }, select: { id: true },
        });
        await this.notifications.createMany(users.map((u) => u.id), {
          type: NotificationType.ESCALATION, queryId: esc.queryId, tenantId: esc.tenantId,
          message: `Query ${esc.query.queryCode} awaiting action — ${TIER_LABEL[esc.tier]} escalation`,
        });
        await this.emails.compose(EmailTemplate.ESCALATION, esc.queryId, null);
      } catch (err) {
        this.logger.error(`runDue notify/compose failed for escalation ${esc.id}`, err as Error);
        continue;
      }
      fired++;
    }
    return { fired };
  }
}
