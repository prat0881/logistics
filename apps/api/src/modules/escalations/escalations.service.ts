import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Role } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { ScheduledEventService } from "../comms/scheduled-event.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";

const TIERS = ["T30M", "T2H", "T6H"] as const;
type Tier = (typeof TIERS)[number];
const TIER_OFFSET_MS: Record<Tier, number> = { T30M: 30 * 60_000, T2H: 120 * 60_000, T6H: 360 * 60_000 };
const TIER_ROLE: Record<Tier, Role> = { T30M: Role.EXECUTIVE, T2H: Role.MANAGER, T6H: Role.ADMINISTRATOR };
const TIER_LABEL: Record<Tier, string> = { T30M: "30-minute", T2H: "2-hour", T6H: "6-hour" };

@Injectable()
export class EscalationsService {
  private readonly logger = new Logger(EscalationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly scheduled: ScheduledEventService,
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
    await this.scheduled.schedule(
      "QUERY", queryId, "query.escalation",
      TIERS.map((tier) => ({ tier, dueAt: new Date(createdAt.getTime() + TIER_OFFSET_MS[tier]) })),
      { tenantId: q?.tenantId ?? null, now: createdAt },
    );
  }

  async cancelForQuery(queryId: string): Promise<void> {
    await this.scheduled.cancel("QUERY", queryId, "query.escalation");
  }

  @OnEvent("query.escalation")
  async onEscalationDue(payload: { entityId: string; tier: string }): Promise<void> {
    try {
      const tier = payload.tier as Tier;
      const query = await this.prisma.query.findUnique({
        where: { id: payload.entityId },
        select: { queryCode: true, tenantId: true },
      });
      if (!query) return;
      const users = await this.prisma.user.findMany({
        where: { role: TIER_ROLE[tier], isActive: true },
        select: { id: true, email: true },
      });
      const tokens = { Query_ID: query.queryCode, Tier_Label: TIER_LABEL[tier] };
      // one dispatch: in-app (renders query.escalation.inapp) + email to the SAME tier-role staff
      await this.dispatcher.dispatch("query.escalation", {
        scope: { entityType: "QUERY", entityId: payload.entityId },
        tokens,
        recipients: {
          IN_APP: users.map((u) => u.id),
          EMAIL: users.map((u) => u.email).filter((e): e is string => !!e),
        },
        tenantId: query.tenantId,
      });
    } catch (err) {
      this.logger.error(`onEscalationDue failed for ${payload.entityId}`, err as Error);
    }
  }
}
