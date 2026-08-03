import { PrismaClient } from "@prisma/client";

// Seed rows are create-only (Design §7): defaults on first deploy, never overwriting an edit.
// Stage-3 templates (migrated). RFQ/quote templates are appended in Task 8.
export const MESSAGE_TEMPLATES: {
  key: string; eventKey: string; channel: "IN_APP" | "EMAIL"; subject: string | null; body: string;
}[] = [
  {
    key: "query.follow_up.email", eventKey: "query.follow_up", channel: "EMAIL",
    subject: "Action Required: Missing Information for Your Shipment Request – {{Query_ID}}",
    body: "Dear {{Client_Name}},\n\nRegarding your shipment request {{Query_ID}}, we need the following to proceed.\nMissing information: {{Missing_Fields_List}}\n\nPlease reply to this email with the details.\n\nRegards,\nYankalfa Logistics",
  },
  {
    key: "query.acknowledgement.email", eventKey: "query.acknowledgement", channel: "EMAIL",
    subject: "Acknowledgement: Shipment Query Received – Query ID: {{Query_ID}}",
    body: "Dear {{Client_Name}},\n\nThank you — we have created a record for your shipment query ({{Query_ID}}). We expect to respond within {{Expected_Response_Timeline}}. Please reply on this thread with any additional documents.\n\nRegards,\nYankalfa Logistics",
  },
  {
    key: "query.escalation.email", eventKey: "query.escalation", channel: "EMAIL",
    subject: "Escalation: Query {{Query_ID}} awaiting action",
    body: "Query {{Query_ID}} has not progressed toward RFQ Ready and has been escalated for oversight ({{Tier_Label}}).",
  },
  {
    key: "query.escalation.inapp", eventKey: "query.escalation", channel: "IN_APP",
    subject: null,
    body: "Query {{Query_ID}} awaiting action — {{Tier_Label}} escalation",
  },
];

export async function seedMessageTemplates(prisma: PrismaClient): Promise<void> {
  for (const t of MESSAGE_TEMPLATES) {
    await prisma.messageTemplate.upsert({ where: { key: t.key }, create: t, update: {} });
  }
}
