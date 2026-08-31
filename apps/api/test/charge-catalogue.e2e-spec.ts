process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";

describe("charge catalogue seed", () => {
  const prisma = new PrismaService();
  beforeAll(async () => {
    await prisma.$connect();
    await seedReferenceData(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Counts below track apps/api/src/seed/reference-seed.ts's CHARGE_LINE_DEFINITIONS +
  // NEW_CHARGE_LINES exactly. Task 12 (master-data expansion) added 19 lines: 16 active
  // executive-selected STANDARD lines (AIR ORIGIN/DEST +5, SEA DEST/ADDITIONAL +10, ROAD
  // ADDITIONAL +1 — none change CORE or TAG_DRIVEN counts) and 3 dormant always-included lines
  // (AIR_ORIGIN_INSURANCE, SEA_ORIGIN_CONTAINER_TRANSPORT, SEA_ORIGIN_LSS — role CORE via
  // isAdditional:false, seeded isActive:false per D17 so pricing is unchanged), growing the
  // inactive-row count 4 -> 7. Prior to Task 12: AIR CORE gained AIR_MAIN_FSC +
  // AIR_MAIN_PEAK_SEASON (9 -> 11 active), and SEA_MAIN_FREIGHT was retired (isActive:false —
  // sea freight is now the structured seaRates[] dual-rate, design §5.2), dropping SEA CORE
  // 6 -> 5 active.
  it("seeds today's per-mode line-up with 7 inactive rows", async () => {
    const rows = await prisma.chargeLineDefinition.findMany();
    const by = (m: string, r: string) =>
      rows.filter((x) => x.mode === m && x.role === r && x.isActive);
    expect(by("AIR", "CORE")).toHaveLength(11);
    expect(by("SEA", "CORE")).toHaveLength(5);
    // dest THC/import/storage + Task 12's AIR_ORIGIN_MAGNETIC_FEE/T1_EUROPE/EDD +
    // AIR_DEST_CUSTOM_DOCS_T1/FILE_OPENING (AIR_ORIGIN_INSURANCE is CORE-role and inactive)
    expect(by("AIR", "STANDARD")).toHaveLength(8);
    // delivery + last-mile inactive; plus Task 12's 8 SEA_DEST_* + 2 SEA_ADD_* active lines
    // (SEA_ORIGIN_CONTAINER_TRANSPORT/LSS are CORE-role and inactive)
    expect(by("SEA", "STANDARD")).toHaveLength(13);
    expect(by("ROAD", "STANDARD")).toHaveLength(9); // +ROAD_ADD_BONDED_LICENCE
    expect(rows.filter((x) => x.role === "TAG_DRIVEN")).toHaveLength(15); // 5 × 3 modes, unchanged
    expect(
      rows
        .filter((x) => !x.isActive)
        .map((x) => x.key)
        .sort(),
    ).toEqual([
      "AIR_DEST_LAST_MILE",
      "AIR_ORIGIN_INSURANCE",
      "SEA_DEST_DELIVERY",
      "SEA_DEST_LAST_MILE",
      "SEA_MAIN_FREIGHT",
      "SEA_ORIGIN_CONTAINER_TRANSPORT",
      "SEA_ORIGIN_LSS",
    ]);
    expect(rows.find((x) => x.key === "ROAD_CORE_TRUCKING")?.inputType).toBe("TRUCKING");
    expect(rows.find((x) => x.key === "ROAD_WH_HANDLING")?.role).toBe("WAREHOUSE");
  });

  it("is idempotent (second seed adds no rows)", async () => {
    const before = await prisma.chargeLineDefinition.count();
    await seedReferenceData(prisma);
    expect(await prisma.chargeLineDefinition.count()).toBe(before);
  });
});

describe("GET /api/charge-line-definitions (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("returns only active rows and excludes the 4 inactive keys, authenticated-only (no @Roles)", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/charge-line-definitions")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((r: { isActive: boolean }) => r.isActive)).toBe(true);

    const keys = res.body.map((r: { key: string }) => r.key);
    for (const inactiveKey of [
      "AIR_DEST_LAST_MILE",
      "SEA_DEST_DELIVERY",
      "SEA_DEST_LAST_MILE",
      "SEA_MAIN_FREIGHT",
      // Task 12 (D17): dormant always-included lines must not leak into the active list either.
      "AIR_ORIGIN_INSURANCE",
      "SEA_ORIGIN_CONTAINER_TRANSPORT",
      "SEA_ORIGIN_LSS",
    ]) {
      expect(keys).not.toContain(inactiveKey);
    }
  });

  it("rejects unauthenticated requests", async () => {
    await request(app.getHttpServer()).get("/api/charge-line-definitions").expect(401);
  });
});
