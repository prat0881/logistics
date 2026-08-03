import { Role } from "./role";

export const NotificationType = { ESCALATION: "ESCALATION" } as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];
export const NOTIFICATION_TYPES = Object.values(NotificationType) as [NotificationType, ...NotificationType[]];

export const EscalationTier = { T30M: "T30M", T2H: "T2H", T6H: "T6H" } as const;
export type EscalationTier = (typeof EscalationTier)[keyof typeof EscalationTier];
export const ESCALATION_TIERS = Object.values(EscalationTier) as [EscalationTier, ...EscalationTier[]];

export const EmailTemplate = {
  FOLLOW_UP: "FOLLOW_UP", ACKNOWLEDGEMENT: "ACKNOWLEDGEMENT", ESCALATION: "ESCALATION",
} as const;
export type EmailTemplate = (typeof EmailTemplate)[keyof typeof EmailTemplate];
export const EMAIL_TEMPLATES = Object.values(EmailTemplate) as [EmailTemplate, ...EmailTemplate[]];

export const EmailStatus = { LOGGED: "LOGGED" } as const;
export type EmailStatus = (typeof EmailStatus)[keyof typeof EmailStatus];
export const EMAIL_STATUSES = Object.values(EmailStatus) as [EmailStatus, ...EmailStatus[]];

export const TIER_ROLE: Record<EscalationTier, Role> = {
  T30M: Role.EXECUTIVE, T2H: Role.MANAGER, T6H: Role.ADMINISTRATOR,
};
export const TIER_OFFSET_MS: Record<EscalationTier, number> = {
  T30M: 30 * 60_000, T2H: 120 * 60_000, T6H: 360 * 60_000,
};
export const TIER_LABEL: Record<EscalationTier, string> = {
  T30M: "30-minute", T2H: "2-hour", T6H: "6-hour",
};

export type NotificationDto = {
  id: string; type: string; queryId: string | null;
  message: string; readAt: string | null; createdAt: string;
};
export type UnreadCountDto = { count: number };
export type EmailLogDto = {
  id: string; queryId: string; template: EmailTemplate; fromAddress: string;
  toAddress: string | null; subject: string; bodyRendered: string;
  status: EmailStatus; createdAt: string;
};
