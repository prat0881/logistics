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
  beforeAll(async () => { await prisma.$connect(); await seedReferenceData(prisma); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("seeds today's per-mode line-up with 3 inactive rows", async () => {
    const rows = await prisma.chargeLineDefinition.findMany();
    const by = (m: string, r: string) => rows.filter((x) => x.mode === m && x.role === r && x.isActive);
    expect(by("AIR", "CORE")).toHaveLength(9);
    expect(by("SEA", "CORE")).toHaveLength(6);
    expect(by("AIR", "STANDARD")).toHaveLength(3);   // dest THC/import/storage (last-mile inactive)
    expect(by("SEA", "STANDARD")).toHaveLength(3);   // delivery + last-mile inactive
    expect(by("ROAD", "STANDARD")).toHaveLength(8);
    expect(rows.filter((x) => x.role === "TAG_DRIVEN")).toHaveLength(15); // 5 × 3 modes
    expect(rows.filter((x) => !x.isActive).map((x) => x.key).sort()).toEqual(
      ["AIR_DEST_LAST_MILE", "SEA_DEST_DELIVERY", "SEA_DEST_LAST_MILE"]);
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

  it("returns only active rows and excludes the 3 inactive keys, authenticated-only (no @Roles)", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/charge-line-definitions")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((r: { isActive: boolean }) => r.isActive)).toBe(true);

    const keys = res.body.map((r: { key: string }) => r.key);
    for (const inactiveKey of ["AIR_DEST_LAST_MILE", "SEA_DEST_DELIVERY", "SEA_DEST_LAST_MILE"]) {
      expect(keys).not.toContain(inactiveKey);
    }
  });

  it("rejects unauthenticated requests", async () => {
    await request(app.getHttpServer()).get("/api/charge-line-definitions").expect(401);
  });
});
