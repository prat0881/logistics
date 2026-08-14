import { PrismaClient } from "@prisma/client";

// Seed rows are create-only (Design §7): defaults on first deploy, never overwriting an edit.
// Stage-3 templates (migrated) followed by the RFQ/quote templates (Task 8).
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
  {
    key: "rfq.invitation.email", eventKey: "rfq.invitation", channel: "EMAIL",
    subject: "Request for Quotation — RFQ {{RFQ_Number}}",
    body: "You have been invited to quote RFQ {{RFQ_Number}} ({{Leg_Names}}).\nSubmission deadline: {{Deadline}}.\nOpen your secure portal: {{Access_Link}}",
  },
  {
    key: "rfq.updated.email", eventKey: "rfq.updated", channel: "EMAIL",
    subject: "RFQ {{RFQ_Number}} updated — a leg was added",
    body: "RFQ {{RFQ_Number}} has been updated with additional legs ({{Leg_Names}}). Please review it via your existing secure portal link.",
  },
  {
    key: "rfq.reminder.email", eventKey: "rfq.reminder", channel: "EMAIL",
    subject: "Reminder: RFQ {{RFQ_Number}} closes {{Deadline}}",
    body: "This is a reminder that RFQ {{RFQ_Number}} closes at {{Deadline}}. Please submit your quote before the deadline via your secure portal link.",
  },
  {
    key: "rfq.expiry.email", eventKey: "rfq.expiry", channel: "EMAIL",
    subject: "RFQ {{RFQ_Number}} — submission window closed",
    body: "Your RFQ {{RFQ_Number}} submission window has expired. No further quotes can be accepted for this RFQ.",
  },
  {
    key: "rfq.expiry.inapp", eventKey: "rfq.expiry", channel: "IN_APP",
    subject: null,
    body: "{{FF_Name}} did not submit {{Leg_Name}} — RFQ {{RFQ_Number}} has expired.",
  },
  {
    key: "rfq.submission_ack.email", eventKey: "rfq.submission_ack", channel: "EMAIL",
    subject: "Quote received — RFQ {{RFQ_Number}}",
    body: "Thank you — your quote for RFQ {{RFQ_Number}} has been received.",
  },
  {
    key: "quote.received.inapp", eventKey: "quote.received", channel: "IN_APP",
    subject: null,
    body: "{{FF_Name}} submitted a quote for {{Leg_Name}} (RFQ {{RFQ_Number}}).",
  },
  // Sub-build 6 (change-order cascade, Task 9): fired when a distributed leg is reopened —
  // EMAIL to each invalidated FF, IN_APP to the query's Executive (rfq-notifications.service.ts).
  {
    key: "rfq.leg.reopened.email", eventKey: "rfq.leg.reopened", channel: "EMAIL",
    subject: "RFQ {{rfqNumber}} — leg {{legCode}} reopened for re-quote",
    body: "Your quote for leg {{legCode}} ({{origin}} -> {{destination}}) on RFQ {{rfqNumber}} has been invalidated because the shipment details changed.\nReason: {{reason}}\n\nThe leg has been reopened. You will be re-invited to submit a new quote once it is re-distributed.",
  },
  {
    key: "rfq.leg.reopened.inapp", eventKey: "rfq.leg.reopened", channel: "IN_APP",
    subject: null,
    body: "Leg {{legCode}} ({{origin}} -> {{destination}}) on RFQ {{rfqNumber}} was reopened — {{reason}}",
  },
  // S5.5 (negotiation, design §10.1): fired when an Executive requests a revised price from a
  // single FF (NegotiationService.requestRequote) — EMAIL to that FF, carrying the negotiation
  // comment + a fresh portal link (the token is reissued in the same action). Deliberately a
  // dedicated eventKey rather than reusing rfq.updated (whose copy is "a leg was added" and
  // carries no comment token).
  {
    key: "rfq.requote_requested.email", eventKey: "rfq.requote_requested", channel: "EMAIL",
    subject: "RFQ {{RFQ_Number}} — revised quote requested",
    body: "We would like to request a revised quote for RFQ {{RFQ_Number}}.\nComment: {{Comment}}\n\nYour earlier submission remains on file. Please submit your updated price via your secure portal link: {{Access_Link}}",
  },
  {
    key: "rfq.requote_requested.inapp", eventKey: "rfq.requote_requested", channel: "IN_APP",
    subject: null,
    body: "Revised quote requested for RFQ {{RFQ_Number}} — {{Comment}}",
  },
];

export async function seedMessageTemplates(prisma: PrismaClient): Promise<void> {
  for (const t of MESSAGE_TEMPLATES) {
    await prisma.messageTemplate.upsert({ where: { key: t.key }, create: t, update: {} });
  }
}
