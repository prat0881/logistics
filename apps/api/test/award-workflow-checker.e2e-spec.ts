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
import { StatusService } from "../src/modules/status/status.service";

// S5.4 Task 3 — the CHECKER half of the maker-checker award workflow (design §9 steps 2+4):
// POST .../legs/:legId/approve and POST .../legs/:legId/reject, both Manager+
// (@Roles(ADMINISTRATOR, MANAGER)) plus a four-eyes rule (the sender may not decide their own
// send). Setup is driven through the REAL maker endpoint (send-for-approval, S5.9 Task 3's
// single merged call — it names the offer AND sends it in one request; the old two-call
// PUT .../shortlist + POST .../send-for-approval shape is retired) so a PENDING_APPROVAL
// decision is reached honestly, exactly like a live workflow would produce it.
//
// S5.9 Task 3 CARRY-FORWARD (progress.md) / CLOSED BY TASK 4 — until Task 4 landed, approve()
// still guarded on the retired `leg.status !== LegStatus.FULLY_QUOTED` check (award.service.ts),
// which Task 3's sendForApproval made unconditionally true (it advances the leg straight to
// PENDING_APPROVAL as part of send) — every approve() 409'd before ever reaching the
// QuoteEvent.APPROVE fire. reject() had the mirrored gap: it fired no QUOTED/PENDING_APPROVAL ->
// RETURN(_FULL/_PARTIAL) edges at all, so a rejected leg's quote/leg rows stayed stuck at
// PENDING_APPROVAL instead of reverting. Task 4 rewrote approve() to ask the quotes directly (via
// the shared `rollupLegTarget` rule, D4) and gave reject() its RETURN/RETURN_FULL/RETURN_PARTIAL
// fires, choosing between the latter two with that same rule so a leg sent from PARTIALLY_QUOTED
// via the A3 deadline-passed path returns to PARTIALLY_QUOTED, not a promoted FULLY_QUOTED.
//
// The "reject (by a different Manager) -> ..." test below used to be wrapped in `it.failing()`
// (review round 2, IMPORTANT 4): every assertion in it was written at DESIGN INTENT for what
// Task 4 should make true, so it failed on purpose and `it.failing()` reported that as a healthy
// pass rather than a fourth red entry. Task 4's fix made those assertions genuinely true, which
// is exactly the "Failing test passed even though it was supposed to fail" signal `it.failing()`
// promises for that moment — the `.failing` marker has been removed and it now runs as a normal
// green test, guarding the behaviour going forward.
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
  const past = () => new Date(Date.now() - 3600000);

  // Drives the REAL maker endpoint (S5.9 Task 3's single send-for-approval call — names the
  // offer and sends it in one request) to reach PENDING_APPROVAL honestly. Names the
  // recommended (only comparable) offer by default so A2's override-reason requirement never
  // fires. Sender is a MANAGER (Manager ⊇ Executive's auth-only routes) so `sentByUserId` can
  // double as the four-eyes actor under test. `legStatus` defaults to FULLY_QUOTED (the
  // ordinary path) but can be overridden to PARTIALLY_QUOTED to exercise the A3 deadline-passed
  // path — send-for-approval allows that, so a PENDING_APPROVAL decision can legitimately sit on
  // top of a leg that never itself reached FULLY_QUOTED.
  async function seedPendingApproval(
    label: string,
    senderId: string,
    ffs: FfSpec[] = [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
    ],
    legStatus: string = "FULLY_QUOTED",
  ) {
    const { query, leg, quotes } = await seedLeg(label, legStatus, ffs);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId, Role.MANAGER))
      .send({ quoteId: quotes.REC.id, variant: "DEDICATED" })
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

  it("a different Manager approves -> 200 + quote APPROVED + leg APPROVED + decision APPROVED + an APPROVE event, quote fired before leg", async () => {
    const senderId = randomUUID(); // M1
    const approverId = randomUUID(); // M2 — distinct from the sender
    const { query, leg, quotes } = await seedPendingApproval("happy", senderId);

    // Fire ORDER is load-bearing (award.service.ts's approve() comment) but both orderings
    // converge on the same final DB state — the wrong order only differs by a caught+logged
    // illegal transition attempt inside the projector, which leaves no row to assert on. A
    // call-order spy is the only thing that actually pins the order a future refactor could
    // silently swap. `fire` calls through to the real implementation by default.
    const fireSpy = jest.spyOn(app.get(StatusService), "fire");

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(approverId, Role.MANAGER))
      .send()
      .expect(200);

    const quoteFireIdx = fireSpy.mock.calls.findIndex(
      (call) => call[0] === "quote" && call[2] === "approve",
    );
    const legFireIdx = fireSpy.mock.calls.findIndex(
      (call) => call[0] === "leg" && call[2] === "approve",
    );
    expect(quoteFireIdx).toBeGreaterThanOrEqual(0);
    expect(legFireIdx).toBeGreaterThanOrEqual(0);
    expect(quoteFireIdx).toBeLessThan(legFireIdx);
    fireSpy.mockRestore();

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

    // Body content is asserted (not just the status code) so this can't be confused with the
    // RolesGuard's plain "Insufficient role" 403 (the Executive-blocked case above).
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(senderId, Role.MANAGER)) // same id that sent it
      .send()
      .expect(403);
    expect(res.body.message).toBe("SELF_APPROVAL");

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL"); // untouched
  });

  it("task-4 review Round 3 FIX #3 — the same Manager who sent -> 403 SELF_APPROVAL on reject too", async () => {
    const senderId = randomUUID();
    const { query, leg } = await seedPendingApproval("selfreject", senderId);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", cookieFor(senderId, Role.MANAGER)) // same id that sent it
      .send({ reason: "irrelevant — SELF_APPROVAL blocks before this is read" })
      .expect(403);
    expect(res.body.message).toBe("SELF_APPROVAL");

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

  // S5.9 Task 3 review round 2, IMPORTANT 4 — this test used to pin two CONTRADICTORY intents in
  // one always-red test: mid-test assertions at then-actual (broken) behaviour (quote/leg still
  // PENDING_APPROVAL — reject() didn't revert them) alongside a final assertion at design intent
  // (re-send succeeds, 200) that could only pass once reject() DID revert them — so the test
  // could never go green either way. It was rewritten with EVERY assertion at design intent
  // (§9.5 + task-4-brief.md's own "returns a rejected leg to FULLY_QUOTED and its quote to
  // QUOTED" test) and temporarily wrapped in `it.failing()` while that was still untrue.
  //
  // S5.9 TASK 4 — `it.failing()` reported "Failing test passed even though it was supposed to
  // fail" the moment reject()'s RETURN/RETURN_FULL/RETURN_PARTIAL fires landed and made this
  // body genuinely succeed, exactly the flip Jest's own docs promise for that marker. The
  // `.failing` is removed below and this now runs as a plain, green test guarding the behaviour.
  it("reject (by a different Manager) -> decision DRAFT + quote back to QUOTED + leg back to FULLY_QUOTED + a REJECT event, then a re-send by an Executive succeeds again", async () => {
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

    // reject() fires QuoteEvent.RETURN and LegEvent.RETURN_FULL/RETURN_PARTIAL (picking the
    // rollup-justified target via the shared rollupLegTarget rule, not a hard-coded FULLY_QUOTED
    // — D4) after committing the decision write, so a rejected leg's quote/leg genuinely go back
    // to QUOTED/FULLY_QUOTED rather than staying wedged at PENDING_APPROVAL.
    const quote = await prisma.quote.findUnique({ where: { id: quotes.REC.id } });
    expect(quote?.status).toBe("QUOTED");

    const updatedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(updatedLeg?.status).toBe("FULLY_QUOTED");

    const events = await prisma.awardDecisionEvent.findMany({
      where: { legId: leg.id, type: "REJECT" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("Price looks stale, please re-confirm with the forwarder");
    expect(events[0].actorId).toBe(rejectorId);

    // Re-enablement (§9.5): the maker can send-for-approval again straight from this reset
    // DRAFT, once the leg/quote are genuinely back where a fresh send expects them.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID(), Role.EXECUTIVE))
      .send({ quoteId: quotes.REC.id, variant: "DEDICATED" })
      .expect(200);

    const resent = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(resent?.status).toBe("PENDING_APPROVAL");
  });

  it("approve when not PENDING_APPROVAL (a fresh DRAFT decision, never sent) -> 409", async () => {
    const { query, leg, quotes } = await seedLeg("notpending", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
    ]);

    // A bare DRAFT decision (a name picked, never sent) can no longer be produced by any HTTP
    // call — S5.9 Task 3 merged shortlist into send-for-approval, and a guard failure there
    // rolls the whole selection back rather than leaving a DRAFT behind. Seed it directly to
    // exercise requireDecidable's own `status !== PENDING_APPROVAL` guard in isolation.
    await prisma.legAwardDecision.create({
      data: {
        legId: leg.id,
        queryId: query.id,
        shortlistedQuoteId: quotes.REC.id,
        shortlistedVariant: "DEDICATED",
        status: "DRAFT",
      },
    });

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

  it("CRITICAL — approve/reject with a mismatched queryId in the URL (correct legId, a different real query) -> 404, no state change", async () => {
    const senderId = randomUUID();
    const { leg, quotes } = await seedPendingApproval("wrongquery", senderId);
    // A second, unrelated real Query — proves the leg lookup is scoped to (legId, queryId)
    // together, not legId alone. queryCode still starts with CODE so afterAll's cleanup() sweeps
    // it up like every other row in this spec.
    const otherQuery = await prisma.query.create({
      data: { queryCode: `${CODE}-wrongquery-OTHER`, priority: "HIGH", incoterms: "FOB" },
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${otherQuery.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(404);

    await request(app.getHttpServer())
      .post(`/api/queries/${otherQuery.id}/legs/${leg.id}/reject`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "irrelevant — should never be reached" })
      .expect(404);

    // PENDING_APPROVAL, not QUOTED — seedPendingApproval's send-for-approval call already moved
    // it there (S5.9 Task 3); both calls above 404 on the mismatched queryId before touching
    // anything, so this is simply the state send-for-approval left behind, untouched by either.
    const quote = await prisma.quote.findUnique({ where: { id: quotes.REC.id } });
    expect(quote?.status).toBe("PENDING_APPROVAL"); // untouched
    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL"); // untouched
  });

  it("CRITICAL — approve on a PARTIALLY_QUOTED leg that reached PENDING_APPROVAL via the A3 deadline-passed path -> 409, no partial commit", async () => {
    const senderId = randomUUID();
    // Mirrors the maker spec's "A3 (converse)" setup: one QUOTED offer + one FF that never
    // responded (RFQ_SENT) whose deadline has passed — send-for-approval legitimately allows
    // this, so the leg itself never becomes FULLY_QUOTED even though the decision reaches
    // PENDING_APPROVAL.
    const { query, leg, quotes } = await seedPendingApproval(
      "partial",
      senderId,
      [
        { key: "REC", status: "QUOTED", deadline: past(), draft: { amount: 83200, transitDays: 3 } },
        { key: "PENDING", status: "RFQ_SENT", deadline: past() },
      ],
      "PARTIALLY_QUOTED",
    );

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(409);

    // No partial commit: the FULLY_QUOTED guard runs before any fire, so nothing moved at all —
    // "nothing moved" means both stay exactly where seedPendingApproval's send-for-approval call
    // left them (PENDING_APPROVAL for both quote and leg, S5.9 Task 3), not their PRE-send values
    // (QUOTED / PARTIALLY_QUOTED) as this file originally asserted.
    const quote = await prisma.quote.findUnique({ where: { id: quotes.REC.id } });
    expect(quote?.status).toBe("PENDING_APPROVAL");
    const updatedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(updatedLeg?.status).toBe("PENDING_APPROVAL");
    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL");
  });

  // D4 (task-4-brief.md's own regression case) — the case a hard-coded `FULLY_QUOTED` reject
  // target gets wrong. This leg reached PENDING_APPROVAL via the A3 deadline-passed path above
  // (never itself FULLY_QUOTED — the second FF's RFQ window simply closed without a submission),
  // so rejecting it must land back on PARTIALLY_QUOTED: promoting it to FULLY_QUOTED would claim
  // every forwarder quoted when one simply timed out. reject()'s legRollupTarget picks this from
  // the SAME shared `rollupLegTarget` rule LegQuoteProjector uses, so the two can never disagree.
  it("D4 — rejects a leg that reached PENDING_APPROVAL via the A3 deadline-passed path back to PARTIALLY_QUOTED, not a promoted FULLY_QUOTED", async () => {
    const senderId = randomUUID();
    const { query, leg, quotes } = await seedPendingApproval(
      "rejectpartial",
      senderId,
      [
        { key: "REC", status: "QUOTED", deadline: past(), draft: { amount: 83200, transitDays: 3 } },
        { key: "PENDING", status: "RFQ_SENT", deadline: past() },
      ],
      "PARTIALLY_QUOTED",
    );

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "Wait for the straggler before deciding" })
      .expect(200);

    const quote = await prisma.quote.findUnique({ where: { id: quotes.REC.id } });
    expect(quote?.status).toBe("QUOTED"); // reverted off PENDING_APPROVAL

    const updatedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(updatedLeg?.status).toBe("PARTIALLY_QUOTED"); // NOT FULLY_QUOTED — the RFQ_SENT FF never quoted

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("DRAFT");
    expect(decision?.rejectionReason).toBe("Wait for the straggler before deciding");
  });

  it("reject a leg whose decision is still DRAFT (a name picked, never sent) -> 409", async () => {
    const { query, leg, quotes } = await seedLeg("rejectdraft", "FULLY_QUOTED", [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
    ]);

    // Same reasoning as the "approve when not PENDING_APPROVAL" case above — a bare DRAFT
    // decision has no HTTP path since S5.9 Task 3, so it's seeded directly.
    await prisma.legAwardDecision.create({
      data: {
        legId: leg.id,
        queryId: query.id,
        shortlistedQuoteId: quotes.REC.id,
        shortlistedVariant: "DEDICATED",
        status: "DRAFT",
      },
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "should not matter, not pending" })
      .expect(409);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("DRAFT"); // untouched
  });

  it("task-4 review Round 3 FIX #1 (now S5.9's B2 guard) — re-sending an APPROVED leg with the LOSING (still-QUOTED) offer -> 409, decision + leg untouched", async () => {
    const senderId = randomUUID(); // M1
    const approverId = randomUUID(); // M2
    // Two FFs both QUOTED — seedPendingApproval sends the "REC" one by default, leaving "LOSE"
    // as a second, genuinely valid, still-QUOTED offer nobody ever picked.
    const { query, leg, quotes } = await seedPendingApproval("reshortlist", senderId, [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "LOSE", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(approverId, Role.MANAGER))
      .send()
      .expect(200);

    // The bug scenario B2 (S5.9 Task 3) exists to close: re-send the leg naming the loser, AFTER
    // it's already been approved. overrideReason is supplied so this can only fail on B2, not
    // A2 — proving the guard order (B2 before A2) actually holds.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ quoteId: quotes.LOSE.id, variant: "DEDICATED", overrideReason: "picking the loser on purpose" })
      .expect(409);

    // Nothing moved: decision still points at the real winner, leg still APPROVED — no orphaned
    // approval, no stuck query.
    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("APPROVED");
    expect(decision?.shortlistedQuoteId).toBe(quotes.REC.id);
    const updatedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(updatedLeg?.status).toBe("APPROVED");
  });

  it("task-4 review Round 3 FIX #1 (nice-to-have, now S5.9's B2 guard) — re-sending a PENDING_APPROVAL leg (sent, not yet decided) -> 409, decision untouched", async () => {
    const senderId = randomUUID();
    const { query, leg, quotes } = await seedPendingApproval("reshortlistpending", senderId, [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "OTH", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ quoteId: quotes.OTH.id, variant: "DEDICATED" })
      .expect(409);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL");
    expect(decision?.shortlistedQuoteId).toBe(quotes.REC.id); // unchanged
  });

  // S5.9 Task 4 — approve()/reject() now take the SAME leg lock sendForApproval does (lockLeg),
  // closing a real gap: before this task neither method took any lock at all, so an approve and
  // a reject racing on the same leg were unserialized under READ COMMITTED — both could read
  // PENDING_APPROVAL before either had written anything, both pass requireDecidable's own
  // guards, and both commit + fire their own status transitions, leaving the quote/leg/decision
  // in whatever order the two independent post-commit fires happened to land — potentially a
  // mix of both outcomes (e.g. quote APPROVED but leg reverted to FULLY_QUOTED). Mirrors
  // award-workflow-maker.e2e-spec.ts's own "CRITICAL 1 — two concurrent sends" test.
  it("CRITICAL — approve and reject racing on the same leg: exactly one wins, the other 409s, and the DB lands in ONE coherent state (never a mix of both outcomes)", async () => {
    const senderId = randomUUID();
    const approverId = randomUUID();
    const rejectorId = randomUUID();
    const { query, leg, quotes } = await seedPendingApproval("racecheck", senderId);

    // Fired via Promise.all (not sequential awaits) so both requests are genuinely in flight at
    // once — each reaches its own `$transaction` and `lockLeg`'s `SELECT ... FOR UPDATE` before
    // either commits.
    const [approveRes, rejectRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
        .set("Cookie", cookieFor(approverId, Role.MANAGER))
        .send(),
      request(app.getHttpServer())
        .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
        .set("Cookie", cookieFor(rejectorId, Role.MANAGER))
        .send({ reason: "racing on purpose" }),
    ]);

    // Exactly one winner, exactly one loser — lockLeg fully serializes the two: the second to
    // reach the lock blocks until the first transaction commits or rolls back, then its own
    // requireDecidable read sees the real, already-decided outcome (decision.status is no
    // longer PENDING_APPROVAL) and 409s cleanly, before writing anything of its own.
    const responses = [approveRes, rejectRes];
    const winners = responses.filter((r) => r.status === 200);
    const losers = responses.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const [decision, quote, updatedLeg] = await Promise.all([
      prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: leg.id } }),
      prisma.quote.findUniqueOrThrow({ where: { id: quotes.REC.id } }),
      prisma.leg.findUniqueOrThrow({ where: { id: leg.id } }),
    ]);

    // ONE coherent outcome — either approve won (decision/quote/leg all APPROVED) or reject won
    // (decision back to DRAFT, quote/leg reverted) — never a mix, e.g. quote APPROVED while the
    // leg is still PENDING_APPROVAL/FULLY_QUOTED, or a DRAFT decision next to an APPROVED quote.
    if (approveRes.status === 200) {
      expect(decision.status).toBe("APPROVED");
      expect(quote.status).toBe("APPROVED");
      expect(updatedLeg.status).toBe("APPROVED");
    } else {
      expect(decision.status).toBe("DRAFT");
      expect(quote.status).toBe("QUOTED");
      expect(updatedLeg.status).toBe("FULLY_QUOTED");
    }
  });
});
