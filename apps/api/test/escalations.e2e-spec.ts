import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { EscalationsService } from "../src/modules/escalations/escalations.service";
import { ScheduledEventService } from "../src/modules/comms/scheduled-event.service";
import { seedReferenceData } from "../src/seed/reference-seed";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
const PFX = "p7-esc-";

describe("Escalations (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let esc: EscalationsService;
  let scheduled: ScheduledEventService;
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
    esc = app.get(EscalationsService);
    scheduled = app.get(ScheduledEventService);

    // Escalation templates (query.escalation.email / .inapp) must exist for the dispatcher.
    await seedReferenceData(prisma);

    // Clean up any leftover rows from previous runs
    await prisma.query.deleteMany({ where: { queryCode: { startsWith: PFX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PFX } } });

    // Seed a Manager user so the T2H tier fan-out produces a notification + email
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
    await prisma.scheduledEvent.deleteMany({
      where: { entityType: "QUERY", entityId: { in: [queryId, q2] } },
    });
    await prisma.messageLog.deleteMany({
      where: { entityType: "QUERY", entityId: { in: [queryId, q2] } },
    });
    await prisma.query.deleteMany({ where: { queryCode: { startsWith: PFX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PFX } } });
    await app.close();
  });

  it("createForQuery schedules 3 escalation timers", async () => {
    await esc.createForQuery(queryId, new Date("2026-01-01T00:00:00Z"));
    const rows = await prisma.scheduledEvent.findMany({
      where: { entityType: "QUERY", entityId: queryId, eventKey: "query.escalation" },
      orderBy: { dueAt: "asc" },
    });
    expect(rows.map((r) => r.tier)).toEqual(["T30M", "T2H", "T6H"]);
    expect(rows[0].dueAt.toISOString()).toBe("2026-01-01T00:30:00.000Z");
  });

  it("runDue fires escalation timers → in-app notifications + escalation emails + firedAt", async () => {
    // T30M dueAt 00:30, T2H dueAt 02:00, T6H dueAt 06:00 — all due at 07:00
    await scheduled.runDue(new Date("2026-01-01T07:00:00Z"));

    const fired = await prisma.scheduledEvent.count({
      where: { entityType: "QUERY", entityId: queryId, eventKey: "query.escalation", firedAt: { not: null } },
    });
    expect(fired).toBe(3);

    // >= 1 Manager got the T2H notification
    const notifs = await prisma.notification.count({ where: { queryId, type: "query.escalation" } });
    expect(notifs).toBeGreaterThanOrEqual(1);

    // >= 1 escalation email logged (to the tier-role staff)
    const emails = await prisma.messageLog.count({ where: { entityId: queryId, eventKey: "query.escalation" } });
    expect(emails).toBeGreaterThanOrEqual(1);
  });

  it("runDue is idempotent (no re-fire)", async () => {
    const before = await prisma.messageLog.count({ where: { entityId: queryId, eventKey: "query.escalation" } });
    await scheduled.runDue(new Date("2026-01-01T07:00:00Z"));
    expect(await prisma.messageLog.count({ where: { entityId: queryId, eventKey: "query.escalation" } })).toBe(before);
  });

  it("cancelForQuery stops unfired timers", async () => {
    await esc.createForQuery(q2, new Date()); // fresh query, dueAt in the future
    await esc.cancelForQuery(q2);
    await scheduled.runDue(new Date(Date.now() + 7 * 3600_000));
    expect(
      await prisma.scheduledEvent.count({
        where: { entityType: "QUERY", entityId: q2, eventKey: "query.escalation", firedAt: { not: null } },
      }),
    ).toBe(0);
  });

  it("inactive users are NOT notified by the escalation fan-out", async () => {
    // Seed an inactive Manager alongside the existing active Manager
    const inactiveUser = await prisma.user.create({
      data: {
        name: "InactiveMgr",
        email: `${PFX}inactive-mgr@x.com`,
        passwordHash: "x",
        role: "MANAGER",
        isActive: false,
      },
    });

    // Create a fresh query to isolate this test
    const q3row = await prisma.query.create({
      data: { queryCode: `${PFX}inactive-${Date.now()}`, shipmentDescription: `${PFX}inactive` },
    });
    const q3 = q3row.id;

    await esc.createForQuery(q3, new Date("2026-02-01T00:00:00Z"));
    // Run past T2H due time so the T2H tier fires (notifies MANAGER role)
    await scheduled.runDue(new Date("2026-02-01T03:00:00Z"));

    // Inactive user must have received NO notifications for this query
    expect(
      await prisma.notification.count({ where: { recipientUserId: inactiveUser.id, queryId: q3 } }),
    ).toBe(0);

    // The active Manager must have received at least one notification for this query
    const activeMgr = await prisma.user.findFirst({
      where: { email: `${PFX}mgr@x.com` },
      select: { id: true },
    });
    expect(activeMgr).not.toBeNull();
    expect(
      await prisma.notification.count({ where: { recipientUserId: activeMgr!.id, queryId: q3 } }),
    ).toBeGreaterThanOrEqual(1);

    // Cleanup extra data created by this test
    await prisma.scheduledEvent.deleteMany({ where: { entityType: "QUERY", entityId: q3 } });
    await prisma.messageLog.deleteMany({ where: { entityType: "QUERY", entityId: q3 } });
    await prisma.query.delete({ where: { id: q3 } });
    await prisma.user.delete({ where: { id: inactiveUser.id } });
  });
});
