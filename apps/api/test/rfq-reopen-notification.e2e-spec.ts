process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { createHash, randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";
import { RfqNotificationsService } from "../src/modules/rfq/rfq-notifications.service";
import { ffFixture } from "./helpers/freight-forwarder";

// Task 9 (SB6): the change-order cascade's saga (Task 8, not yet built) reopens leg(s) and
// invalidates the FF(s) who had already quoted them, then calls
// RfqNotificationsService.legReopened(queryId, reason, perFf) — a thin wrapper over the SB5
// NotificationDispatcher (SB6 fires; SB5 composes/logs). This spec exercises the notifier
// directly (no HTTP layer — there's no controller here), mirroring the direct service-call
// style of comms-schema.e2e-spec.ts.
//
// legReopened loops dispatch() ONCE PER FF group (review fix): NotificationDispatcher renders
// subject/body once per call and sends the identical rendered content to every EMAIL
// recipient in that call, so a single batched dispatch() across multiple FFs would leak
// FF-A's rfqNumber/legs into FF-B's email (Rfq is unique per (queryId, freightForwarderId),
// so distinct FFs genuinely have distinct rfqNumbers). The multi-FF test below is the
// regression proof for that leak.
const PREFIX = "rfq-reopen-notif-";
const CODE_SINGLE = `${PREFIX}single`;
const CODE_MULTI = `${PREFIX}multi`;
const FF_SINGLE = `FF-${PREFIX}A`;
const FF_MULTI_A = `FF-${PREFIX}MA`;
const FF_MULTI_B = `FF-${PREFIX}MB`;

describe("RfqNotificationsService.legReopened (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifier: RfqNotificationsService;
  const execIdSingle = randomUUID(); // soft reference (no FK) — same convention as Query.assignedUserId
  const execIdMulti = randomUUID();

  // Self-contained cleanup — mirrors change-order-preview.e2e-spec.ts's ordering (rfqs before
  // the FF they reference — Rfq.freightForwarder is onDelete:Restrict; Query cascades
  // points/legs/cargo on delete). MessageLog/Notification reference entityId/recipientUserId
  // as plain strings (no FK), so they survive a Query/Rfq cascade-delete and need an explicit
  // sweep (same reasoning as rfq-distribute-comms.e2e-spec.ts).
  const cleanupQuery = async (queryCode: string, execId: string, ffCodes: string[]) => {
    const query = await prisma.query.findUnique({ where: { queryCode }, select: { id: true } });
    if (query) {
      await prisma.notification.deleteMany({ where: { recipientUserId: execId } });
      await prisma.messageLog.deleteMany({ where: { entityType: "QUERY", entityId: query.id } });
      await prisma.rfq.deleteMany({ where: { queryId: query.id } });
    }
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { in: ffCodes } } });
    if (query) {
      await prisma.query.delete({ where: { id: query.id } }); // cascades points/legs/cargo
    }
  };

  const cleanup = async () => {
    await cleanupQuery(CODE_SINGLE, execIdSingle, [FF_SINGLE]);
    await cleanupQuery(CODE_MULTI, execIdMulti, [FF_MULTI_A, FF_MULTI_B]);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    notifier = moduleRef.get(RfqNotificationsService);
    await cleanup();
    // create-only upserts: guarantees the rfq.leg.reopened templates exist regardless of
    // test order/DB state (CI has no seed step of its own).
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  const mkPoint = (queryId: string, type: "PICKUP" | "DELIVERY", name: string, city: string, country: string) =>
    prisma.point.create({ data: { queryId, type, name, city, country } });

  const mkFf = (code: string) =>
    prisma.freightForwarder.create({
      data: ffFixture({
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+10000000000",
        email: `${code}@e2e.test`,
        availableCountries: ["AE"],
        modes: ["AIR"],
      }),
    });

  const mkRfq = (queryId: string, freightForwarderId: string, rfqNumber: string) =>
    prisma.rfq.create({
      data: {
        queryId,
        freightForwarderId,
        rfqNumber,
        accessTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        submissionDeadline: new Date(Date.now() + 86400000),
      },
    });

  it("dispatches EMAIL to a single invalidated FF's contact and IN_APP to the query's Executive", async () => {
    // --- fixtures (self-contained) ---
    const query = await prisma.query.create({ data: { queryCode: CODE_SINGLE, assignedUserId: execIdSingle } });
    const origin = await mkPoint(query.id, "PICKUP", "Shenzhen Port", "Shenzhen", "CN");
    const dest = await mkPoint(query.id, "DELIVERY", "Jebel Ali", "Dubai", "AE");
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L1",
        mode: "AIR",
        status: "READY_FOR_RFQ", // post-REOPEN, as the saga would leave it before notifying
        originPointId: origin.id,
        destinationPointId: dest.id,
      },
    });
    const ff = await mkFf(FF_SINGLE);
    const rfq = await mkRfq(query.id, ff.id, "YAL26-0001-RFQ001");

    // --- act ---
    await notifier.legReopened(query.id, "Cargo weight changed", [
      { freightForwarderId: ff.id, legIds: [leg.id] },
    ]);

    // --- assert: EMAIL → the invalidated FF's primary contact ---
    const log = await prisma.messageLog.findFirst({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "rfq.leg.reopened" },
    });
    expect(log).not.toBeNull();
    expect(log?.toAddress).toBe(ff.email);
    expect(log?.channel).toBe("EMAIL");
    expect(log?.subject).toContain(rfq.rfqNumber);
    expect(log?.bodyRendered).toContain("L1");
    expect(log?.bodyRendered).toContain("Shenzhen Port");
    expect(log?.bodyRendered).toContain("Jebel Ali");
    expect(log?.bodyRendered).toContain("Cargo weight changed");

    // --- assert: IN_APP → the query's Executive (assignedUserId) ---
    const notification = await prisma.notification.findFirst({
      where: { recipientUserId: execIdSingle, type: "rfq.leg.reopened" },
    });
    expect(notification).not.toBeNull();
    expect(notification?.queryId).toBe(query.id);
    expect(notification?.entityType).toBe("QUERY");
    expect(notification?.entityId).toBe(query.id);
    expect(notification?.message).toContain("L1");
    expect(notification?.message).toContain(rfq.rfqNumber);
    expect(notification?.message).toContain("Cargo weight changed");
  });

  it("keeps each FF's content isolated in the multi-FF case — no cross-FF rfqNumber/leg leak", async () => {
    // --- fixtures: 2 legs, 2 FFs, 2 distinct Rfqs (Rfq is unique per queryId+FF) ---
    const query = await prisma.query.create({ data: { queryCode: CODE_MULTI, assignedUserId: execIdMulti } });

    const originA = await mkPoint(query.id, "PICKUP", "Shenzhen Port", "Shenzhen", "CN");
    const destA = await mkPoint(query.id, "DELIVERY", "Jebel Ali", "Dubai", "AE");
    // legCodes deliberately NOT "L1"/"L2" — those are substrings of the "YAL26-000x-RFQ00x"
    // rfqNumber format ("...yAL2..."), which would make a not.toContain() false-fail.
    const legA = await prisma.leg.create({
      data: {
        queryId: query.id, legCode: "LEGALPHA", mode: "AIR", status: "READY_FOR_RFQ",
        originPointId: originA.id, destinationPointId: destA.id,
      },
    });

    const originB = await mkPoint(query.id, "PICKUP", "Ningbo Port", "Ningbo", "CN");
    const destB = await mkPoint(query.id, "DELIVERY", "Abu Dhabi Port", "Abu Dhabi", "AE");
    const legB = await prisma.leg.create({
      data: {
        queryId: query.id, legCode: "LEGBRAVO", mode: "SEA", status: "READY_FOR_RFQ",
        originPointId: originB.id, destinationPointId: destB.id,
      },
    });

    const ffA = await mkFf(FF_MULTI_A);
    const ffB = await mkFf(FF_MULTI_B);
    const rfqA = await mkRfq(query.id, ffA.id, "YAL26-0002-RFQ001");
    const rfqB = await mkRfq(query.id, ffB.id, "YAL26-0002-RFQ002");

    // --- act: one query-wide change-order reopens both legs, invalidating both FFs at once ---
    await notifier.legReopened(query.id, "Incoterms changed", [
      { freightForwarderId: ffA.id, legIds: [legA.id] },
      { freightForwarderId: ffB.id, legIds: [legB.id] },
    ]);

    // --- assert: 2 distinct MessageLog rows, one per FF ---
    const logs = await prisma.messageLog.findMany({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "rfq.leg.reopened" },
    });
    expect(logs).toHaveLength(2);
    const logA = logs.find((l) => l.toAddress === ffA.email);
    const logB = logs.find((l) => l.toAddress === ffB.email);
    expect(logA).toBeDefined();
    expect(logB).toBeDefined();

    // FF-A's email carries ONLY FF-A's rfqNumber/leg/origin/destination
    expect(logA?.subject).toContain(rfqA.rfqNumber);
    expect(logA?.subject).not.toContain(rfqB.rfqNumber);
    expect(logA?.bodyRendered).toContain("LEGALPHA");
    expect(logA?.bodyRendered).not.toContain("LEGBRAVO");
    expect(logA?.bodyRendered).toContain("Shenzhen Port");
    expect(logA?.bodyRendered).not.toContain("Ningbo Port");
    expect(logA?.bodyRendered).not.toContain("Abu Dhabi Port");

    // FF-B's email carries ONLY FF-B's rfqNumber/leg/origin/destination
    expect(logB?.subject).toContain(rfqB.rfqNumber);
    expect(logB?.subject).not.toContain(rfqA.rfqNumber);
    expect(logB?.bodyRendered).toContain("LEGBRAVO");
    expect(logB?.bodyRendered).not.toContain("LEGALPHA");
    expect(logB?.bodyRendered).toContain("Ningbo Port");
    expect(logB?.bodyRendered).not.toContain("Shenzhen Port");

    // --- assert: the Executive gets one IN_APP notification per affected FF, each isolated ---
    const notifications = await prisma.notification.findMany({
      where: { recipientUserId: execIdMulti, type: "rfq.leg.reopened" },
    });
    expect(notifications).toHaveLength(2);
    const notifA = notifications.find((n) => n.message.includes(rfqA.rfqNumber));
    const notifB = notifications.find((n) => n.message.includes(rfqB.rfqNumber));
    expect(notifA).toBeDefined();
    expect(notifA?.message).not.toContain(rfqB.rfqNumber);
    expect(notifA?.message).not.toContain("LEGBRAVO");
    expect(notifB).toBeDefined();
    expect(notifB?.message).not.toContain(rfqA.rfqNumber);
    expect(notifB?.message).not.toContain("LEGALPHA");
  });
});
