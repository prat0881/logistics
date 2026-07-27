import { Injectable, NotFoundException } from "@nestjs/common";
import { EmailTemplate, type EmailLogDto } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

const FROM = "logistics@yankalfa.com";
const RESPONSE_TIMELINE = "24 hours";

type Ctx = { queryCode: string; clientName: string; clientEmail: string | null; missing: string[] };

export function renderEmail(template: EmailTemplate, ctx: Ctx): { subject: string; body: string; tokens: Record<string, string> } {
  const tokens: Record<string, string> = {
    Query_ID: ctx.queryCode, Client_Name: ctx.clientName, Client_Email: ctx.clientEmail ?? "",
    Missing_Fields_List: ctx.missing.join(", "), Expected_Response_Timeline: RESPONSE_TIMELINE,
  };
  if (template === EmailTemplate.FOLLOW_UP) {
    return {
      subject: `Action Required: Missing Information for Your Shipment Request – ${ctx.queryCode}`,
      body: `Dear ${ctx.clientName || "Customer"},\n\nRegarding your shipment request ${ctx.queryCode}, we need the following to proceed.\nMissing information: ${ctx.missing.join(", ") || "—"}\n\nPlease reply to this email with the details.\n\nRegards,\nYankalfa Logistics`,
      tokens,
    };
  }
  if (template === EmailTemplate.ACKNOWLEDGEMENT) {
    return {
      subject: `Acknowledgement: Shipment Query Received – Query ID: ${ctx.queryCode}`,
      body: `Dear ${ctx.clientName || "Customer"},\n\nThank you — we have created a record for your shipment query (${ctx.queryCode}). We expect to respond within ${RESPONSE_TIMELINE}. Please reply on this thread with any additional documents.\n\nRegards,\nYankalfa Logistics`,
      tokens,
    };
  }
  // ESCALATION (internal record; not a client email)
  return {
    subject: `Escalation: Query ${ctx.queryCode} awaiting action`,
    body: `Query ${ctx.queryCode} has not progressed toward RFQ Ready and has been escalated for oversight.`,
    tokens,
  };
}

@Injectable()
export class EmailsService {
  constructor(private readonly prisma: PrismaService) {}

  async compose(template: EmailTemplate, queryId: string, composedById: string | null) {
    const q = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { id: true, queryCode: true, contactName: true, contactEmail: true },
    });
    if (!q) throw new NotFoundException("Query not found");
    let missing: string[] = [];
    if (template === EmailTemplate.FOLLOW_UP) {
      const items = await this.prisma.queryChecklistItem.findMany({ where: { queryId, checked: false } });
      const defs = await this.prisma.checklistDefinition.findMany({
        where: { itemKey: { in: items.map((i) => i.itemKey) } },
      });
      const label = new Map(defs.map((d) => [d.itemKey, d.label]));
      missing = items.map((i) => label.get(i.itemKey) ?? i.itemKey);
    }
    const { subject, body, tokens } = renderEmail(template, {
      queryCode: q.queryCode, clientName: q.contactName ?? "", clientEmail: q.contactEmail, missing,
    });
    return this.prisma.emailLog.create({
      data: {
        queryId, template, fromAddress: FROM, toAddress: q.contactEmail, subject,
        bodyRendered: body, tokens, composedById, status: "LOGGED",
      },
    });
  }

  async list(queryId: string): Promise<EmailLogDto[]> {
    const rows = await this.prisma.emailLog.findMany({ where: { queryId }, orderBy: { createdAt: "desc" } });
    return rows.map((r) => ({
      id: r.id, queryId: r.queryId, template: r.template, fromAddress: r.fromAddress,
      toAddress: r.toAddress, subject: r.subject, bodyRendered: r.bodyRendered,
      status: r.status, createdAt: r.createdAt.toISOString(),
    })) as EmailLogDto[];
  }
}
