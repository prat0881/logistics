process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { ScheduledEventService } from "../src/modules/comms/scheduled-event.service";
import { RfqScheduleListener } from "../src/modules/rfq/rfq-schedule.listener";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";
import { ffFixture } from "./helpers/freight-forwarder";

// Task 10 — reminder/expiry listeners: `rfq.expiry` fires from the minute-cron for each
// still-RFQ_SENT quote on the RFQ → discard draftJson, fire QuoteEvent.EXPIRE, dispatch
// EMAIL (FF) + IN_APP (assigned Executive), then cancel the RFQ's remaining reminders.
const PREFIX = "RFQ-EXP";
const CODE = `YAL00-${PREFIX}`;

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let scheduled: ScheduledEventService;
  let listener: RfqScheduleListener;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  const mkFf = (
    code: string,
    countries: string[] = ["AE"],
    modes: ("AIR" | "SEA" | "ROAD")[] = ["AIR"],
  ) =>
    prisma.freightForwarder.create({
      data: ffFixture({
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `${code}@e2e.test`,
        availableCountries: countries,
        modes,
        status: "ACTIVE",
      }),
    });

  // Self-clean fixtures + the non-cascaded comms rows (ScheduledEvent/MessageLog reference
  // entityId as a plain string, not a Prisma relation, so they survive a Query/Rfq delete).
  // Notification.queryId IS a real relation (onDelete: Cascade), so those cascade for free.
  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    const queryIds = qs.map((q) => q.id);
    const rfqs = queryIds.length
      ? await prisma.rfq.findMany({ where: { queryId: { in: queryIds } }, select: { id: true } })
      : [];
    const rfqIds = rfqs.map((r) => r.id);

    if (rfqIds.length) {
      await prisma.scheduledEvent.deleteMany({
        where: { entityType: "RFQ", entityId: { in: rfqIds } },
      });
    }
    if (queryIds.length) {
      await prisma.messageLog.deleteMany({
        where: { entityType: "QUERY", entityId: { in: queryIds } },
      });
    }
    for (const q of qs) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items/notifications
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: `${PREFIX}-` } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    scheduled = moduleRef.get(ScheduledEventService);
    listener = moduleRef.get(RfqScheduleListener);
    await cleanup();
    // create-only upserts: guarantees the rfq.* message templates + reminder/deadline
    // AppSettings exist regardless of test order/DB state.
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  const mkLeg = async (queryId: string, legCode: string, _poRef: string) => {
    const origin = await prisma.point.create({ data: { queryId, type: "PICKUP", country: "CN" } });
    const dest = await prisma.point.create({ data: { queryId, type: "DELIVERY", country: "AE" } });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId,
      packages: [{ dimL: 10, dimW: 10, dimH: 10, grossWt: 1 }],
    });
    const leg = await prisma.leg.create({
      data: {
        queryId,
        legCode,
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);
    return leg;
  };

  it("expiry: quote → EXPIRED, draft discarded, FF email + Exec notification, reminders cancelled", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    const exec = await prisma.user.create({
      data: {
        name: "Exec",
        email: `${PREFIX}-exec@e2e.test`,
        passwordHash: "x",
        role: "EXECUTIVE",
      },
    });

    const query = await prisma.query.create({
      data: { queryCode: CODE, incoterms: "FOB", assignedUserId: exec.id },
    });
    const leg = await mkLeg(query.id, "L-EXP-1", "PO-EXP-1");
    const ff = await mkFf(`FF-${PREFIX}-A`, ["CN", "AE"], ["AIR"]);

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    const rfq = await prisma.rfq.findFirst({
      where: { queryId: query.id, freightForwarderId: ff.id },
    });
    expect(rfq).not.toBeNull();
    const rfqId = rfq!.id;

    const quote = await prisma.quote.findFirst({
      where: { legId: leg.id, freightForwarderId: ff.id },
    });
    expect(quote?.status).toBe("RFQ_SENT");
    const quoteId = quote!.id;

    // simulate the FF having started (but not submitted) a draft
    await prisma.quote.update({
      where: { id: quoteId },
      data: { draftJson: { note: "in-progress draft" } },
    });

    // sanity: distribute already seeded live future-tier reminders anchored to this RFQ —
    // proves the later "0 live reminders" assertion is really exercising the cancel(), not vacuous
    const remindersBefore = await prisma.scheduledEvent.count({
      where: {
        entityType: "RFQ",
        entityId: rfqId,
        eventKey: "rfq.reminder",
        firedAt: null,
        cancelledAt: null,
      },
    });
    expect(remindersBefore).toBeGreaterThan(0);

    // force the DEADLINE expiry timer due now (ScheduledEventService.schedule()'s upsert
    // no-ops the update on conflict, so drive dueAt directly instead of rescheduling).
    await prisma.scheduledEvent.update({
      where: {
        entityType_entityId_eventKey_tier: {
          entityType: "RFQ",
          entityId: rfqId,
          eventKey: "rfq.expiry",
          tier: "DEADLINE",
        },
      },
      data: { dueAt: new Date() },
    });

    await scheduled.runDue();

    const quoteAfter = await prisma.quote.findUnique({ where: { id: quoteId } });
    expect(quoteAfter?.status).toBe("EXPIRED");
    expect(quoteAfter?.draftJson).toBeNull();

    const ffMail = await prisma.messageLog.count({
      where: { entityId: query.id, eventKey: "rfq.expiry", channel: "EMAIL" },
    });
    expect(ffMail).toBeGreaterThanOrEqual(1);

    const execNotif = await prisma.notification.count({
      where: { recipientUserId: exec.id, type: "rfq.expiry" },
    });
    expect(execNotif).toBeGreaterThanOrEqual(1);

    const liveReminders = await prisma.scheduledEvent.count({
      where: {
        entityType: "RFQ",
        entityId: rfqId,
        eventKey: "rfq.reminder",
        firedAt: null,
        cancelledAt: null,
      },
    });
    expect(liveReminders).toBe(0);
  });
  // ── S5.9.5 final whole-branch review, IMPORTANT 4 ───────────────────────────────────────────
  it("reminder: a forwarder still holding an open leg is nudged; once EVERY leg is approved to a rival, they are not", async () => {
    // `onReminder` dispatched unconditionally — no leg-closure check at all — while D5 (Task 7)
    // had already closed an APPROVED leg to the forwarders who did not win it: their portal
    // renders read-only and `saveDraft`/`submit` 409 them. So a shut-out forwarder kept getting
    // "please submit your quote before the deadline" for a portal that refuses the submission.
    // D5's own rationale reasons about per-RFQ timers on the premise that the forwarder still
    // holds an OPEN leg — the code had no such condition.
    //
    // `Rfq` is @@unique([queryId, freightForwarderId]), so ONE RFQ covers every leg this forwarder
    // holds on this query. The rule is therefore per LEG: silence only when they are shut out of
    // ALL of them. The two halves below differ by exactly one `LegAwardDecision` row.
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-REM`, incoterms: "FOB" },
    });
    const legOne = await mkLeg(query.id, "L-REM-1", "PO-REM-1");
    const legTwo = await mkLeg(query.id, "L-REM-2", "PO-REM-2");

    const loser = await mkFf(`FF-${PREFIX}-REM-LOSER`, ["CN", "AE"], ["AIR"]);
    const winner = await mkFf(`FF-${PREFIX}-REM-WINNER`, ["CN", "AE"], ["AIR"]);

    const mkRfq = async (ffId: string, n: number) =>
      prisma.rfq.create({
        data: {
          queryId: query.id,
          freightForwarderId: ffId,
          rfqNumber: `${CODE}-REM-RFQ00${n}`,
          accessTokenHash: `hash-${PREFIX}-rem-${n}`,
          submissionDeadline: new Date(Date.now() + 3600_000),
          currency: "USD",
        },
      });
    const loserRfq = await mkRfq(loser.id, 1);
    const winnerRfq = await mkRfq(winner.id, 2);

    const mkQuote = (rfqId: string, ffId: string, legId: string) =>
      prisma.quote.create({
        data: { queryId: query.id, legId, freightForwarderId: ffId, rfqId, status: "RFQ_SENT" },
      });
    await mkQuote(loserRfq.id, loser.id, legOne.id);
    await mkQuote(loserRfq.id, loser.id, legTwo.id);
    const winnerOne = await mkQuote(winnerRfq.id, winner.id, legOne.id);
    const winnerTwo = await mkQuote(winnerRfq.id, winner.id, legTwo.id);

    const approve = (legId: string, quoteId: string) =>
      prisma.legAwardDecision.create({
        data: {
          legId,
          queryId: query.id,
          shortlistedQuoteId: quoteId,
          shortlistedVariant: null,
          status: "APPROVED",
          sentByUserId: null,
          sentForApprovalAt: new Date(),
          decidedAt: new Date(),
        },
      });
    const remindersTo = (email: string) =>
      prisma.messageLog.count({
        where: {
          entityType: "QUERY",
          entityId: query.id,
          eventKey: "rfq.reminder",
          toAddress: email,
        },
      });

    // ── POSITIVE CONTROL: LEG-1 is decided against the loser, LEG-2 is still open to them ──
    await approve(legOne.id, winnerOne.id);
    await listener.onReminder({ entityType: "RFQ", entityId: loserRfq.id, tier: "T1" });
    expect(await remindersTo(loser.email)).toBe(1); // they still have real work to do on LEG-2

    // ── the fix: LEG-2 goes the same way, so nothing on this RFQ is open to them any more ──
    await approve(legTwo.id, winnerTwo.id);
    await listener.onReminder({ entityType: "RFQ", entityId: loserRfq.id, tier: "T2" });
    expect(await remindersTo(loser.email)).toBe(1); // still just the one from the control above

    // ...and the WINNER, whose own quotes are the approved ones, is not silenced by their own
    // approval — `closedLegReasons` deliberately never reports a leg closed to its own winner.
    await listener.onReminder({ entityType: "RFQ", entityId: winnerRfq.id, tier: "T2" });
    expect(await remindersTo(winner.email)).toBe(1);
  });
});
