process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import { Role, ACCESS_TOKEN_COOKIE, type QuoteDraft } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";

// S5.4 Task 2 — the MAKER half of the maker-checker award workflow (design §9 steps 1+3):
// PUT .../legs/:legId/shortlist and POST .../legs/:legId/send-for-approval, both Executive+
// (no @Roles). The checker half (approve/reject, Manager+ + four-eyes) is Task 3.
const PREFIX = "AWMK";
const CODE = `YAL00-${PREFIX}`;

type FfSpec = {
  key: string;
  status: "QUOTED" | "RFQ_SENT" | "REQUOTED";
  deadline: Date;
  draft?: { amount: number; transitDays: number }; // omit for a never-submitted (RFQ_SENT) FF
};

describe("award workflow — maker endpoints (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  // Any authenticated (Executive+) role works — both routes carry no @Roles. Each call takes
  // its own userId so tests can assert exactly who `sentByUserId`/`actorId` ends up as.
  const cookieFor = (userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role: Role.EXECUTIVE, tenantId: null })}`;

  const mkFf = (code: string) =>
    prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `${code.toLowerCase()}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        handleDg: false,
        status: "ACTIVE",
      },
    });

  const mkRfq = (queryId: string, ffId: string, key: string, deadline: Date) =>
    prisma.rfq.create({
      data: {
        queryId,
        freightForwarderId: ffId,
        rfqNumber: `${CODE}-RFQ-${key}`,
        accessTokenHash: `hash-${PREFIX}-${key}`,
        submissionDeadline: deadline,
        incoterms: "FOB",
        currency: "INR",
        quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
      },
    });

  // Same minimal ROAD-draft shape as comparison.e2e-spec.ts's roadDraft — priced only on the
  // DEDICATED variant, so computeQuoteTotals produces exactly one comparable offer.
  const roadDraft = (
    legId: string,
    originPointId: string,
    amount: number,
    transitDays: number,
  ): QuoteDraft => ({
    legId,
    mode: "ROAD",
    currency: "INR",
    quoteValidityUntil: "2099-01-01T00:00:00.000Z",
    chargedWeightKg: 500,
    notes: null,
    cargo: [],
    charges: [],
    trucking: [
      {
        legEndpointPointId: originPointId,
        truckingType: "DEDICATED",
        basis: "FIXED",
        amount,
        rateVariant: "DEDICATED",
        tonnage: null,
      },
    ],
    seaRates: [],
    warehouse: [],
    transit: {
      departureDate: null,
      arrivalDate: null,
      guaranteedTransitDaysByVariant: { DEDICATED: transitDays },
    },
    dgSurchargeNote: null,
    termsConditions: null,
  });

  // One Query + one Leg (seeded directly at `legStatus`, mirroring award-machine.e2e-spec.ts's
  // "fresh per case, seeded at the target state" convention) + one FF/Rfq/Quote per `ffs`
  // entry. A fresh leg per call is required anyway — LegAwardDecision.legId is @unique.
  async function seedLeg(label: string, legStatus: string, ffs: FfSpec[]) {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-${label}`, priority: "HIGH", incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", city: "Shanghai", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", city: "Dubai", country: "AE" },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L1",
        mode: "ROAD",
        originPointId: origin.id,
        destinationPointId: dest.id,
        status: legStatus as never,
      },
    });

    const quotes: Record<string, { id: string; ffId: string }> = {};
    for (const ff of ffs) {
      const ffRow = await mkFf(`FF-${PREFIX}-${label}-${ff.key}`);
      const rfq = await mkRfq(query.id, ffRow.id, `${label}-${ff.key}`, ff.deadline);
      const quote = await prisma.quote.create({
        data: {
          queryId: query.id,
          legId: leg.id,
          freightForwarderId: ffRow.id,
          rfqId: rfq.id,
          status: ff.status,
          ...(ff.draft
            ? {
                submittedAt: new Date(),
                draftJson: roadDraft(
                  leg.id,
                  origin.id,
                  ff.draft.amount,
                  ff.draft.transitDays,
                ) as unknown as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
      quotes[ff.key] = { id: quote.id, ffId: ffRow.id };
    }

    return { query, leg, origin, dest, quotes };
  }

  const future = () => new Date(Date.now() + 86400000);
  const past = () => new Date(Date.now() - 3600000);

  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    const qIds = qs.map((q) => q.id);
    const legs = await prisma.leg.findMany({ where: { queryId: { in: qIds } }, select: { id: true } });
    const legIds = legs.map((l) => l.id);
    await prisma.awardDecisionEvent.deleteMany({ where: { legId: { in: legIds } } });
    await prisma.legAwardDecision.deleteMany({ where: { legId: { in: legIds } } });
    await prisma.quote.deleteMany({ where: { queryId: { in: qIds } } });
    await prisma.rfq.deleteMany({ where: { queryId: { in: qIds } } });
    for (const id of qIds) {
      await prisma.query.delete({ where: { id } }); // cascades points/legs
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } },
    });
    await prisma.fxRate.deleteMany({ where: { note: { startsWith: PREFIX } } });
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
    await seedReferenceData(prisma);
    await cleanup();
    await prisma.fxRate.create({ data: { currency: "INR", unitsPerUsd: 83.2, note: PREFIX } });
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("shortlists the recommended offer -> 200 + a DRAFT LegAwardDecision with the recommendation snapshotted", async () => {
    const { query, leg, quotes } = await seedLeg("happy", "FULLY_QUOTED", [
      // HIGH priority ranks by transit first: REC (3d) beats OTH (5d) outright — no tie-break.
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "OTH", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);
    const actorId = randomUUID();

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/shortlist`)
      .set("Cookie", cookieFor(actorId))
      .send({ quoteId: quotes.REC.id, variant: "DEDICATED" })
      .expect(200);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision).toBeTruthy();
    expect(decision?.status).toBe("DRAFT");
    expect(decision?.shortlistedQuoteId).toBe(quotes.REC.id);
    expect(decision?.shortlistedVariant).toBe("DEDICATED");
    expect(decision?.recommendedQuoteId).toBe(quotes.REC.id);
    expect(decision?.recommendedVariant).toBe("DEDICATED");
    expect(decision?.overrideReason).toBeNull();

    const events = await prisma.awardDecisionEvent.findMany({
      where: { legId: leg.id, type: "SHORTLIST" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].quoteId).toBe(quotes.REC.id);
    expect(events[0].variant).toBe("DEDICATED");
    expect(events[0].actorId).toBe(actorId);
  });

  it("A1 — shortlisting a quoteId that is not an offer on this leg -> 400", async () => {
    const { query, leg } = await seedLeg("a1", "FULLY_QUOTED", [
      { key: "ONLY", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
    ]);

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/shortlist`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: randomUUID(), variant: "DEDICATED" })
      .expect(400);

    expect(await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } })).toBeNull();
  });

  it("A2 — send-for-approval of a shortlist that overrides the recommendation with no overrideReason -> 400", async () => {
    const { query, leg, quotes } = await seedLeg("a2", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "OTH", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/shortlist`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.OTH.id, variant: "DEDICATED" }) // NOT the recommendation; no overrideReason
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({})
      .expect(400);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("DRAFT"); // never advanced
  });

  it("shortlist with an overrideReason then send-for-approval -> 200 + PENDING_APPROVAL + sentByUserId", async () => {
    const { query, leg, quotes } = await seedLeg("override", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "OTH", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/shortlist`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({
        quoteId: quotes.OTH.id,
        variant: "DEDICATED",
        overrideReason: "Client asked for this forwarder by name",
      })
      .expect(200);

    const senderId = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId))
      .send({})
      .expect(200);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL");
    expect(decision?.sentByUserId).toBe(senderId);
    expect(decision?.sentForApprovalAt).toBeTruthy();

    const events = await prisma.awardDecisionEvent.findMany({
      where: { legId: leg.id, type: "SEND_FOR_APPROVAL" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("Client asked for this forwarder by name");
    expect(events[0].actorId).toBe(senderId);
  });

  it("A3 — send-for-approval on a PARTIALLY_QUOTED leg whose RFQ deadline has not passed -> 400", async () => {
    const { query, leg, quotes } = await seedLeg("a3", "PARTIALLY_QUOTED", [
      { key: "QUOTED", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "PENDING", status: "RFQ_SENT", deadline: future() }, // never responded, window still open
    ]);

    // Shortlist the only comparable (and thus recommended) offer, so A2 can't interfere.
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/shortlist`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.QUOTED.id, variant: "DEDICATED" })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({})
      .expect(400);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("DRAFT");
  });

  it("A3 (converse) — a PARTIALLY_QUOTED leg whose only outstanding RFQ deadline HAS passed may send", async () => {
    const { query, leg, quotes } = await seedLeg("a3pass", "PARTIALLY_QUOTED", [
      { key: "QUOTED", status: "QUOTED", deadline: past(), draft: { amount: 83200, transitDays: 3 } },
      { key: "PENDING", status: "RFQ_SENT", deadline: past() }, // never responded, but window is over
    ]);

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/shortlist`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.QUOTED.id, variant: "DEDICATED" })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({})
      .expect(200);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL");
  });

  it("A9 — an in-flight re-quote on the leg blocks send-for-approval unless proceedWithoutWaiting + proceedReason", async () => {
    const { query, leg, quotes } = await seedLeg("a9", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "REQUOTED", deadline: future(), draft: { amount: 90000, transitDays: 4 } },
    ]);

    // REC is the only QUOTED (rankable) offer, so it's also the recommendation — no A2 override needed.
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/shortlist`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.REC.id, variant: "DEDICATED" })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({})
      .expect(400);

    let decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("DRAFT");

    const senderId = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId))
      .send({ proceedWithoutWaiting: true, proceedReason: "Client needs the number today" })
      .expect(200);

    decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL");

    const events = await prisma.awardDecisionEvent.findMany({
      where: { legId: leg.id, type: "SEND_FOR_APPROVAL" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("Client needs the number today");
    expect(events[0].actorId).toBe(senderId);
  });

  it("404s send-for-approval when no shortlist exists yet for the leg", async () => {
    const { query, leg } = await seedLeg("noshortlist", "FULLY_QUOTED", [
      { key: "ONLY", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({})
      .expect(400);
  });
});
