import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";
import { NotificationsService } from "../src/modules/notifications/notifications.service";
import { randomUUID } from "crypto";

describe("Comms schema + seed (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifications: NotificationsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    notifications = app.get(NotificationsService);
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it("seeds the Stage-3 templates + scheduler AppSettings", async () => {
    const tpl = await prisma.messageTemplate.findUnique({ where: { key: "query.escalation.inapp" } });
    expect(tpl?.eventKey).toBe("query.escalation");
    expect(tpl?.channel).toBe("IN_APP");
    const deadline = await prisma.appSetting.findUnique({ where: { key: "rfqDeadlineDefaultHours" } });
    expect(deadline?.value).toBe("48");
  });

  it("NotificationsService writes a string type + entity anchor", async () => {
    const uid = randomUUID();
    await notifications.createMany([uid], {
      type: "quote.received", entityType: "QUERY", entityId: randomUUID(),
      message: "hi", queryId: null,
    });
    const row = await prisma.notification.findFirst({ where: { recipientUserId: uid } });
    expect(row?.type).toBe("quote.received");
    expect(row?.entityType).toBe("QUERY");
    await prisma.notification.deleteMany({ where: { recipientUserId: uid } });
  });
});
