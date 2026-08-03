import { describe, it, expect } from "vitest";
import type { NotificationDto, UnreadCountDto, EmailLogDto } from "./notifications";

describe("notifications DTOs", () => {
  it("carry plain-string comms fields (enums retired with the legacy tables)", () => {
    const notif: NotificationDto = {
      id: "n1", type: "query.escalation", queryId: "q1",
      message: "hi", readAt: null, createdAt: "2026-01-01T00:00:00.000Z",
    };
    const unread: UnreadCountDto = { count: 3 };
    const email: EmailLogDto = {
      id: "e1", queryId: "q1", template: "query.follow_up.email", fromAddress: "from@x.com",
      toAddress: "to@x.com", subject: "s", bodyRendered: "b", status: "LOGGED",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(notif.type).toBe("query.escalation");
    expect(unread.count).toBe(3);
    expect(email.template).toBe("query.follow_up.email");
    expect(email.status).toBe("LOGGED");
  });
});
