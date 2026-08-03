import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { MessageTemplateService } from "../src/modules/comms/message-template.service";

describe("MessageTemplateService (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let svc: MessageTemplateService;
  const KEY = "test.evt.email";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    svc = app.get(MessageTemplateService);
    await prisma.messageTemplate.deleteMany({ where: { eventKey: "test.evt" } });
    await prisma.messageTemplate.create({
      data: { key: KEY, eventKey: "test.evt", channel: "EMAIL", subject: "S {{X}}", body: "B {{X}}", active: true },
    });
  });

  afterAll(async () => {
    await prisma.messageTemplate.deleteMany({ where: { eventKey: "test.evt" } });
    await app.close();
  });

  it("returns the active row for (eventKey, channel)", async () => {
    const row = await svc.lookup("test.evt", "EMAIL");
    expect(row).toEqual({ key: KEY, subject: "S {{X}}", body: "B {{X}}" });
  });

  it("returns null for an inactive template", async () => {
    await prisma.messageTemplate.update({ where: { key: KEY }, data: { active: false } });
    expect(await svc.lookup("test.evt", "EMAIL")).toBeNull();
    await prisma.messageTemplate.update({ where: { key: KEY }, data: { active: true } });
  });

  it("returns null when no template exists for the channel", async () => {
    expect(await svc.lookup("test.evt", "IN_APP")).toBeNull();
  });
});
