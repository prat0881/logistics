process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID, randomBytes, createHash } from "node:crypto";
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
import { ScheduledEventService } from "../src/modules/comms/scheduled-event.service";
import { QUERY_LOCKED_MESSAGE } from "../src/modules/award/query-lock.service";

// S5.5 Task 2 (design §10.1) — the negotiation core: POST .../quotes/:quoteId/request-requote.
// CHANGED (S5.9.5 Task 4, design D3) — Executive-ONLY now (@Roles(Role.EXECUTIVE)), not
// Executive+: a Manager/Administrator's route to a revised price is Reject-with-a-reason, and
// negotiating with a forwarder is always the Executive's call. See the "D3 — role gate" test
// below. Fires quote REQUEST_REQUOTE (QUOTED|APPROVED -> REQUOTED, retaining draftJson), resets
// the leg's LegAwardDecision to DRAFT (+ reopens the leg via REOPEN_AWARD if it was APPROVED),
// reissues the FF's portal token, resets the RFQ deadline + re-arms the reminder/expiry
// ScheduledEvents, and notifies the FF with the negotiation comment.
const PREFIX = "AWRQ";
const CODE = `YAL00-${PREFIX}`;

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let scheduled: ScheduledEventService;

  // The route is Executive-ONLY (S5.9.5 D3, below) — every other test in this file calls it as
  // EXECUTIVE, which is still the only role that succeeds.
  const cookieFor = (userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role: Role.EXECUTIVE, tenantId: null })}`;
  // generate-client-quote is Manager+ gated (design §4/§16 O4) — needed to reach a REAL
  // QUOTING_CLIENT for the snapshot-teardown regression below.
  const managerCookie = (userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role: Role.MANAGER, tenantId: null })}`;
  // S5.9.5 (D3) — request-requote is now Executive-ONLY (the route excludes the higher roles,
  // not just admits them alongside EXECUTIVE), so the role-check test below needs an
  // ADMINISTRATOR cookie too, mirroring award-workflow-checker.e2e-spec.ts's role-parametrised
  // cookieFor.
  const adminCookie = (userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role: Role.ADMINISTRATOR, tenantId: null })}`;

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
    opts: {
      withDraft?: boolean;
      decisionStatus?: "DRAFT" | "PENDING_APPROVAL" | "APPROVED";
    } = {},
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
          ...(opts.decisionStatus === "PENDING_APPROVAL" || opts.decisionStatus === "APPROVED"
            ? { sentForApprovalAt: new Date() }
            : {}),
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
    scheduled = moduleRef.get(ScheduledEventService);
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

  it("APPROVED leg: request-requote -> 200; quote REQUOTED (draft retained), decision reset to DRAFT, leg walked back to RFQ_SENT, token+deadline reset, FF notified", async () => {
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

    // leg: reopened from APPROVED (REOPEN_AWARD -> FULLY_QUOTED) and then, S5.9.2 Q1, walked the
    // rest of the way back to what its quotes actually justify. This leg's ONE quote is now
    // REQUOTED, so nothing comparable is left and the honest status is RFQ_SENT — we are waiting
    // on the forwarder again. It used to stop at FULLY_QUOTED, which is register C7's mismatch
    // reached through the APPROVED door (LegQuoteProjector's ROLLUP_FROZEN guard skips a leg in
    // APPROVED, so requestRequote owns this recompute — see its own comment).
    const legAfter = await prisma.leg.findUniqueOrThrow({ where: { id: leg.id } });
    expect(legAfter.status).toBe("RFQ_SENT");

    // RFQ: deadline moved forward. S5.9 D7 — the token is deliberately NOT rotated any more
    // (rotation protected nothing: the same token already survives the whole first round, and
    // resolveByToken has no expiry) — the forwarder's bookmarked link must keep working across a
    // re-quote. Only the Stage-4 Regenerate button (RfqService.reissueToken) rotates it now.
    const rfqAfter = await prisma.rfq.findUniqueOrThrow({ where: { id: rfq.id } });
    expect(rfqAfter.accessTokenHash).toBe(seededHash);
    expect(rfqAfter.submissionDeadline.getTime()).toBeGreaterThan(Date.now());

    // no reissue audit row — nothing was rotated
    const reissues = await prisma.rfqTokenReissue.findMany({ where: { rfqId: rfq.id } });
    expect(reissues).toHaveLength(0);

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

  it("QUOTED leg (no approval yet): request-requote -> 200; quote REQUOTED, no REOPEN_AWARD fire, leg walked back by the rollup to RFQ_SENT, decision (if any) reset to DRAFT", async () => {
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

    // Never APPROVED, so no REOPEN_AWARD fire — but S5.9.2 Q1 means the LegQuoteProjector now
    // walks the leg back off FULLY_QUOTED anyway, because its only quote is REQUOTED and nothing
    // comparable is left. (The REOPEN_AWARD/no-REOPEN_AWARD distinction still holds; it just no
    // longer shows up as "the leg does not move".)
    const legAfter = await prisma.leg.findUniqueOrThrow({ where: { id: leg.id } });
    expect(legAfter.status).toBe("RFQ_SENT");

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

  // CHANGED (S5.9.5 Task 2) — this case used to be seeded EXPIRED. D4 makes EXPIRED requotable
  // (see the two D4 tests below), so it is no longer a valid example of a non-requotable status.
  // RFQ_SENT is: the forwarder has never submitted anything, so there is no price to negotiate.
  it("a quote in a non-requotable status (RFQ_SENT — nothing submitted to negotiate) -> 409", async () => {
    const { query, leg, quote } = await seedLeg("notrequotable", "RFQ_SENT", "RFQ_SENT");
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "x" })
      .expect(409);
  });

  // S5.9.5 (D4, register A4) — the sweep, driven end to end through the real cron entry point
  // (ScheduledEventService.runDue -> the `rfq.expiry` listener), on ONE FF holding TWO legs of one
  // query. Rfq is @@unique([queryId, freightForwarderId]), so that is ONE shared Rfq carrying TWO
  // quotes and a SINGLE onExpiry pass has to get both halves right — the same fixture shape, and
  // the same reason for it, as ff-portal-requote-submit.e2e-spec.ts's shared-Rfq sweep test.
  it("S5.9.5 (D4) — the expiry sweep keeps a REQUOTED quote's submitted price, and still discards an RFQ_SENT draft", async () => {
    // legA / ffPriced: QUOTED with a real draftJson, then negotiated through the real endpoint so
    // it is REQUOTED for exactly the reason D4 is about — we asked for a better price.
    const { query, leg: legA, ff, rfq, quote: pricedQuote } = await seedLeg(
      "sweep",
      "FULLY_QUOTED",
      "QUOTED",
      { withDraft: true, decisionStatus: "DRAFT" },
    );

    // legB: the SAME forwarder on a second leg, still RFQ_SENT with a half-filled draft they never
    // submitted — the case the discard was written for and must keep serving.
    const originB = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", city: "Ningbo", country: "CN" },
    });
    const destB = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", city: "Sharjah", country: "AE" },
    });
    const legB = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L2",
        mode: "ROAD",
        originPointId: originB.id,
        destinationPointId: destB.id,
        status: "RFQ_SENT" as never,
      },
    });
    const draftQuote = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: legB.id,
        freightForwarderId: ff.id,
        rfqId: rfq.id,
        status: "RFQ_SENT",
        // never submitted — an arbitrary in-progress placeholder is enough (mirrors
        // rfq-expiry.e2e-spec.ts's own `{ note: "in-progress draft" }`).
        draftJson: { note: "in-progress draft" } as unknown as Prisma.InputJsonValue,
      },
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legA.id}/quotes/${pricedQuote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "Can you sharpen this rate?" })
      .expect(200);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: pricedQuote.id } })).status).toBe(
      "REQUOTED",
    );

    // The forwarder never answers. Force the ONE shared DEADLINE-tier rfq.expiry timer that
    // request-requote just re-armed (RfqService.resetDeadlineAndRearm deletes + re-creates it) due
    // now, then run the cron for real.
    await prisma.scheduledEvent.update({
      where: {
        entityType_entityId_eventKey_tier: {
          entityType: "RFQ",
          entityId: rfq.id,
          eventKey: "rfq.expiry",
          tier: "DEADLINE",
        },
      },
      data: { dueAt: new Date() },
    });
    await scheduled.runDue();

    const requoted = await prisma.quote.findUniqueOrThrow({ where: { id: pricedQuote.id } });
    expect(requoted.status).toBe("EXPIRED"); // the window really did close
    expect(requoted.draftJson).not.toBeNull(); // ...but the price survived
    expect((requoted.draftJson as unknown as QuoteDraft).chargedWeightKg).toBe(500);

    const neverSubmitted = await prisma.quote.findUniqueOrThrow({ where: { id: draftQuote.id } });
    expect(neverSubmitted.status).toBe("EXPIRED");
    expect(neverSubmitted.draftJson).toBeNull(); // still discarded
  });

  // S5.9.5 (D4) — the other half of price-preservation: keeping the price would freeze the
  // forwarder OUT (price visible, portal closed) if EXPIRED had no way back to REQUOTED. Seeded at
  // EXPIRED-with-a-draft directly — the end state the sweep test above proves the sweep produces.
  it("S5.9.5 (D4) — an EXPIRED quote can be re-negotiated, which reopens the forwarder's portal", async () => {
    const { query, leg, rfq, quote } = await seedLeg("expiredrequote", "FULLY_QUOTED", "EXPIRED", {
      withDraft: true,
      decisionStatus: "DRAFT",
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "Are you still able to hold this price?" })
      .expect(200);

    const after = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(after.status).toBe("REQUOTED");
    expect(after.draftJson).not.toBeNull(); // re-negotiating does not discard it either

    // "reopens the forwarder's portal" concretely: a fresh submission window plus a re-armed
    // DEADLINE timer, so the RFQ is live again rather than a closed one they can still see.
    const rfqAfter = await prisma.rfq.findUniqueOrThrow({ where: { id: rfq.id } });
    expect(rfqAfter.submissionDeadline.getTime()).toBeGreaterThan(Date.now());
    const expiry = await prisma.scheduledEvent.findFirst({
      where: { entityType: "RFQ", entityId: rfq.id, eventKey: "rfq.expiry", tier: "DEADLINE" },
    });
    expect(expiry?.dueAt.getTime()).toBe(rfqAfter.submissionDeadline.getTime());
    expect(expiry?.firedAt).toBeNull();
  });

  it("401 when unauthenticated (locks the auth guard on the route)", async () => {
    const { query, leg, quote } = await seedLeg("unauth", "FULLY_QUOTED", "QUOTED", { withDraft: true });
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .send({ comment: "x" })
      .expect(401);
  });

  // S5.9.5 (design D6) — REWRITTEN. This test used to assert that request-requote on an
  // ALREADY-GENERATED (QUOTING_CLIENT) query silently tore the frozen awardSnapshot down and
  // rolled the query off QUOTING_CLIENT (the "teardown" the whole-branch review of S5.9 added to
  // negotiation.service.ts). D6 deliberately changes that: a locked query refuses EVERY write
  // except reopen-comparison and the quotation builder, so the negotiation never runs and the
  // teardown inside negotiation.service.ts is unreachable from this entry point — D6 names that
  // consequence and accepts it, on the grounds that "a user correcting a mistake must reopen
  // explicitly rather than discovering their client quotation silently torn down by an edit".
  //
  // The teardown code itself is NOT removed here (that is a separate decision, and D6's sibling
  // instruction is to keep the identical teardown in award-change-order.listener.ts).
  //
  // Every assertion the old test made about the negotiation's own effects is kept — it now runs
  // AFTER the explicit reopen D6 requires, which is the route the product still offers.
  it("S5.9.5 (D6) — request-requote on a generated (QUOTING_CLIENT) query is REFUSED with the lock message and changes nothing; after an explicit reopen-comparison the same call goes through", async () => {
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

    // --- D6: the lock refuses it, and NOTHING moves ---
    const comment = "Client wants a sharper rate before we send the quotation";
    const refused = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legs[0].id}/quotes/${legs[0].quoteId}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment })
      .expect(409);
    expect(refused.body.message).toBe(QUERY_LOCKED_MESSAGE);

    const stillLocked = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(stillLocked.awardSnapshot).not.toBeNull();
    expect(stillLocked.status).toBe("QUOTING_CLIENT");
    const quote1Refused = await prisma.quote.findUniqueOrThrow({ where: { id: legs[0].quoteId } });
    expect(quote1Refused.status).toBe("APPROVED");
    const decision1Refused = await prisma.legAwardDecision.findUnique({ where: { legId: legs[0].id } });
    expect(decision1Refused?.status).toBe("APPROVED");

    // --- the door out, then the SAME negotiation ---
    // S5.9.5 (D6) — reopen is Manager/Admin only and takes a required reason; `cookieFor` in this
    // file signs an EXECUTIVE (needed for request-requote's own D3 gate), which would now 403 on
    // reopen, so this call uses `managerCookie` instead.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", managerCookie(randomUUID()))
      .send({ reason: "S5.9.5 e2e — reopening to retry the negotiation" })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legs[0].id}/quotes/${legs[0].quoteId}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment })
      .expect(200);

    // --- the query is off QUOTING_CLIENT. The snapshot is null because REOPEN cleared it (not
    //     because the negotiation tore it down — under D6 the negotiation never sees a locked
    //     query at all). What the negotiation still owns is the ROLLUP below: S5.9.2 Q1/Q2, leg1
    //     walks all the way back to RFQ_SENT (its only quote is REQUOTED — nothing comparable
    //     left), so leastAdvanced(RFQ_SENT, APPROVED) = RFQ_SENT -> QueryStatus.RFQ_SENT. It used
    //     to read QUOTED off a leg1 parked at FULLY_QUOTED, which claimed a live price we were in
    //     fact waiting on a forwarder to re-send. ---
    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(updated.awardSnapshot).toBeNull();
    expect(updated.status).not.toBe("QUOTING_CLIENT");
    expect(updated.status).toBe("RFQ_SENT");

    // --- leg 1: negotiated as expected ---
    const quote1After = await prisma.quote.findUniqueOrThrow({ where: { id: legs[0].quoteId } });
    expect(quote1After.status).toBe("REQUOTED");
    const decision1After = await prisma.legAwardDecision.findUnique({ where: { legId: legs[0].id } });
    expect(decision1After?.status).toBe("DRAFT");
    const leg1After = await prisma.leg.findUniqueOrThrow({ where: { id: legs[0].id } });
    expect(leg1After.status).toBe("RFQ_SENT"); // S5.9.2 Q1 — was FULLY_QUOTED (see above)

    // --- leg 2: NOT touched by leg 1's negotiation (the fix must not over-reach) ---
    const quote2After = await prisma.quote.findUniqueOrThrow({ where: { id: legs[1].quoteId } });
    expect(quote2After.status).toBe("APPROVED");
    const decision2After = await prisma.legAwardDecision.findUnique({ where: { legId: legs[1].id } });
    expect(decision2After?.status).toBe("APPROVED");
    const leg2After = await prisma.leg.findUniqueOrThrow({ where: { id: legs[1].id } });
    expect(leg2After.status).toBe("APPROVED");
  });

  // S5.9 Task 5, register B1 (D5) — the compare screen has disabled Negotiate at
  // PENDING_APPROVAL since S5.7, but this endpoint itself still accepted a call while a leg's
  // decision was under checker review. REQUOTABLE_STATUSES alone does NOT close this: it only
  // gates the quote NAMED in the call, and a leg under review can carry a still-QUOTED SIBLING
  // quote (a second forwarder on the same leg who was never the shortlisted offer) — negotiating
  // THAT one would pass REQUOTABLE_STATUSES cleanly and silently wipe the decision a checker is
  // mid-review of on the OTHER, shortlisted quote. Reproduced directly here: two quotes on one
  // leg, one shortlisted+sent (PENDING_APPROVAL), the other still QUOTED; request-requote on the
  // sibling must 409, leaving the decision and the sibling itself untouched.
  it("B1 — refuses a re-quote while the leg's decision is pending approval, even against a still-QUOTED sibling quote on the same leg", async () => {
    const { query, leg, origin, quote: shortlisted } = await seedLeg(
      "b1",
      "PENDING_APPROVAL",
      "PENDING_APPROVAL",
      { withDraft: true, decisionStatus: "PENDING_APPROVAL" },
    );

    const siblingFf = await mkFf(`FF-${PREFIX}-b1-sib`);
    const siblingRfq = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: siblingFf.id,
        rfqNumber: `${CODE}-RFQ-b1-sib`,
        accessTokenHash: `hash-${PREFIX}-b1-sib`,
        submissionDeadline: new Date(Date.now() + 3600_000),
        incoterms: "FOB",
        currency: "INR",
        quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    const sibling = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: siblingFf.id,
        rfqId: siblingRfq.id,
        status: "QUOTED",
        submittedAt: new Date(),
        draftJson: roadDraft(leg.id, origin.id, 50000, 4) as unknown as Prisma.InputJsonValue,
      },
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${sibling.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "Can you do better?" })
      .expect(409);

    // Nothing moved — the decision survives intact for the checker, the sibling is untouched.
    const decisionAfter = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: leg.id } });
    expect(decisionAfter.status).toBe("PENDING_APPROVAL");
    expect(decisionAfter.shortlistedQuoteId).toBe(shortlisted.id);
    const siblingAfter = await prisma.quote.findUniqueOrThrow({ where: { id: sibling.id } });
    expect(siblingAfter.status).toBe("QUOTED");
  });

  // S5.9 Task 5 (D7) — rotation on re-quote protected nothing (the same token already survives
  // the whole first round, and resolveByToken has no expiry at all), and cost a forwarder
  // holding several legs on one query their bookmarked link every round. seedLeg's own fixture
  // seeds a fake, non-derived accessTokenHash (fine for tests that never resolve it), so this
  // test mints a REAL token/hash pair the same way RfqTokenService.mint() does and stores both,
  // mirroring what distribution/reissue now persist post-D8.
  it("D7 — does not rotate the RFQ's access token on a re-quote; the forwarder's existing portal link keeps resolving", async () => {
    const { query, leg, rfq, quote } = await seedLeg("d7", "FULLY_QUOTED", "QUOTED", {
      withDraft: true,
      decisionStatus: "DRAFT",
    });
    const rawToken = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(rawToken).digest("hex");
    await prisma.rfq.update({
      where: { id: rfq.id },
      data: { accessTokenHash: hash, accessToken: rawToken },
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "Please revise" })
      .expect(200);

    const rfqAfter = await prisma.rfq.findUniqueOrThrow({ where: { id: rfq.id } });
    expect(rfqAfter.accessTokenHash).toBe(hash);
    expect(rfqAfter.accessToken).toBe(rawToken);
    const reissues = await prisma.rfqTokenReissue.findMany({ where: { rfqId: rfq.id } });
    expect(reissues).toHaveLength(0);

    // the forwarder's OLD/bookmarked link still resolves through the portal
    await request(app.getHttpServer()).get(`/api/ff/rfq/${rawToken}`).expect(200);
  });

  // S5.9 Task 5 (D8) — the raw token has to be persisted for this: only its hash was stored
  // before, and the raw value existed solely inside the originally emailed link. Confirms the
  // re-quote email actually renders the SAME link the forwarder already has.
  it("D8 — the re-quote email links to the forwarder's SAME (unrotated) portal token", async () => {
    const { query, leg, rfq, quote } = await seedLeg("d8", "FULLY_QUOTED", "QUOTED", {
      withDraft: true,
      decisionStatus: "DRAFT",
    });
    const rawToken = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(rawToken).digest("hex");
    await prisma.rfq.update({
      where: { id: rfq.id },
      data: { accessTokenHash: hash, accessToken: rawToken },
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "Please revise" })
      .expect(200);

    const msg = await prisma.messageLog.findFirst({
      where: { entityType: "RFQ", entityId: rfq.id, eventKey: "rfq.requote_requested" },
      orderBy: { createdAt: "desc" },
    });
    expect(msg?.bodyRendered).toContain(rawToken);
    // S5.9 Task 5 review round 2, IMPORTANT 2 — MessageTemplate's seed upsert is create-only
    // (message-templates.seed.ts), so an already-seeded row does NOT pick up a source copy
    // change on its own; a dedicated data migration
    // (20260821162750_s59_requote_email_copy) backfills it. This asserts the copy the RUNNING
    // app actually renders (not just what the seed source says) reflects D7 — reassuring the
    // forwarder their link is unchanged, not implying a fresh one.
    expect(msg?.bodyRendered).toContain("it has not changed");
  });

  // S5.9 Task 5 (D8) — a legacy Rfq row from before this migration never had its raw token
  // persisted (only the hash was ever stored). A backfill from MessageLog.tokens is possible but
  // deliberately out of scope; the re-quote email must degrade to the brief's fallback string
  // rather than emailing a broken/empty link. seedLeg's own fixture never sets `accessToken` — it
  // stays null exactly like a real pre-S5.9 row would.
  it("D8 fallback — a legacy RFQ with no stored accessToken gets the fallback copy in its re-quote email, not a broken link", async () => {
    const { query, leg, rfq, quote } = await seedLeg("d8legacy", "FULLY_QUOTED", "QUOTED", {
      withDraft: true,
      decisionStatus: "DRAFT",
    });
    const rfqBefore = await prisma.rfq.findUniqueOrThrow({ where: { id: rfq.id } });
    expect(rfqBefore.accessToken).toBeNull();

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ comment: "Please revise" })
      .expect(200);

    const msg = await prisma.messageLog.findFirst({
      where: { entityType: "RFQ", entityId: rfq.id, eventKey: "rfq.requote_requested" },
      orderBy: { createdAt: "desc" },
    });
    expect(msg?.bodyRendered).toContain("the portal link in your original RFQ email");
  });

  it("S5.9.5 (D3) — request-requote is Executive-only; a Manager and an Administrator are both refused", async () => {
    const { query, leg, quote } = await seedLeg("rolegate", "FULLY_QUOTED", "QUOTED", {
      withDraft: true,
      decisionStatus: "DRAFT",
    });
    const body = { comment: "please sharpen" };
    const url = `/api/queries/${query.id}/legs/${leg.id}/quotes/${quote.id}/request-requote`;

    await request(app.getHttpServer())
      .post(url)
      .set("Cookie", managerCookie(randomUUID()))
      .send(body)
      .expect(403);
    await request(app.getHttpServer())
      .post(url)
      .set("Cookie", adminCookie(randomUUID()))
      .send(body)
      .expect(403);

    // Nothing moved for either refused attempt.
    const quoteAfterRefusals = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(quoteAfterRefusals.status).toBe("QUOTED");

    // Positive control — the same call from an Executive still succeeds (route is @HttpCode(200),
    // not the POST default 201), so a bug that 403s everyone cannot pass this test.
    await request(app.getHttpServer())
      .post(url)
      .set("Cookie", cookieFor(randomUUID()))
      .send(body)
      .expect(200);
    const quoteAfterExec = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(quoteAfterExec.status).toBe("REQUOTED");
  });
});
