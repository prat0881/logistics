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

// S5.4 Task 3 — the CHECKER half of the maker-checker award workflow (design §9 steps 2+4):
// POST .../legs/:legId/approve and POST .../legs/:legId/reject, both Manager+
// (@Roles(ADMINISTRATOR, MANAGER)) plus a four-eyes rule (the sender may not decide their own
// send). Setup is driven through the REAL maker endpoints (shortlist + send-for-approval) so a
// PENDING_APPROVAL decision is reached honestly, exactly like a live workflow would produce it.
const PREFIX = "AWCK";
const CODE = `YAL00-${PREFIX}`;

type FfSpec = {
  key: string;
  status: "QUOTED" | "RFQ_SENT" | "REQUOTED";
  deadline: Date;
  draft?: { amount: number; transitDays: number }; // omit for a never-submitted (RFQ_SENT) FF
};

describe("award workflow — checker endpoints (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  // Parametrized by role (unlike the maker spec, which only ever needs EXECUTIVE) so the
  // checker tests can mint MANAGER cookies for the four-eyes scenarios and EXECUTIVE cookies
  // to prove the RolesGuard blocks them at the route. `sub` MUST be a real UUID — the actor
  // columns are `@db.Uuid`, and a literal like "u-manager" 500s (Prisma P2023) rather than 403s.
  const cookieFor = (userId: string, role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role, tenantId: null })}`;

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

  // Same minimal ROAD-draft shape as the maker spec's roadDraft — priced only on the DEDICATED
  // variant, so computeQuoteTotals produces exactly one comparable offer.
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

  // One Query + one Leg (seeded directly at `legStatus`) + one FF/Rfq/Quote per `ffs` entry.
  // A fresh leg per call is required anyway — LegAwardDecision.legId is @unique.
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

  // Drives the REAL maker endpoints (shortlist -> send-for-approval) to reach PENDING_APPROVAL
  // honestly. Shortlists the recommended (only comparable) offer so A2's override-reason
  // requirement never fires. Sender is a MANAGER (Manager ⊇ Executive's auth-only routes) so
  // `sentByUserId` can double as the four-eyes actor under test.
  async function seedPendingApproval(
    label: string,
    senderId: string,
    ffs: FfSpec[] = [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
    ],
  ) {
    const { query, leg, quotes } = await seedLeg(label, "FULLY_QUOTED", ffs);

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/shortlist`)
      .set("Cookie", cookieFor(senderId, Role.MANAGER))
      .send({ quoteId: quotes.REC.id, variant: "DEDICATED" })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId, Role.MANAGER))
      .send({})
      .expect(200);

    return { query, leg, quotes };
  }

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

  it("a different Manager approves -> 200 + quote APPROVED + leg APPROVED + decision APPROVED + an APPROVE event", async () => {
    const senderId = randomUUID(); // M1
    const approverId = randomUUID(); // M2 — distinct from the sender
    const { query, leg, quotes } = await seedPendingApproval("happy", senderId);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(approverId, Role.MANAGER))
      .send()
      .expect(200);

    const quote = await prisma.quote.findUnique({ where: { id: quotes.REC.id } });
    expect(quote?.status).toBe("APPROVED");

    const updatedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(updatedLeg?.status).toBe("APPROVED");

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("APPROVED");
    expect(decision?.decidedByUserId).toBe(approverId);
    expect(decision?.decidedAt).toBeTruthy();

    const events = await prisma.awardDecisionEvent.findMany({
      where: { legId: leg.id, type: "APPROVE" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].quoteId).toBe(quotes.REC.id);
    expect(events[0].variant).toBe("DEDICATED");
    expect(events[0].actorId).toBe(approverId);
  });

  it("an Executive hitting approve -> 403 (RolesGuard, route-level)", async () => {
    const senderId = randomUUID();
    const { query, leg } = await seedPendingApproval("execblocked", senderId);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(randomUUID(), Role.EXECUTIVE))
      .send()
      .expect(403);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL"); // untouched
  });

  it("the same Manager who sent -> 403 SELF_APPROVAL", async () => {
    const senderId = randomUUID();
    const { query, leg } = await seedPendingApproval("selfapproval", senderId);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(senderId, Role.MANAGER)) // same id that sent it
      .send()
      .expect(403);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL"); // untouched
  });

  it("reject with no reason -> 400", async () => {
    const senderId = randomUUID();
    const { query, leg } = await seedPendingApproval("noreason", senderId);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({})
      .expect(400);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL"); // untouched
  });

  it("reject (by a different Manager) -> decision DRAFT + rejectionReason set + quote still QUOTED + a REJECT event, then a re-send by an Executive succeeds again", async () => {
    const senderId = randomUUID(); // M1
    const rejectorId = randomUUID(); // M2
    const { query, leg, quotes } = await seedPendingApproval("reject", senderId);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", cookieFor(rejectorId, Role.MANAGER))
      .send({ reason: "Price looks stale, please re-confirm with the forwarder" })
      .expect(200);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("DRAFT");
    expect(decision?.rejectionReason).toBe("Price looks stale, please re-confirm with the forwarder");
    expect(decision?.sentByUserId).toBeNull();
    expect(decision?.decidedByUserId).toBe(rejectorId);
    expect(decision?.decidedAt).toBeTruthy();

    const quote = await prisma.quote.findUnique({ where: { id: quotes.REC.id } });
    expect(quote?.status).toBe("QUOTED"); // unchanged — reject is not a quote transition

    const updatedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(updatedLeg?.status).toBe("FULLY_QUOTED"); // unchanged

    const events = await prisma.awardDecisionEvent.findMany({
      where: { legId: leg.id, type: "REJECT" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("Price looks stale, please re-confirm with the forwarder");
    expect(events[0].actorId).toBe(rejectorId);

    // Re-enablement: the maker can send-for-approval again straight from this reset DRAFT.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID(), Role.EXECUTIVE))
      .send({})
      .expect(200);

    const resent = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(resent?.status).toBe("PENDING_APPROVAL");
  });

  it("approve when not PENDING_APPROVAL (a fresh DRAFT decision that was only shortlisted) -> 409", async () => {
    const { query, leg, quotes } = await seedLeg("notpending", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
    ]);

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/shortlist`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ quoteId: quotes.REC.id, variant: "DEDICATED" })
      .expect(200); // DRAFT, never sent for approval

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(409);
  });

  it("A8 — approve when the shortlisted quote is no longer QUOTED (stale) -> 409", async () => {
    const senderId = randomUUID();
    const { query, leg, quotes } = await seedPendingApproval("stale", senderId);

    // Simulate a concurrent change (e.g. a re-quote request) invalidating the shortlisted
    // quote's status out from under the pending decision, without going through StatusService
    // (this test only needs the DB row to reflect "no longer QUOTED", not a legal transition).
    await prisma.quote.update({ where: { id: quotes.REC.id }, data: { status: "REQUOTED" } });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(409);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL"); // untouched
  });
});
