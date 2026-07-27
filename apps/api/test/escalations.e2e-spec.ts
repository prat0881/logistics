import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { EscalationsService } from "../src/modules/escalations/escalations.service";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
const PFX = "p7-esc-";

describe("Escalations (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let svc: EscalationsService;
  let queryId: string;
  let q2: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    svc = app.get(EscalationsService);

    // Clean up any leftover rows from previous runs
    await prisma.query.deleteMany({ where: { queryCode: { startsWith: PFX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PFX } } });

    // Seed a Manager user so the T2H tier fan-out produces a notification
    await prisma.user.create({
      data: {
        name: "Mgr",
        email: `${PFX}mgr@x.com`,
        passwordHash: "x",
        role: "MANAGER",
      },
    });

    // Create two test queries
    const q = await prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}main` },
    });
    queryId = q.id;

    const q2row = await prisma.query.create({
      data: { queryCode: `${PFX}cancel-${Date.now()}`, shipmentDescription: `${PFX}cancel` },
    });
    q2 = q2row.id;
  });

  afterAll(async () => {
    await prisma.query.deleteMany({ where: { queryCode: { startsWith: PFX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PFX } } });
    await app.close();
  });

  it("creates 3 fixed timers on createForQuery", async () => {
    await svc.createForQuery(queryId, new Date("2026-01-01T00:00:00Z"));
    const rows = await prisma.escalation.findMany({ where: { queryId }, orderBy: { dueAt: "asc" } });
    expect(rows.map((r) => r.tier)).toEqual(["T30M", "T2H", "T6H"]);
    expect(rows[0].dueAt.toISOString()).toBe("2026-01-01T00:30:00.000Z");
  });

  it("runDue fires due+unfired: notifications to role-holders + one escalation email + firedAt", async () => {
    // T30M dueAt 00:30, T2H dueAt 02:00, T6H dueAt 06:00 — all due at 07:00
    await svc.runDue(new Date("2026-01-01T07:00:00Z"));
    const fired = await prisma.escalation.count({ where: { queryId, firedAt: { not: null } } });
    expect(fired).toBe(3);
    const emails = await prisma.emailLog.count({ where: { queryId, template: "ESCALATION" } });
    expect(emails).toBe(3); // one per firing
    const notifs = await prisma.notification.count({ where: { queryId } });
    expect(notifs).toBeGreaterThanOrEqual(1); // >= 1 Manager got the T2H notif
  });

  it("runDue is idempotent (no re-fire)", async () => {
    const before = await prisma.emailLog.count({ where: { queryId, template: "ESCALATION" } });
    await svc.runDue(new Date("2026-01-01T07:00:00Z"));
    expect(await prisma.emailLog.count({ where: { queryId, template: "ESCALATION" } })).toBe(before);
  });

  it("cancelForQuery stops unfired timers", async () => {
    await svc.createForQuery(q2, new Date()); // fresh query, dueAt in the future
    await svc.cancelForQuery(q2);
    await svc.runDue(new Date(Date.now() + 7 * 3600_000));
    expect(await prisma.escalation.count({ where: { queryId: q2, firedAt: { not: null } } })).toBe(0);
  });
});
