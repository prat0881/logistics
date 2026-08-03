import { Injectable, NotFoundException } from "@nestjs/common";
import type { EmailLogDto } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";

const RESPONSE_TIMELINE = "24 hours";

@Injectable()
export class EmailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async compose(
    eventKey: "query.follow_up" | "query.acknowledgement",
    queryId: string,
    composedById: string | null,
  ): Promise<void> {
    const q = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { id: true, queryCode: true, contactName: true, contactEmail: true, tenantId: true },
    });
    if (!q) throw new NotFoundException("Query not found");

    let missing: string[] = [];
    if (eventKey === "query.follow_up") {
      const items = await this.prisma.queryChecklistItem.findMany({ where: { queryId, checked: false } });
      const defs = await this.prisma.checklistDefinition.findMany({
        where: { itemKey: { in: items.map((i) => i.itemKey) } },
      });
      const label = new Map(defs.map((d) => [d.itemKey, d.label]));
      missing = items.map((i) => label.get(i.itemKey) ?? i.itemKey);
    }

    await this.dispatcher.dispatch(eventKey, {
      scope: { entityType: "QUERY", entityId: queryId },
      tokens: {
        Query_ID: q.queryCode,
        Client_Name: q.contactName ?? "",
        Missing_Fields_List: missing.join(", ") || "—",
        Expected_Response_Timeline: RESPONSE_TIMELINE,
      },
      recipients: { EMAIL: q.contactEmail ? [q.contactEmail] : [] },
      composedById,
      tenantId: q.tenantId,
    });
  }

  async list(queryId: string): Promise<EmailLogDto[]> {
    const rows = await this.prisma.messageLog.findMany({
      where: { entityType: "QUERY", entityId: queryId, channel: "EMAIL" },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => ({
      id: r.id,
      queryId,
      template: r.templateKey,
      fromAddress: r.fromAddress,
      toAddress: r.toAddress,
      subject: r.subject ?? "",
      bodyRendered: r.bodyRendered,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
