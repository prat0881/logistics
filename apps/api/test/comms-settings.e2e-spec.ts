import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";
import { CommsSettingsService } from "../src/modules/comms/comms-settings.service";

describe("CommsSettingsService (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let svc: CommsSettingsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    svc = app.get(CommsSettingsService);
    await seedReferenceData(prisma);
  });

  afterAll(async () => { await app.close(); });

  it("reads the seeded defaults", async () => {
    expect(await svc.rfqDeadlineHours()).toBe(48);
    expect(await svc.rfqReminderOffsets()).toEqual([36, 24, 12, 6, 2]);
  });

  it("reads an overridden value", async () => {
    await prisma.appSetting.update({ where: { key: "rfqDeadlineDefaultHours" }, data: { value: "24" } });
    expect(await svc.rfqDeadlineHours()).toBe(24);
    await prisma.appSetting.update({ where: { key: "rfqDeadlineDefaultHours" }, data: { value: "48" } });
  });
});
