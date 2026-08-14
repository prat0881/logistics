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

// S5.5 Task 2 (design §10.1) — the negotiation core: POST .../quotes/:quoteId/request-requote,
// Executive+ (no @Roles). Fires quote REQUEST_REQUOTE (QUOTED|APPROVED -> REQUOTED, retaining
// draftJson), resets the leg's LegAwardDecision to DRAFT (+ reopens the leg via REOPEN_AWARD if
// it was APPROVED), reissues the FF's portal token, resets the RFQ deadline + re-arms the
// reminder/expiry ScheduledEvents, and notifies the FF with the negotiation comment.
const PREFIX = "AWRQ";
const CODE = `YAL00-${PREFIX}`;

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  // Any authenticated (Executive+) role works — the route carries no @Roles.
  const cookieFor = (userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role: Role.EXECUTIVE, tenantId: null })}`;
  // generate-client-quote is Manager+ gated (design §4/§16 O4) — needed to reach a REAL
  // QUOTING_CLIENT for the snapshot-teardown regression below.
  const managerCookie = (userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role: Role.MANAGER, tenantId: null })}`;

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

  // Same minimal ROAD-draft shape as award-workflow-maker.e2e-spec.ts's roadDraft.
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

  // One Query + one Leg + one FF/Rfq/Quote, all seeded directly at the target statuses (the
  // maker-checker HTTP flow that would normally produce an APPROVED decision is S5.4's concern,
  // already covered there — here we seed the end state directly, mirroring
  // award-workflow-maker.e2e-spec.ts's seedLeg / ff-portal-requote-submit's direct-seed
  // convention for statuses the HTTP surface can't (yet) produce on its own).
  async function seedLeg(
    label: string,
    legStatus: string,
    quoteStatus: string,
    opts: { withDraft?: boolean; decisionStatus?: "DRAFT" | "APPROVED" } = {},
  ) {
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
    const ff = await mkFf(`FF-${PREFIX}-${label}`);
    const seededHash = `hash-${PREFIX}-${label}`;
    const rfq = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: ff.id,
        rfqNumber: `${CODE}-RFQ-${label}`,
        accessTokenHash: seededHash,
        submissionDeadline: new Date(Date.now() + 3600_000),
        incoterms: "FOB",
        currency: "INR",
        quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    const quote = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ff.id,
        rfqId: rfq.id,
        status: quoteStatus as never,
        ...(opts.withDraft
          ? {
              submittedAt: new Date(),
              draftJson: roadDraft(leg.id, origin.id, 83200, 3) as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
    });

    let decision = null;
    if (opts.decisionStatus) {
      decision = await prisma.legAwardDecision.create({
        data: {
          legId: leg.id,
          queryId: query.id,
          shortlistedQuoteId: quote.id,
          shortlistedVariant: "DEDICATED",
          status: opts.decisionStatus,
          sentByUserId: randomUUID(),
          ...(opts.decisionStatus === "APPROVED"
            ? { decidedByUserId: randomUUID(), decidedAt: new Date() }
            : {}),
        },
      });
    }

    return { query, leg, origin, dest, ff, rfq, quote, decision, seededHash };
  }

  // A query with N legs, EACH already fully APPROVED (leg APPROVED, quote APPROVED with a
  // draftJson, LegAwardDecision APPROVED+shortlisted) — the state generate-client-quote's A6
  // gate requires before it will freeze a real awardSnapshot. Mirrors
  // award-generate.e2e-spec.ts's seedQuery (not importable — scoped inside that file's own
  // describe block), trimmed to just what the snapshot-teardown regression needs.
  async function seedApprovedQuery(label: string, legSpecs: { amount: number; transitDays: number }[]) {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-${label}`, priority: "HIGH", incoterms: "FOB" },
    });
    const legs: { id: string; quoteId: string; ffId: string; rfqId: string }[] = [];
    for (let i = 0; i < legSpecs.length; i++) {
      const spec = legSpecs[i];
      const key = `${label}-${i + 1}`;
      const origin = await prisma.point.create({
        data: { queryId: query.id, type: "PICKUP", city: "Shanghai", country: "CN" },
      });
      const dest = await prisma.point.create({
        data: { queryId: query.id, type: "DELIVERY", city: "Dubai", country: "AE" },
      });
      const leg = await prisma.leg.create({
        data: {
          queryId: query.id,
          legCode: `L${i + 1}`,
          mode: "ROAD",
          originPointId: origin.id,
          destinationPointId: dest.id,
          status: "APPROVED" as never,
        },
      });
      const ff = await mkFf(`FF-${PREFIX}-${key}`);
      const rfq = await prisma.rfq.create({
        data: {
          queryId: query.id,
          freightForwarderId: ff.id,
          rfqNumber: `${CODE}-RFQ-${key}`,
          accessTokenHash: `hash-${PREFIX}-${key}`,
          submissionDeadline: new Date(Date.now() + 3600_000),
          incoterms: "FOB",
          currency: "INR",
          quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
        },
      });
      const quote = await prisma.quote.create({
        data: {
          queryId: query.id,
          legId: leg.id,
          freightForwarderId: ff.id,
          rfqId: rfq.id,
          status: "APPROVED" as never,
          submittedAt: new Date(),
          draftJson: roadDraft(
            leg.id,
            origin.id,
            spec.amount,
            spec.transitDays,
          ) as unknown as Prisma.InputJsonValue,
        },
      });
      await prisma.legAwardDecision.create({
        data: {
          legId: leg.id,
          queryId: query.id,
          shortlistedQuoteId: quote.id,
          shortlistedVariant: "DEDICATED",
          status: "APPROVED",
          sentByUserId: randomUUID(),
          sentForApprovalAt: new Date(),
          decidedByUserId: randomUUID(),
          decidedAt: new Date(),
        },
      });
      legs.push({ id: leg.id, quoteId: quote.id, ffId: ff.id, rfqId: rfq.id });
    }
    return { query, legs };
  }

  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    const qIds = qs.map((q) => q.id);
    const legs = await prisma.leg.findMany({ where: { queryId: { in: qIds } }, select: { id: true } });
    const legIds = legs.map((l) => l.id);
    const rfqs = await prisma.rfq.findMany({ where: { queryId: { in: qIds } }, select: { id: true } });
    const rfqIds = rfqs.map((r) => r.id);
    if (rfqIds.length) {
      await prisma.scheduledEvent.deleteMany({ where: { entityType: "RFQ", entityId: { in: rfqIds } } });
      await prisma.messageLog.deleteMany({ where: { entityType: "RFQ", entityId: { in: rfqIds } } });
    }
    await prisma.awardDecisionEvent.deleteMany({ where: { legId: { in: legIds } } });
    await prisma.legAwardDecision.deleteMany({ where: { legId: { in: legIds } } });
    await prisma.quote.deleteMany({ where: { queryId: { in: qIds } } });
    await prisma.rfqTokenReissue.deleteMany({ where: { rfqId: { in: rfqIds } } });
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
    // create-only upserts: guarantees rfq.requote_requested + the reminder/deadline AppSettings
    // exist regardless of test order/DB state (CI has no separate seed step).
    await seedReferenceData(prisma);
    await cleanup();
    // generate-client-quote's A7 gate needs an FX rate on file for the winners' currency (INR).
    await prisma.fxRate.create({ data: { currency: "INR", unitsPerUsd: 83.2, note: PREFIX } });
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("APPROVED leg: request-requote -> 200; quote REQUOTED (draft retained), decision reset to DRAFT, leg back to FULLY_QUOTED, token+deadline reset, FF notified", async () => {
    const { query, leg, rfq, quote, seededHash } = await seedLeg("approved", "APPROVED", "APPROVED", {
      withDraft: true,
      decisionStatus: "APPROVED",
    });
    const actorId = randomUUID();
    const comment = "Client wants a better rate on this lane, please revise.";

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .set("Cookie", cookieFor(actorId))
      .send({ comment })
      .expect(200);

    expect(res.body.status).toBe("REQUOTED");

    // quote: REQUOTED, draftJson RETAINED (the earlier price must stay visible)
    const quoteAfter = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(quoteAfter.status).toBe("REQUOTED");
    expect(quoteAfter.draftJson).not.toBeNull();
    expect((quoteAfter.draftJson as unknown as QuoteDraft).chargedWeightKg).toBe(500);

    // decision: reset to a clean DRAFT slate
    const decisionAfter = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decisionAfter?.status).toBe("DRAFT");
    expect(decisionAfter?.shortlistedQuoteId).toBeNull();
    expect(decisionAfter?.shortlistedVariant).toBeNull();
    expect(decisionAfter?.sentByUserId).toBeNull();
    expect(decisionAfter?.decidedByUserId).toBeNull();
    expect(decisionAfter?.decidedAt).toBeNull();
    expect(decisionAfter?.rejectionReason).toBeNull();

    // leg: reopened from APPROVED back to FULLY_QUOTED
    const legAfter = await prisma.leg.findUniqueOrThrow({ where: { id: leg.id } });
    expect(legAfter.status).toBe("FULLY_QUOTED");

    // RFQ: token rotated, deadline moved forward
    const rfqAfter = await prisma.rfq.findUniqueOrThrow({ where: { id: rfq.id } });
    expect(rfqAfter.accessTokenHash).not.toBe(seededHash);
    expect(rfqAfter.submissionDeadline.getTime()).toBeGreaterThan(Date.now());

    // an audit row for the token rotation
    const reissues = await prisma.rfqTokenReissue.findMany({ where: { rfqId: rfq.id } });
    expect(reissues).toHaveLength(1);

    // fresh reminder/expiry ScheduledEvents re-armed off the NEW deadline
    const expiry = await prisma.scheduledEvent.findFirst({
      where: { entityType: "RFQ", entityId: rfq.id, eventKey: "rfq.expiry", tier: "DEADLINE" },
    });
    expect(expiry).not.toBeNull();
    expect(expiry?.dueAt.getTime()).toBe(rfqAfter.submissionDeadline.getTime());
    expect(expiry?.firedAt).toBeNull();
    expect(expiry?.cancelledAt).toBeNull();
    const reminder = await prisma.scheduledEvent.findFirst({
      where: { entityType: "RFQ", entityId: rfq.id, eventKey: "rfq.reminder" },
    });
    expect(reminder).not.toBeNull();

    // FF notified with the comment carried through
    const msg = await prisma.messageLog.findFirst({
      where: { entityType: "RFQ", entityId: rfq.id, eventKey: "rfq.requote_requested" },
    });
    expect(msg).not.toBeNull();
    expect(msg?.bodyRendered).toContain(comment);
    expect(msg?.toAddress).toBe((await prisma.freightForwarder.findUniqueOrThrow({ where: { id: quote.freightForwarderId } })).email);

    // audit trail
    const events = await prisma.awardDecisionEvent.findMany({
      where: { legId: leg.id, type: "REQUEST_REQUOTE" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe(comment);
    expect(events[0].actorId).toBe(actorId);
    expect(events[0].quoteId).toBe(quote.id);
  });

  it("QUOTED leg (no approval yet): request-requote -> 200; quote REQUOTED, leg NOT force-reopened, decision (if any) reset to DRAFT", async () => {
    const { query, leg, quote } = await seedLeg("quoted", "FULLY_QUOTED", "QUOTED", {
      withDraft: true,
      decisionStatus: "DRAFT",
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "Please re-check your pricing" })
      .expect(200);

    const quoteAfter = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(quoteAfter.status).toBe("REQUOTED");

    // never was APPROVED -> no REOPEN_AWARD fire -> leg stays exactly where it was
    const legAfter = await prisma.leg.findUniqueOrThrow({ where: { id: leg.id } });
    expect(legAfter.status).toBe("FULLY_QUOTED");

    const decisionAfter = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decisionAfter?.status).toBe("DRAFT");
  });

  it("missing comment -> 400", async () => {
    const { query, leg, quote } = await seedLeg("nocomment", "FULLY_QUOTED", "QUOTED", { withDraft: true });
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({})
      .expect(400);
  });

  it("blank comment -> 400 (Zod min(1) after trim)", async () => {
    const { query, leg, quote } = await seedLeg("blankcomment", "FULLY_QUOTED", "QUOTED", { withDraft: true });
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "   " })
      .expect(400);
  });

  it("ownership mismatch (right quote, wrong query / wrong leg / unrelated quoteId) -> 404 in each case", async () => {
    const a = await seedLeg("mismatch-a", "FULLY_QUOTED", "QUOTED", { withDraft: true });
    const b = await seedLeg("mismatch-b", "FULLY_QUOTED", "QUOTED", { withDraft: true });

    // right legId + quoteId, WRONG queryId
    await request(app.getHttpServer())
      .post(`/api/queries/${b.query.id}/legs/${a.leg.id}/quotes/${a.quote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "x" })
      .expect(404);

    // right queryId + quoteId, WRONG legId
    await request(app.getHttpServer())
      .post(`/api/queries/${a.query.id}/legs/${b.leg.id}/quotes/${a.quote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "x" })
      .expect(404);

    // right query + leg, unrelated/nonexistent quoteId
    await request(app.getHttpServer())
      .post(`/api/queries/${a.query.id}/legs/${a.leg.id}/quotes/${randomUUID()}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "x" })
      .expect(404);

    // nothing was mutated by any of the rejected attempts
    const quoteAfter = await prisma.quote.findUniqueOrThrow({ where: { id: a.quote.id } });
    expect(quoteAfter.status).toBe("QUOTED");
  });

  it("a quote in a non-live status (EXPIRED) -> 409", async () => {
    const { query, leg, quote } = await seedLeg("expired", "FULLY_QUOTED", "EXPIRED");
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "x" })
      .expect(409);
  });

  it("401 when unauthenticated (locks the auth guard on the route)", async () => {
    const { query, leg, quote } = await seedLeg("unauth", "FULLY_QUOTED", "QUOTED", { withDraft: true });
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .send({ comment: "x" })
      .expect(401);
  });

  // Whole-branch review, task 2 — a real cross-task bug: request-requote on a leg that's part
  // of an ALREADY-GENERATED (QUOTING_CLIENT) query must tear down that frozen awardSnapshot,
  // exactly as the §10.2 change-order reversal listener does for its own reopen path. Without
  // this, deriveQueryStatus's `quotingClient` milestone short-circuits ahead of the leg rollup
  // and the query keeps reporting QUOTING_CLIENT with a stale client-facing total naming a
  // quote that's now REQUOTED and a decision that's now DRAFT.
  it("QUOTING_CLIENT teardown — request-requote on a generated query's leg winner clears awardSnapshot and rolls the query OFF QUOTING_CLIENT (to QUOTED, not back to QUOTING_CLIENT); the untouched leg is unaffected", async () => {
    const { query, legs } = await seedApprovedQuery("qc", [
      { amount: 83200, transitDays: 3 },
      { amount: 41600, transitDays: 5 },
    ]);

    // --- reach a REAL QUOTING_CLIENT via the real endpoint (not a hand-crafted snapshot) ---
    const genRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", managerCookie(randomUUID()))
      .send()
      .expect(200);
    expect(genRes.body.status).toBe("QUOTING_CLIENT");
    const beforeRequote = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(beforeRequote.status).toBe("QUOTING_CLIENT");
    expect(beforeRequote.awardSnapshot).not.toBeNull();

    // --- negotiate leg 1's winner ---
    const comment = "Client wants a sharper rate before we send the quotation";
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legs[0].id}/quotes/${legs[0].quoteId}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment })
      .expect(200);

    // --- the query rolled OFF QUOTING_CLIENT (to QUOTED — leg1 FULLY_QUOTED, leg2 still
    //     APPROVED -> leastAdvanced = FULLY_QUOTED -> QUOTED), snapshot cleared ---
    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(updated.awardSnapshot).toBeNull();
    expect(updated.status).not.toBe("QUOTING_CLIENT");
    expect(updated.status).toBe("QUOTED");

    // --- leg 1: negotiated as expected ---
    const quote1After = await prisma.quote.findUniqueOrThrow({ where: { id: legs[0].quoteId } });
    expect(quote1After.status).toBe("REQUOTED");
    const decision1After = await prisma.legAwardDecision.findUnique({ where: { legId: legs[0].id } });
    expect(decision1After?.status).toBe("DRAFT");
    const leg1After = await prisma.leg.findUniqueOrThrow({ where: { id: legs[0].id } });
    expect(leg1After.status).toBe("FULLY_QUOTED");

    // --- leg 2: NOT touched by leg 1's negotiation (the fix must not over-reach) ---
    const quote2After = await prisma.quote.findUniqueOrThrow({ where: { id: legs[1].quoteId } });
    expect(quote2After.status).toBe("APPROVED");
    const decision2After = await prisma.legAwardDecision.findUnique({ where: { legId: legs[1].id } });
    expect(decision2After?.status).toBe("APPROVED");
    const leg2After = await prisma.leg.findUniqueOrThrow({ where: { id: legs[1].id } });
    expect(leg2After.status).toBe("APPROVED");
  });
});
