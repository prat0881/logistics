// packages/shared/src/comms.ts

// Delivery channels a message event may fan out to (Design §3).
export const Channel = { IN_APP: "IN_APP", EMAIL: "EMAIL" } as const;
export type Channel = (typeof Channel)[keyof typeof Channel];
export const CHANNELS = Object.values(Channel) as [Channel, ...Channel[]];

// Delivery status of an outbound message. LOGGED now; SENT/FAILED when live (Design §17.3).
export const MessageStatus = { LOGGED: "LOGGED", SENT: "SENT", FAILED: "FAILED" } as const;
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];
export const MESSAGE_STATUSES = Object.values(MessageStatus) as [MessageStatus, ...MessageStatus[]];

// AppSetting keys for scheduler scalars (Design §7). Editable via seed/DB.
export const RFQ_DEADLINE_HOURS_KEY = "rfqDeadlineDefaultHours";
export const RFQ_REMINDER_OFFSETS_KEY = "rfqReminderOffsetsHours";
export const DEFAULT_RFQ_DEADLINE_HOURS = 48;
export const DEFAULT_RFQ_REMINDER_OFFSETS = [36, 24, 12, 6, 2];

// Known comms events + the tokens each template may reference. Test-pinned; the future
// admin editor (Design §17.1) reads this to show "available tokens".
export const COMMS_EVENTS = {
  "query.follow_up": ["Query_ID", "Client_Name", "Missing_Fields_List", "Expected_Response_Timeline"],
  "query.acknowledgement": ["Query_ID", "Client_Name", "Expected_Response_Timeline"],
  "query.escalation": ["Query_ID", "Tier_Label"],
  "rfq.invitation": ["RFQ_Number", "Leg_Names", "Deadline", "Access_Link"],
  "rfq.updated": ["RFQ_Number", "Leg_Names"],
  "rfq.reminder": ["RFQ_Number", "Deadline"],
  "rfq.expiry": ["RFQ_Number", "FF_Name", "Leg_Name"],
  "rfq.submission_ack": ["RFQ_Number"],
  "quote.received": ["RFQ_Number", "FF_Name", "Leg_Name"],
} as const;
export type CommsEventKey = keyof typeof COMMS_EVENTS;
export const COMMS_EVENT_KEYS = Object.keys(COMMS_EVENTS) as CommsEventKey[];

// Pure token substitution: {{Token}} → tokens[Token] ?? "".
export function renderTemplate(tpl: string, tokens: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => tokens[k] ?? "");
}
