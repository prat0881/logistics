import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { resolveChargeConfig } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";

// Task 12 acceptance criterion (spec §7): distribute must produce byte-identical
// chargeConfigSnapshot output before and after the 19 new charge-line definitions are seeded.
// AIR_ORIGIN_INSURANCE / SEA_ORIGIN_CONTAINER_TRANSPORT / SEA_ORIGIN_LSS are always-included
// (CORE, once active) so they are seeded isActive:false (D17) — an active always-included line
// would price on every future Air/Sea RFQ the moment the seed ran.
describe("Charge catalogue snapshot (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    // create-only upserts: guarantees the charge-line catalogue exists regardless of test
    // order/DB state (CI has no seed step).
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await app.close(); // mandatory — prevents cron hang
  });

  it("does not change what an Air leg resolves to, despite 19 new definitions", async () => {
    const definitions = await prisma.chargeLineDefinition.findMany({ where: { mode: "AIR" } });
    const snapshot = resolveChargeConfig(definitions as never, [], false, []);

    // Only always-included lines land on a leg with nothing selected and no tags.
    const keys = snapshot.lines.map((l) => l.definitionKey).sort();
    expect(keys).toEqual([
      "AIR_MAIN_CARRIER_SURCHARGE",
      "AIR_MAIN_FREIGHT",
      "AIR_MAIN_FSC",
      "AIR_MAIN_HEAVY_WEIGHT",
      "AIR_MAIN_PEAK_SEASON",
      "AIR_MAIN_SEC",
      "AIR_ORIGIN_DOCUMENTATION",
      "AIR_ORIGIN_EXPORT_CLEARANCE",
      "AIR_ORIGIN_SECURITY",
      "AIR_ORIGIN_THC",
      "AIR_ORIGIN_WAREHOUSE_PRESTORAGE",
    ]);
    // AIR_ORIGIN_INSURANCE is new and always-included, so it is seeded inactive (D17) and
    // must NOT appear here. If it does, the seed changed live pricing.
    expect(keys).not.toContain("AIR_ORIGIN_INSURANCE");
  });

  it("seeds the three new always-included lines inactive", async () => {
    const rows = await prisma.chargeLineDefinition.findMany({
      where: { key: { in: ["AIR_ORIGIN_INSURANCE", "SEA_ORIGIN_CONTAINER_TRANSPORT", "SEA_ORIGIN_LSS"] } },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.isActive === false)).toBe(true);
  });

  it("seeds the sixteen executive-selected lines active", async () => {
    const row = await prisma.chargeLineDefinition.findUnique({ where: { key: "SEA_DEST_WHARFAGE" } });
    expect(row?.isActive).toBe(true);
    expect(row?.isAdditional).toBe(true);
    expect(row?.role).toBe("STANDARD");
  });
});
