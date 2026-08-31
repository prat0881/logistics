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

// Additive admin read endpoint (Task 13 defect fix): the existing @Get() is active-only and
// shaped for the RFQ workspace (role/zone, no category/variant/isAdditional) — see
// apps/web/src/features/rfq-workspace/useChargeConfig.ts, a do-not-touch consumer of that
// exact route + shape. GET /admin is a separate handler, never touching list().
const BASE = "/api/charge-line-definitions/admin";

describe("Charge catalogue admin read (e2e)", () => {
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
    // create-only upserts: guarantees AIR_ORIGIN_INSURANCE (inactive) exists regardless of
    // test order/DB state (CI has no seed step).
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await app.close(); // mandatory — prevents cron hang
  });

  it("returns inactive rows the existing GET omits", async () => {
    const res = await request(app.getHttpServer())
      .get(BASE).set("Cookie", cookie(Role.ADMINISTRATOR))
      .expect(200);

    const keys = res.body.map((r: { key: string }) => r.key);
    expect(keys).toContain("AIR_ORIGIN_INSURANCE"); // seeded isActive: false (D17)

    const row = res.body.find((r: { key: string }) => r.key === "AIR_ORIGIN_INSURANCE");
    expect(row.isActive).toBe(false);
  });

  it("carries category, variant and isAdditional, unlike the existing GET", async () => {
    const res = await request(app.getHttpServer())
      .get(BASE).set("Cookie", cookie(Role.ADMINISTRATOR))
      .expect(200);

    const row = res.body.find((r: { key: string }) => r.key === "SEA_DEST_WHARFAGE");
    expect(row).toBeDefined();
    expect(row.category).toBe("DESTINATION");
    expect(row.variant).toBeDefined();
    expect(typeof row.isAdditional).toBe("boolean");
  });

  it("orders by mode, then category, then sortOrder", async () => {
    const res = await request(app.getHttpServer())
      .get(BASE).set("Cookie", cookie(Role.ADMINISTRATOR))
      .expect(200);

    const rows = res.body as { mode: string; category: string | null; sortOrder: number }[];
    expect(rows.length).toBeGreaterThan(0);

    // mode is grouped (every row for a given mode is contiguous) — Postgres orders the
    // FreightMode enum by its schema declaration order (ROAD, AIR, SEA), not alphabetically,
    // so this checks grouping rather than assuming a JS string sort order.
    const seenModes = new Set<string>();
    let prevMode: string | null = null;
    for (const r of rows) {
      if (r.mode !== prevMode) {
        expect(seenModes.has(r.mode)).toBe(false);
        seenModes.add(r.mode);
        prevMode = r.mode;
      }
    }

    // Within each mode, category is grouped (every row for a given category is contiguous —
    // no interleaving), and sortOrder is non-decreasing within each mode+category group.
    let prev: { mode: string; category: string | null; sortOrder: number } | null = null;
    const seenGroups = new Set<string>();
    for (const r of rows) {
      const groupKey = `${r.mode}|${r.category ?? "∅"}`;
      if (prev && prev.mode === r.mode && prev.category === r.category) {
        expect(r.sortOrder).toBeGreaterThanOrEqual(prev.sortOrder);
      } else if (prev && prev.mode === r.mode) {
        // Category changed within the same mode — that new group must not have been seen
        // before (proves categories aren't interleaved within a mode).
        expect(seenGroups.has(groupKey)).toBe(false);
      }
      seenGroups.add(groupKey);
      prev = r;
    }

    // ROAD_WH_HANDLING (null category) is a real row this endpoint must include.
    expect(rows.some((r) => r.category === null)).toBe(true);
  });

  it("refuses an Executive with 403", async () => {
    await request(app.getHttpServer())
      .get(BASE).set("Cookie", cookie(Role.EXECUTIVE))
      .expect(403);
  });

  it("allows a Manager", async () => {
    await request(app.getHttpServer())
      .get(BASE).set("Cookie", cookie(Role.MANAGER))
      .expect(200);
  });
});
