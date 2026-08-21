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
// POST .../legs/:legId/send-for-approval, Executive+ (no @Roles). The checker half
// (approve/reject, Manager+ + four-eyes) is award-workflow-checker.e2e-spec.ts.
//
// S5.9 Task 3 (register B2/B3) — selecting an offer and sending it for approval used to be two
// calls (PUT .../legs/:legId/shortlist, then this POST). They are now ONE call: the offer is
// named directly in the send-for-approval request body (`quoteId`/`variant`), and the whole
// thing (selection + guard checks + the PENDING_APPROVAL write) runs in a single transaction —
// a guard failure anywhere rolls the selection back too, so a rejected call now leaves NO
// LegAwardDecision behind (not even a DRAFT one), unlike the old two-call shape where a
// shortlist could persist independently of whether the following send ever succeeded. Every
// test below was rewritten off the retired two-call shape onto the single call; see
// award.service.ts's sendForApproval for the guard order.
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

  it("sends the recommended offer for approval -> 200 + a PENDING_APPROVAL LegAwardDecision with the recommendation snapshotted", async () => {
    const { query, leg, quotes } = await seedLeg("happy", "FULLY_QUOTED", [
      // HIGH priority ranks by transit first: REC (3d) beats OTH (5d) outright — no tie-break.
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "OTH", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);
    const actorId = randomUUID();

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(actorId))
      .send({ quoteId: quotes.REC.id, variant: "DEDICATED" })
      .expect(200);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision).toBeTruthy();
    expect(decision?.status).toBe("PENDING_APPROVAL");
    expect(decision?.shortlistedQuoteId).toBe(quotes.REC.id);
    expect(decision?.shortlistedVariant).toBe("DEDICATED");
    expect(decision?.recommendedQuoteId).toBe(quotes.REC.id);
    expect(decision?.recommendedVariant).toBe("DEDICATED");
    expect(decision?.overrideReason).toBeNull();
    expect(decision?.sentByUserId).toBe(actorId);
    expect(decision?.sentForApprovalAt).toBeTruthy();

    // A single event now covers what used to be two (SHORTLIST + SEND_FOR_APPROVAL) — one call,
    // one audit entry, carrying the named offer.
    const events = await prisma.awardDecisionEvent.findMany({
      where: { legId: leg.id, type: "SEND_FOR_APPROVAL" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].quoteId).toBe(quotes.REC.id);
    expect(events[0].variant).toBe("DEDICATED");
    expect(events[0].actorId).toBe(actorId);
  });

  it("B3 — sends the offer named in THIS request, not whatever a stale decision row already has persisted", async () => {
    // Simulates the exact bug register B3 retires: a decision row already exists (as the old
    // separate PUT .../shortlist call used to leave behind) pointing at a DIFFERENT offer. The
    // merged call must act on the offer named in ITS OWN request body, never re-reading the
    // stale row it's about to overwrite.
    const { query, leg, quotes } = await seedLeg("b3", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "OTH", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);
    await prisma.legAwardDecision.create({
      data: {
        legId: leg.id,
        queryId: query.id,
        shortlistedQuoteId: quotes.OTH.id,
        shortlistedVariant: "DEDICATED",
        status: "DRAFT",
      },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.REC.id, variant: "DEDICATED" })
      .expect(200);

    expect(res.body.status).toBe("PENDING_APPROVAL");
    expect(res.body.shortlistedQuoteId).toBe(quotes.REC.id);

    const [updatedLeg, quote] = await Promise.all([
      prisma.leg.findUniqueOrThrow({ where: { id: leg.id } }),
      prisma.quote.findUniqueOrThrow({ where: { id: quotes.REC.id } }),
    ]);
    expect(updatedLeg.status).toBe("PENDING_APPROVAL");
    expect(quote.status).toBe("PENDING_APPROVAL");
  });

  it("B2 — refuses a second send while the leg is already pending approval", async () => {
    const { query, leg, quotes } = await seedLeg("b2", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "OTH", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.REC.id, variant: "DEDICATED" })
      .expect(200);

    // B2 fires before A2 is ever evaluated — no overrideReason supplied, and it still 409s
    // rather than 400ing on the (also-true) override requirement.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.OTH.id, variant: "DEDICATED" })
      .expect(409);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL");
    expect(decision?.shortlistedQuoteId).toBe(quotes.REC.id); // unchanged
  });

  it("A1 — sending a quoteId that is not an offer on this leg -> 400", async () => {
    const { query, leg } = await seedLeg("a1", "FULLY_QUOTED", [
      { key: "ONLY", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: randomUUID(), variant: "DEDICATED" })
      .expect(400);

    expect(await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } })).toBeNull();
  });

  it("A1 — sending an unpriced variant placeholder (GROUPAGE, when the FF only priced DEDICATED) -> 400; the priced variant still works", async () => {
    // roadDraft() (above) only ever supplies a DEDICATED trucking rate — comparison.service.ts's
    // `variantsForMode("ROAD")` still unconditionally emits a GROUPAGE OfferDto for this quote,
    // just with `priced: false` (~$0 nativeTotal). A1 must reject sending that placeholder.
    const { query, leg, quotes } = await seedLeg("a1-unpriced", "FULLY_QUOTED", [
      { key: "ONLY", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.ONLY.id, variant: "GROUPAGE", overrideReason: "x" })
      .expect(400);
    expect(await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } })).toBeNull();

    // The SAME quote's actually-priced DEDICATED variant is still a valid, sendable offer.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.ONLY.id, variant: "DEDICATED" })
      .expect(200);
    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL");
    expect(decision?.shortlistedQuoteId).toBe(quotes.ONLY.id);
    expect(decision?.shortlistedVariant).toBe("DEDICATED");
  });

  it("A2 — sending an offer that overrides the recommendation with no overrideReason -> 400, and nothing is persisted (single-transaction rollback)", async () => {
    const { query, leg, quotes } = await seedLeg("a2", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "OTH", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.OTH.id, variant: "DEDICATED" }) // NOT the recommendation; no overrideReason
      .expect(400);

    // Unlike the old two-call shape (where the shortlist half could persist a DRAFT independent
    // of the send half's outcome), the whole call is one transaction — A2 failing rolls the
    // selection write back too, so no decision exists at all.
    expect(await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } })).toBeNull();
  });

  it("send-for-approval with an overrideReason -> 200 + PENDING_APPROVAL + sentByUserId", async () => {
    const { query, leg, quotes } = await seedLeg("override", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "OTH", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);

    const senderId = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId))
      .send({
        quoteId: quotes.OTH.id,
        variant: "DEDICATED",
        overrideReason: "Client asked for this forwarder by name",
      })
      .expect(200);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL");
    expect(decision?.overrideReason).toBe("Client asked for this forwarder by name");
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

    // Name the only comparable (and thus recommended) offer, so A2 can't interfere.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.QUOTED.id, variant: "DEDICATED" })
      .expect(400);

    expect(await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } })).toBeNull();
  });

  it("A3 (converse) — a PARTIALLY_QUOTED leg whose only outstanding RFQ deadline HAS passed may send", async () => {
    const { query, leg, quotes } = await seedLeg("a3pass", "PARTIALLY_QUOTED", [
      { key: "QUOTED", status: "QUOTED", deadline: past(), draft: { amount: 83200, transitDays: 3 } },
      { key: "PENDING", status: "RFQ_SENT", deadline: past() }, // never responded, but window is over
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.QUOTED.id, variant: "DEDICATED" })
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
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.REC.id, variant: "DEDICATED" })
      .expect(400);

    expect(await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } })).toBeNull();

    const senderId = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId))
      .send({
        quoteId: quotes.REC.id,
        variant: "DEDICATED",
        proceedWithoutWaiting: true,
        proceedReason: "Client needs the number today",
      })
      .expect(200);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL");

    const events = await prisma.awardDecisionEvent.findMany({
      where: { legId: leg.id, type: "SEND_FOR_APPROVAL" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("Client needs the number today");
    expect(events[0].actorId).toBe(senderId);
  });

  it("400s send-for-approval when the body is missing a quoteId (schema-level: no offer to name)", async () => {
    const { query, leg } = await seedLeg("noshortlist", "FULLY_QUOTED", [
      { key: "ONLY", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({})
      .expect(400);
  });

  // ── S5.9 Task 3 review round 2 — CRITICAL 1 (register B3): the merged call is still a race ──
  it("CRITICAL 1 — two concurrent sends naming different offers on the same leg: exactly one wins, the loser 409s with nothing persisted, and the winner's response names exactly what got persisted", async () => {
    const { query, leg, quotes } = await seedLeg("race", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "OTH", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);

    // Fired via Promise.all (not sequential awaits) so both requests are genuinely in flight at
    // once — each reaches its own `$transaction` and the step-0 `SELECT ... FOR UPDATE` before
    // either commits. `overrideReason` on B pre-empts A2 (OTH is never the recommendation, REC
    // is) so the ONLY guard either request can fail on on is the race itself.
    const [resA, resB] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
        .set("Cookie", cookieFor(randomUUID()))
        .send({ quoteId: quotes.REC.id, variant: "DEDICATED" }),
      request(app.getHttpServer())
        .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
        .set("Cookie", cookieFor(randomUUID()))
        .send({ quoteId: quotes.OTH.id, variant: "DEDICATED", overrideReason: "racing on purpose" }),
    ]);

    // Requirement 1 — exactly one winner, exactly one loser.
    const responses = [resA, resB];
    const winners = responses.filter((r) => r.status === 200);
    const losers = responses.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const decision = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: leg.id } });
    expect(decision.status).toBe("PENDING_APPROVAL");

    // Requirement 2 — the WINNER's response body names exactly what the decision row actually
    // holds. Without the step-0 lock this can diverge: the request that returns 200 is not
    // necessarily the one whose write survived (see award.service.ts's CRITICAL-1 comment).
    expect(winners[0].body.shortlistedQuoteId).toBe(decision.shortlistedQuoteId);
    expect(winners[0].body.shortlistedVariant).toBe(decision.shortlistedVariant);
    expect([quotes.REC.id, quotes.OTH.id]).toContain(decision.shortlistedQuoteId);

    // No stranded quote: the loser's transaction rolled back before persistSelection, so its own
    // post-commit fire never ran — only the winner's named quote moved. Exactly one of the two
    // is PENDING_APPROVAL, and it is the one the decision actually names.
    const [rec, oth] = await Promise.all([
      prisma.quote.findUniqueOrThrow({ where: { id: quotes.REC.id } }),
      prisma.quote.findUniqueOrThrow({ where: { id: quotes.OTH.id } }),
    ]);
    const pendingStatuses = [rec.status, oth.status].filter((s) => s === "PENDING_APPROVAL");
    expect(pendingStatuses).toHaveLength(1);
    const winningQuoteStatus = decision.shortlistedQuoteId === quotes.REC.id ? rec.status : oth.status;
    expect(winningQuoteStatus).toBe("PENDING_APPROVAL");
    const losingQuoteStatus = decision.shortlistedQuoteId === quotes.REC.id ? oth.status : rec.status;
    expect(losingQuoteStatus).toBe("QUOTED"); // untouched — the loser never reached its fire()

    // Exactly one audit event — the loser's transaction never reached the event write.
    const events = await prisma.awardDecisionEvent.findMany({
      where: { legId: leg.id, type: "SEND_FOR_APPROVAL" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].quoteId).toBe(decision.shortlistedQuoteId);
  });

  // ── S5.9 Task 3 review round 2 — CRITICAL 2: a guard-passing send can 500 on the fire ──
  it("CRITICAL 2 — refuses to send a REQUOTED offer (still visible/priced in the comparison) even with overrideReason + proceedWithoutWaiting + proceedReason, and leaves nothing committed", async () => {
    // FULLY_QUOTED leg with one QUOTED offer and one REQUOTED offer that's cheaper AND faster —
    // mirrors the reviewer's exact repro: the projector never walks an already-FULLY_QUOTED leg
    // backwards just because one of its quotes goes REQUOTED (leg-quote.projector.ts only fires
    // QUOTE_PARTIAL from RFQ_SENT), so this is the realistic shape, not a contrived one.
    const { query, leg, quotes } = await seedLeg("stale-offer", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "REQUOTED", deadline: future(), draft: { amount: 50000, transitDays: 2 } },
    ]);

    // Every OTHER guard is pre-empted on purpose (valid overrideReason, valid A9 proceed pair)
    // so a 409 here can only be the new in-transaction freshness check, not A2 or A9.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({
        quoteId: quotes.REQ.id,
        variant: "DEDICATED",
        overrideReason: "picking the requoted one anyway",
        proceedWithoutWaiting: true,
        proceedReason: "cannot wait for the re-quote",
      })
      .expect(409);

    // Nothing committed at all — no decision, and neither quote nor the leg moved. Before this
    // fix, the guard sequence would commit a PENDING_APPROVAL decision naming REQ and then throw
    // `IllegalTransitionError` out of the post-commit quote fire (REQUOTED has no
    // `send_for_approval` source on the quote machine), leaving a wedged leg only reject() could
    // free.
    expect(await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } })).toBeNull();
    const [rec, req] = await Promise.all([
      prisma.quote.findUniqueOrThrow({ where: { id: quotes.REC.id } }),
      prisma.quote.findUniqueOrThrow({ where: { id: quotes.REQ.id } }),
    ]);
    expect(rec.status).toBe("QUOTED");
    expect(req.status).toBe("REQUOTED");
    const updatedLeg = await prisma.leg.findUniqueOrThrow({ where: { id: leg.id } });
    expect(updatedLeg.status).toBe("FULLY_QUOTED");

    // The still-QUOTED offer on the SAME leg remains sendable — this guard is about the NAMED
    // offer's own freshness, not a blanket freeze of the leg. REQ is still genuinely
    // REQUOTED/outstanding on this leg (the earlier 409 never touched it), so A9 correctly still
    // requires its own override for THIS send too — proving the two guards are independent, not
    // that CRITICAL 2 subsumes A9.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({
        quoteId: quotes.REC.id,
        variant: "DEDICATED",
        proceedWithoutWaiting: true,
        proceedReason: "REC is fine, don't need to wait on the other forwarder's re-quote",
      })
      .expect(200);
  });
});
