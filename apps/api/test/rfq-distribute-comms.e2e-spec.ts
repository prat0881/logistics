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
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";
import { ffFixture } from "./helpers/freight-forwarder";

// Task 9 — distribute wiring: seeds ScheduledEvent reminder/expiry timers (anchored to the
// RFQ) and dispatches rfq.invitation (fresh mint) / rfq.updated (amend) via the dispatcher.
const PREFIX = "RFQ-DCM";
const CODE = `YAL00-${PREFIX}`;

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
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
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } },
    });
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

  it("distribute seeds reminder+expiry timers and logs an invitation email", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const leg = await mkLeg(query.id, "L-DCM-1", "PO-DCM-1");
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

    const reminders = await prisma.scheduledEvent.findMany({
      where: { entityType: "RFQ", entityId: rfq!.id, eventKey: "rfq.reminder" },
    });
    expect(reminders.length).toBeGreaterThanOrEqual(1); // future tiers only

    const expiry = await prisma.scheduledEvent.findFirst({
      where: { entityType: "RFQ", entityId: rfq!.id, eventKey: "rfq.expiry", tier: "DEADLINE" },
    });
    expect(expiry).not.toBeNull();
    expect(expiry!.dueAt.getTime()).toBe(rfq!.submissionDeadline.getTime());

    const invite = await prisma.messageLog.findFirst({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "rfq.invitation" },
    });
    expect(invite?.toAddress).toBe(ff.email);
    expect(invite?.subject).toContain(rfq!.rfqNumber);
    expect(invite?.bodyRendered).toContain("/ff/rfq/"); // Access_Link token rendered
  });

  it("amend: reuses the same Rfq (no duplicate reminders) and logs an updated email, not a 2nd invitation", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-AMD`, incoterms: "FOB" },
    });
    const ff = await mkFf(`FF-${PREFIX}-AMD`, ["CN", "AE"], ["AIR"]);
    const legA = await mkLeg(query.id, "L-AMD-A", "PO-AMD-A");
    const legB = await mkLeg(query.id, "L-AMD-B", "PO-AMD-B");

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${legA.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legA.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    const rfq = await prisma.rfq.findFirst({
      where: { queryId: query.id, freightForwarderId: ff.id },
    });
    const remindersAfterMint = await prisma.scheduledEvent.count({
      where: { entityType: "RFQ", entityId: rfq!.id, eventKey: "rfq.reminder" },
    });
    expect(remindersAfterMint).toBeGreaterThanOrEqual(1);

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${legB.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legB.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    // same Rfq (amend) — schedule() upserts, so re-scheduling the same tiers is a no-op
    const remindersAfterAmend = await prisma.scheduledEvent.count({
      where: { entityType: "RFQ", entityId: rfq!.id, eventKey: "rfq.reminder" },
    });
    expect(remindersAfterAmend).toBe(remindersAfterMint);

    const updated = await prisma.messageLog.findFirst({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "rfq.updated" },
    });
    expect(updated?.toAddress).toBe(ff.email);
    // this distribute call only touched legB — Leg_Names reflects the legs sent THIS call
    expect(updated?.bodyRendered).toContain("L-AMD-B");

    // still exactly ONE invitation (from the mint call) — the amend dispatches rfq.updated, not a 2nd invitation
    const invitations = await prisma.messageLog.count({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "rfq.invitation" },
    });
    expect(invitations).toBe(1);
  });
});
