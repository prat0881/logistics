process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import { QuoteEvent, Role, ACCESS_TOKEN_COOKIE, type QuoteDraft } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { StatusService } from "../src/modules/status/status.service";
import { seedReferenceData } from "../src/seed/reference-seed";

// S5.9.2 Task 1 (Q1/Q2/Q3, register C7) — a re-quote must WALK THE LEG BACKWARDS to the status
// its quotes actually justify, and the query must follow.
//
// Before this task, asking a forwarder to sharpen a price moved nothing: `rollupLegTarget`
// already excluded REQUOTED from LEG_ROLLUP_RESOLVED (so it already returned PARTIALLY_QUOTED or
// null for a re-quoted leg), but `LegQuoteProjector.recomputeLeg`'s never-walk-backwards backstop
// (`leg.status === RFQ_SENT`) discarded that answer — the leg kept reading "Fully Quoted" and the
// query "Quoted" while we were in fact waiting on a forwarder again.
//
// The second half of this file is the guard interaction Q1 breaks and Q3 repairs. A leg sent via
// A9's "proceed without waiting" hatch used to leave FULLY_QUOTED, which `approve()` reads back
// off the immutable StatusTransition row (`legStatusWhenSentForApproval`) as its second
// "is this leg fully quoted?" term. After Q1 the same leg leaves PARTIALLY_QUOTED, so that term
// stops covering the case and approve would 409 forever — exactly the Critical the last
// whole-branch review found. Q3 gives approve a THIRD, narrower term: the send was an explicit,
// recorded proceed-without-waiting override. Deliberately NOT added to
// `isFullyQuotedForDecision` itself, because reject() uses that to pick its return target and
// must still return a fallen-back leg to PARTIALLY_QUOTED, never a promoted FULLY_QUOTED.
const PREFIX = "AWRF";
const CODE = `YAL00-${PREFIX}`;

type FfSpec = {
  key: string;
  status: "QUOTED" | "RFQ_SENT" | "REQUOTED" | "APPROVED";
  deadline?: Date;
  draft?: { amount: number; transitDays: number };
};

describe(`${PREFIX} — a re-quote walks the leg back (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let status: StatusService;

  const cookieFor = (userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role: Role.EXECUTIVE, tenantId: null })}`;
  const managerCookieFor = (userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role: Role.MANAGER, tenantId: null })}`;

  const future = () => new Date(Date.now() + 86400000);

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

  // Minimal ROAD draft, priced only on DEDICATED — same shape as
  // award-workflow-maker.e2e-spec.ts, so computeQuoteTotals yields exactly one comparable offer.
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

  async function seedLeg(
    label: string,
    legStatus: string,
    ffs: FfSpec[],
    opts: { decisionStatus?: "DRAFT" | "PENDING_APPROVAL" | "APPROVED"; shortlistKey?: string } = {},
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

    const quotes: Record<string, { id: string; ffId: string; rfqId: string }> = {};
    for (const ff of ffs) {
      const ffRow = await mkFf(`FF-${PREFIX}-${label}-${ff.key}`);
      const rfq = await prisma.rfq.create({
        data: {
          queryId: query.id,
          freightForwarderId: ffRow.id,
          rfqNumber: `${CODE}-RFQ-${label}-${ff.key}`,
          accessTokenHash: `hash-${PREFIX}-${label}-${ff.key}`,
          submissionDeadline: ff.deadline ?? future(),
          incoterms: "FOB",
          currency: "INR",
          quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
        },
      });
      const quote = await prisma.quote.create({
        data: {
          queryId: query.id,
          legId: leg.id,
          freightForwarderId: ffRow.id,
          rfqId: rfq.id,
          status: ff.status as never,
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
      quotes[ff.key] = { id: quote.id, ffId: ffRow.id, rfqId: rfq.id };
    }

    if (opts.decisionStatus) {
      await prisma.legAwardDecision.create({
        data: {
          legId: leg.id,
          queryId: query.id,
          shortlistedQuoteId: opts.shortlistKey ? quotes[opts.shortlistKey].id : null,
          shortlistedVariant: opts.shortlistKey ? "DEDICATED" : null,
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

    return { query, leg, origin, dest, quotes };
  }

  const requote = (queryId: string, legId: string, quoteId: string, userId = randomUUID()) =>
    request(app.getHttpServer())
      .post(`/api/queries/${queryId}/legs/${legId}/quotes/${quoteId}/request-requote`)
      .set("Cookie", cookieFor(userId))
      .send({ comment: "Please sharpen this rate" });

  const legStatus = async (legId: string) =>
    (await prisma.leg.findUniqueOrThrow({ where: { id: legId } })).status;
  const queryStatus = async (queryId: string) =>
    (await prisma.query.findUniqueOrThrow({ where: { id: queryId } })).status;

  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    const qIds = qs.map((q) => q.id);
    const legs = await prisma.leg.findMany({
      where: { queryId: { in: qIds } },
      select: { id: true },
    });
    const legIds = legs.map((l) => l.id);
    const quoteRows = await prisma.quote.findMany({
      where: { queryId: { in: qIds } },
      select: { id: true },
    });
    const rfqs = await prisma.rfq.findMany({
      where: { queryId: { in: qIds } },
      select: { id: true },
    });
    const rfqIds = rfqs.map((r) => r.id);
    if (rfqIds.length) {
      await prisma.scheduledEvent.deleteMany({
        where: { entityType: "RFQ", entityId: { in: rfqIds } },
      });
      await prisma.messageLog.deleteMany({ where: { entityType: "RFQ", entityId: { in: rfqIds } } });
    }
    // StatusTransition has no FK — the Query cascade never touches it (see
    // leg-rollup-approved.e2e-spec.ts's cleanup for the same sweep).
    await prisma.statusTransition.deleteMany({
      where: {
        OR: [
          { entity: "leg", entityId: { in: legIds } },
          { entity: "quote", entityId: { in: quoteRows.map((q) => q.id) } },
        ],
      },
    });
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
    status = moduleRef.get(StatusService);
    await seedReferenceData(prisma);
    await cleanup();
    await prisma.fxRate.create({ data: { currency: "INR", unitsPerUsd: 83.2, note: PREFIX } });
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  // ── Q1/Q2: the fallback itself ────────────────────────────────────────────────────────────

  it("(a) a re-quote with a still-QUOTED sibling walks the leg FULLY_QUOTED -> PARTIALLY_QUOTED, and the query to RFQ_SENT", async () => {
    const { query, leg, quotes } = await seedLeg("a", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "QUOTED", draft: { amount: 90000, transitDays: 4 } },
    ]);
    // Baseline — the query only reaches QUOTED once something recomputes it; drive that off the
    // real projector rather than asserting a seeded value.
    await requote(query.id, leg.id, quotes.REQ.id).expect(200);

    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");
    // Q2 — no query-side change was needed: deriveQueryStatus already maps PARTIALLY_QUOTED to
    // QueryStatus.RFQ_SENT, and query status is a projection off the leg rollup.
    expect(await queryStatus(query.id)).toBe("RFQ_SENT");
  });

  it("(b) a re-quote on a leg whose ONLY quote was re-quoted walks it FULLY_QUOTED -> RFQ_SENT, query RFQ_SENT", async () => {
    const { query, leg, quotes } = await seedLeg("b", "FULLY_QUOTED", [
      { key: "ONLY", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
    ]);

    await requote(query.id, leg.id, quotes.ONLY.id).expect(200);

    // rollupLegTarget([REQUOTED]) is `null` ("nothing to say"), NOT RFQ_SENT — the projector maps
    // "a re-quote left nothing comparable" onto RFQ_SENT itself.
    expect(await legStatus(leg.id)).toBe("RFQ_SENT");
    expect(await queryStatus(query.id)).toBe("RFQ_SENT");
  });

  it("(h) a re-quote on the ONLY comparable offer of an already-PARTIALLY_QUOTED leg walks it to RFQ_SENT", async () => {
    // Reachable and distinct from (b): a leg that never reached FULLY_QUOTED because one FF has
    // not answered. Re-quoting its single QUOTED offer leaves nothing comparable at all.
    const { query, leg, quotes } = await seedLeg("h", "PARTIALLY_QUOTED", [
      { key: "REQ", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "SILENT", status: "RFQ_SENT" },
    ]);

    await requote(query.id, leg.id, quotes.REQ.id).expect(200);

    expect(await legStatus(leg.id)).toBe("RFQ_SENT");
    expect(await queryStatus(query.id)).toBe("RFQ_SENT");
  });

  it("(i) a re-quote against an APPROVED leg's winner walks it past FULLY_QUOTED, all the way back to RFQ_SENT", async () => {
    // The APPROVED path is NegotiationService's own: LegQuoteProjector's ROLLUP_FROZEN guard
    // skips a leg in APPROVED, so the quote fire cannot move it; `requestRequote` fires
    // REOPEN_AWARD (APPROVED -> FULLY_QUOTED) and then owns recomputing the rollup, exactly as
    // leg-quote.projector.ts's "unfreeze gap" note says the caller must. Without that second
    // step the leg would sit at FULLY_QUOTED with a REQUOTED-only quote set — the very C7
    // mismatch Q1 removes, just reached via a different door.
    const { query, leg, quotes } = await seedLeg(
      "i",
      "APPROVED",
      [{ key: "WIN", status: "APPROVED", draft: { amount: 83200, transitDays: 3 } }],
      { decisionStatus: "APPROVED", shortlistKey: "WIN" },
    );

    await requote(query.id, leg.id, quotes.WIN.id).expect(200);

    expect(await legStatus(leg.id)).toBe("RFQ_SENT");
    expect(await queryStatus(query.id)).toBe("RFQ_SENT");
  });

  it("(g) the re-quoted forwarder re-submitting rolls the leg forward to FULLY_QUOTED again, query QUOTED", async () => {
    const { query, leg, quotes } = await seedLeg("g", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "QUOTED", draft: { amount: 90000, transitDays: 4 } },
    ]);

    await requote(query.id, leg.id, quotes.REQ.id).expect(200);
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");

    // REQUOTED --submit--> QUOTED is exactly what the forwarder portal fires on a re-submission
    // (ff-portal.service.ts) — driven directly here so the test does not depend on the portal's
    // whole draft-validation surface.
    await status.fire("quote", quotes.REQ.id, QuoteEvent.SUBMIT, { queryId: query.id });

    expect(await legStatus(leg.id)).toBe("FULLY_QUOTED");
    expect(await queryStatus(query.id)).toBe("QUOTED");
  });

  // ── The narrowness of the backstop relaxation ─────────────────────────────────────────────

  it("(j) NOTHING but a re-quote may walk a leg backwards — a straggler submitting on a FULLY_QUOTED leg that already holds a REQUOTED sibling leaves the leg exactly where it is", async () => {
    // This is the mutation discriminator for Step 4's narrowing. The leg's quotes justify only
    // PARTIALLY_QUOTED (rollupLegTarget([QUOTED, REQUOTED, QUOTED]) === PARTIALLY_QUOTED), and
    // the recompute is triggered by a quote.status.changed event — but that event is a SUBMIT,
    // not a re-quote, so the never-walk-backwards backstop must still discard the answer. Drop
    // the "was this recompute triggered by a re-quote?" condition and this leg falls to
    // PARTIALLY_QUOTED and the test goes red.
    const { query, leg, quotes } = await seedLeg("j", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "STALE", status: "REQUOTED", draft: { amount: 90000, transitDays: 4 } },
      { key: "LATE", status: "RFQ_SENT" },
    ]);

    await status.fire("quote", quotes.LATE.id, QuoteEvent.SUBMIT, { queryId: query.id });

    expect(await legStatus(leg.id)).toBe("FULLY_QUOTED");
  });

  // ── Q3: the send/approve/reject guard interaction ─────────────────────────────────────────

  it("(f) without the explicit override, sending a fallen-back leg is still refused and nothing is persisted", async () => {
    const { query, leg, quotes } = await seedLeg("f", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "QUOTED", draft: { amount: 90000, transitDays: 4 } },
    ]);
    await requote(query.id, leg.id, quotes.REQ.id).expect(200);
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.KEEP.id, variant: "DEDICATED" })
      .expect(400);

    expect(await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } })).toBeNull();
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: quotes.KEEP.id } })).status,
    ).toBe("QUOTED");
  });

  it("(c)+(d) an exec may still send a fallen-back leg with proceedWithoutWaiting + reason, and a checker can then APPROVE it", async () => {
    const { query, leg, quotes } = await seedLeg("cd", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "QUOTED", draft: { amount: 90000, transitDays: 4 } },
    ]);
    await requote(query.id, leg.id, quotes.REQ.id).expect(200);
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");

    const senderId = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId))
      .send({
        quoteId: quotes.KEEP.id,
        variant: "DEDICATED",
        proceedWithoutWaiting: true,
        proceedReason: "Client needs the number today",
      })
      .expect(200);

    expect(await legStatus(leg.id)).toBe("PENDING_APPROVAL");

    // The leg LEFT PARTIALLY_QUOTED, not FULLY_QUOTED — so approve()'s transition-log term is
    // false here and only the recorded override keeps this approval reachable.
    const sendRow = await prisma.statusTransition.findFirst({
      where: { entity: "leg", entityId: leg.id, to: "PENDING_APPROVAL" },
      orderBy: { seq: "desc" },
    });
    expect(sendRow?.from).toBe("PARTIALLY_QUOTED");

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", managerCookieFor(randomUUID())) // four-eyes: not senderId
      .send()
      .expect(200);

    expect(await legStatus(leg.id)).toBe("APPROVED");
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: quotes.KEEP.id } })).status,
    ).toBe("APPROVED");
    // A9 licensed proceeding PAST the re-quote, not resolving it.
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: quotes.REQ.id } })).status,
    ).toBe("REQUOTED");
  });

  it("(e) rejecting an override-sent leg returns it to PARTIALLY_QUOTED, NOT a promoted FULLY_QUOTED", async () => {
    const { query, leg, quotes } = await seedLeg("e", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "QUOTED", draft: { amount: 90000, transitDays: 4 } },
    ]);
    await requote(query.id, leg.id, quotes.REQ.id).expect(200);

    const senderId = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId))
      .send({
        quoteId: quotes.KEEP.id,
        variant: "DEDICATED",
        proceedWithoutWaiting: true,
        proceedReason: "Client needs the number today",
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", managerCookieFor(randomUUID()))
      .send({ reason: "Let's see what the re-quote comes back with" })
      .expect(200);

    // reject() asks `isFullyQuotedForDecision`, which the Q3 override term is deliberately kept
    // OUT of: both of its terms are false here (live rollup is null, the leg left
    // PARTIALLY_QUOTED), so the leg returns to PARTIALLY_QUOTED. Adding the override term to the
    // shared predicate would promote it to FULLY_QUOTED and leak back the very mismatch Q1
    // removes.
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");
    expect(await queryStatus(query.id)).toBe("RFQ_SENT");
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: quotes.KEEP.id } })).status,
    ).toBe("QUOTED");
    const decision = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: leg.id } });
    expect(decision.status).toBe("DRAFT");

    // …and the recovery path still works: the maker can re-send with a fresh override.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({
        quoteId: quotes.KEEP.id,
        variant: "DEDICATED",
        proceedWithoutWaiting: true,
        proceedReason: "Still cannot wait — re-sending after the rejection",
      })
      .expect(200);
  });

  it("(k) the override widens approve ONLY for a send that actually carried it — an A3 deadline-passed send of an equally not-fully-quoted leg is still refused", async () => {
    // The narrowness discriminator for Step 5. Same shape of leg (PARTIALLY_QUOTED, a
    // PENDING_APPROVAL shortlist and one unresolved sibling), reached WITHOUT any
    // proceed-without-waiting: the straggler simply never answered before its window closed.
    // approve() must still 409. Widen the guard past the recorded override — e.g. by dropping
    // the FULLY_QUOTED question entirely, or by keying the override off the mere presence of a
    // SEND_FOR_APPROVAL event — and this goes green when it must not.
    const past = new Date(Date.now() - 3600000);
    const { query, leg, quotes } = await seedLeg("k", "PARTIALLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", deadline: past, draft: { amount: 83200, transitDays: 3 } },
      { key: "SILENT", status: "RFQ_SENT", deadline: past },
    ]);

    const senderId = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId))
      .send({ quoteId: quotes.KEEP.id, variant: "DEDICATED" })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", managerCookieFor(randomUUID()))
      .send()
      .expect(409);

    expect(await legStatus(leg.id)).toBe("PENDING_APPROVAL");
  });

  it("(l) the override waives ONLY the re-quotes — an open RFQ window on a THIRD forwarder still refuses the send", async () => {
    // A3's own narrowness. proceedWithoutWaiting is licence to proceed past an in-flight
    // RE-QUOTE (A9), never past a forwarder who simply has not answered yet and whose window is
    // still open. Filter the whole outstanding set on the override instead of just its REQUOTED
    // members and this goes green when it must not.
    const { query, leg, quotes } = await seedLeg("l", "PARTIALLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "REQUOTED", draft: { amount: 90000, transitDays: 4 } },
      { key: "OPEN", status: "RFQ_SENT", deadline: future() },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({
        quoteId: quotes.KEEP.id,
        variant: "DEDICATED",
        proceedWithoutWaiting: true,
        proceedReason: "cannot wait",
      })
      .expect(400);

    expect(await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } })).toBeNull();
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");
  });
});
