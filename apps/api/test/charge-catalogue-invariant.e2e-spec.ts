import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { deriveRole, deriveZone } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Charge catalogue invariant (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await app.close(); // mandatory — prevents cron hang
  });

  it("keeps zone and role derivable from category and isAdditional for every definition", async () => {
    const rows = await prisma.chargeLineDefinition.findMany();
    expect(rows.length).toBeGreaterThan(0);

    const drifted = rows
      .filter((r) => r.key !== "ROAD_WH_HANDLING") // warehousing is deferred; it has no category
      .filter(
        (r) =>
          r.zone !== deriveZone(r.category as never, r.mode as never) ||
          r.role !== deriveRole(r.isAdditional, (r.tagKey ?? null) as never),
      )
      .map((r) => r.key);

    expect(drifted).toEqual([]);
  });
});
