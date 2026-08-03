export type NotificationDto = {
  id: string; type: string; queryId: string | null;
  message: string; readAt: string | null; createdAt: string;
};
export type UnreadCountDto = { count: number };
export type EmailLogDto = {
  id: string; queryId: string; template: string; fromAddress: string;
  toAddress: string | null; subject: string; bodyRendered: string;
  status: string; createdAt: string;
};
