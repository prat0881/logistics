import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { NotificationDispatcher } from "../src/modules/comms/notification-dispatcher.service";
import { randomUUID } from "crypto";

describe("NotificationDispatcher (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: NotificationDispatcher;
  const userId = randomUUID();
  const entityId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    dispatcher = app.get(NotificationDispatcher);
    await prisma.messageTemplate.deleteMany({ where: { eventKey: "test.dispatch" } });
    await prisma.messageTemplate.createMany({
      data: [
        { key: "test.dispatch.email", eventKey: "test.dispatch", channel: "EMAIL", subject: "Hi {{Name}}", body: "Body {{Name}}", active: true },
        { key: "test.dispatch.inapp", eventKey: "test.dispatch", channel: "IN_APP", subject: null, body: "InApp {{Name}}", active: true },
      ],
    });
    // Notification.queryId has a real FK to Query.id (onDelete: Cascade) — dispatch()
    // sets queryId = entityId when scope.entityType === "QUERY" (per spec), so this
    // scope's entityId must back a real Query row or the write violates the FK.
    await prisma.query.create({ data: { id: entityId, queryCode: `TEST-DISPATCH-${entityId}` } });
  });

  afterAll(async () => {
    await prisma.messageTemplate.deleteMany({ where: { eventKey: "test.dispatch" } });
    await prisma.messageLog.deleteMany({ where: { entityId } });
    await prisma.notification.deleteMany({ where: { recipientUserId: userId } });
    await prisma.query.deleteMany({ where: { id: entityId } });
    await app.close();
  });

  it("writes a Notification (IN_APP) and a MessageLog (EMAIL), both rendered", async () => {
    await dispatcher.dispatch("test.dispatch", {
      scope: { entityType: "QUERY", entityId },
      tokens: { Name: "Acme" },
      recipients: { IN_APP: [userId], EMAIL: ["ff@x.com"] },
    });
    const notif = await prisma.notification.findFirst({ where: { recipientUserId: userId, entityId } });
    expect(notif?.message).toBe("InApp Acme");
    expect(notif?.type).toBe("test.dispatch");
    const log = await prisma.messageLog.findFirst({ where: { entityId, channel: "EMAIL" } });
    expect(log?.subject).toBe("Hi Acme");
    expect(log?.bodyRendered).toBe("Body Acme");
    expect(log?.toAddress).toBe("ff@x.com");
    expect(log?.status).toBe("LOGGED");
  });

  it("skips a channel with no active template", async () => {
    const otherEntity = randomUUID();
    await dispatcher.dispatch("test.dispatch", {
      scope: { entityType: "QUERY", entityId: otherEntity },
      tokens: { Name: "Z" },
      recipients: { EMAIL: ["a@b.com"] }, // no IN_APP recipients → no notification
    });
    expect(await prisma.notification.count({ where: { entityId: otherEntity } })).toBe(0);
    expect(await prisma.messageLog.count({ where: { entityId: otherEntity } })).toBe(1);
    await prisma.messageLog.deleteMany({ where: { entityId: otherEntity } });
  });
});
