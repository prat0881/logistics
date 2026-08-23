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
import { NotificationDispatcher } from "../src/modules/comms/notification-dispatcher.service";

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
  // `assignedUserId` (S5.9.1 final review, I1) is optional and defaults to NULL — every test that
  // predates the reject-notification work wants the unassigned shape, which is also the fallback
  // branch. The live `POST /api/queries` always populates it (`queries.service.ts`:
  // `input.assignedUserId ?? user.userId`), which is why the notification tests set it explicitly.
  async function seedLeg(
    label: string,
    legStatus: string,
    ffs: FfSpec[],
    assignedUserId: string | null = null,
  ) {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-${label}`, priority: "HIGH", incoterms: "FOB", assignedUserId },
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
    assignedUserId: string | null = null,
  ) {
    const { query, leg, quotes } = await seedLeg(label, legStatus, ffs, assignedUserId);

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
    // S5.9.1 Task 4 — Executive users this file creates itself (mkExec below) for the
    // award.rejected notification tests, mirroring ff-portal.e2e-spec.ts's own pattern rather
    // than relying on the shared dev DB's seeded exec@svyft.local (absent in a fresh CI Postgres,
    // which never runs `prisma db seed`).
    await prisma.user.deleteMany({ where: { email: { startsWith: `${PREFIX.toLowerCase()}-exec-` } } });
  };

  // Every user this file creates shares the `awck-exec-` email prefix `cleanup` deletes on, whatever
  // its role or active flag — the non-Executive and inactive rows exist only to prove the
  // broadcast's `role`/`isActive` filters are load-bearing (S5.9.1 final review, I2: dropping
  // either filter passed before these were added).
  const mkUser = (opts: { role?: "EXECUTIVE" | "MANAGER"; isActive?: boolean } = {}) =>
    prisma.user.create({
      data: {
        name: "AWCK Exec",
        email: `${PREFIX.toLowerCase()}-exec-${randomUUID()}@e2e.test`,
        passwordHash: "x",
        role: opts.role ?? "EXECUTIVE",
        isActive: opts.isActive ?? true,
      },
    });

  const mkExec = () => mkUser();

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
    // No template reseed here any more (S5.9.1 final review, I2): the "comms failure never fails
    // reject" test no longer deletes `award.rejected.inapp` — it mocks the dispatch to throw, which
    // is the only version of that test that actually enters reject()'s catch — so this file leaves
    // the shared MessageTemplate rows untouched and needs no repair step.
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

  // S5.9 Task 4 review round — IMPORTANT 1. The original single-quote fixture couldn't reach A8
  // at all: flipping the ONLY quote on the leg to REQUOTED makes `legRollupTarget(["REQUOTED"])`
  // return `null` (REQUOTED isn't "resolved" — status.ts's LEG_ROLLUP_RESOLVED), so the EARLIER
  // guard at approve()'s `legRollupTarget !== FULLY_QUOTED` check 409s first and A8's own check
  // (`quote.status !== PENDING_APPROVAL`) is never reached — mutation-proven: deleting A8
  // entirely left this test green. A8 is only reachable once the rollup still says FULLY_QUOTED
  // (every quote "resolved") but the SPECIFICALLY SHORTLISTED quote isn't PENDING_APPROVAL any
  // more — e.g. it moved to APPROVED/EXPIRED/CLOSED while a sibling FF is still QUOTED. Two FFs
  // here (mirrors the "reshortlist" test's fixture below): REC (the shortlisted, sent one) and
  // OTH (a second live QUOTED offer, left untouched) — flipping REC alone to a resolved-but-not-
  // PENDING_APPROVAL status keeps the rollup at FULLY_QUOTED (both count as "resolved") so the
  // earlier guard passes and A8 is the one that actually fires.
  it("A8 — approve when the shortlisted quote is no longer PENDING_APPROVAL (stale) -> 409", async () => {
    const senderId = randomUUID();
    const { query, leg, quotes } = await seedPendingApproval("stale", senderId, [
      { key: "REC", status: "QUOTED", deadline: future(), draft: { amount: 83200, transitDays: 3 } },
      { key: "OTH", status: "QUOTED", deadline: future(), draft: { amount: 166400, transitDays: 5 } },
    ]);

    // Simulate a concurrent change (e.g. the quote independently resolving elsewhere) moving the
    // SHORTLISTED quote off PENDING_APPROVAL, without going through StatusService (this test only
    // needs the DB row to reflect "no longer PENDING_APPROVAL", not a legal transition).
    await prisma.quote.update({ where: { id: quotes.REC.id }, data: { status: "EXPIRED" } });

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

  // S5.9 Task 4 review round — IMPORTANT 2: requireDecidable used to reach the leg through a
  // typed `prisma.leg.findFirst`, which Prisma's own client-side validation rejects with a 400
  // ("Invalid identifier", via PrismaExceptionFilter's P2023 mapping) for a malformed id. Once
  // that read moved onto lockLeg's raw `${legId}::uuid`/`${queryId}::uuid` casts, a malformed id
  // reaches Postgres itself (22P02), which $queryRaw wraps in a Prisma error code
  // PrismaExceptionFilter does NOT map — falls through to a bare 500. This regressed both
  // approve() and reject() (lockLeg is the first thing either does); sendForApproval is
  // unaffected because it reaches ComparisonService.getComparison(queryId) — a typed Prisma call
  // — before it ever calls lockLeg.
  it("IMPORTANT 2 — approve/reject with a malformed (non-UUID) legId -> 400, not 500", async () => {
    const senderId = randomUUID();
    const { query } = await seedPendingApproval("malformedleg", senderId);

    const approveRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/not-a-uuid/approve`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send();
    expect(approveRes.status).toBe(400);

    const rejectRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/not-a-uuid/reject`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "irrelevant — should never be reached" });
    expect(rejectRes.status).toBe(400);
  });

  it("IMPORTANT 2 — approve/reject with a malformed (non-UUID) queryId -> 400, not 500", async () => {
    const senderId = randomUUID();
    const { leg } = await seedPendingApproval("malformedquery", senderId);

    const approveRes = await request(app.getHttpServer())
      .post(`/api/queries/not-a-uuid/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send();
    expect(approveRes.status).toBe(400);

    const rejectRes = await request(app.getHttpServer())
      .post(`/api/queries/not-a-uuid/legs/${leg.id}/reject`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "irrelevant — should never be reached" });
    expect(rejectRes.status).toBe(400);
  });

  // INVERTED (S5.9.2 Task 1 review, IMPORTANT 1). This test used to assert that approving such a
  // leg 409s, and titled that "CRITICAL … no partial commit". It was pinning a BUG as intended
  // behaviour: A3's deadline-passed arm legitimately permits this send (the maker spec's "A3
  // (converse)" test proves the send itself is a 200), and the leg could then never be approved —
  // `rollupLegTarget([PENDING_APPROVAL, RFQ_SENT])` is `null` and the transition log says
  // PARTIALLY_QUOTED, so both terms of `isFullyQuotedForDecision` were false. Rejecting recovered
  // the leg and re-sending re-reached PENDING_APPROVAL, where approve refused again: nothing
  // inside the product broke the loop, only the expiry cron — and for an INVALID sibling, nothing
  // at all, since INVALID has no `expire` edge. Same class as the Critical the final whole-branch
  // review found on A9's arm, on the arm that fix did not cover, and in direct collision with
  // S5.9.2 Task 2's premise that rejection IS the recovery path.
  //
  // The rule approve() now states: **a legally-permitted send is approvable.** `sendForApproval`
  // records WHICH arm of A3 permitted a send from a not-fully-quoted leg, on the send's own
  // immutable StatusTransition row, and approve() honours that verdict — it cannot re-derive it,
  // because `requestRequote` pushes deadlines days into the future. The narrowness counterpart
  // (a PENDING_APPROVAL that never went through the send guard carries no permission and is still
  // refused) lives in award-requote-fallback.e2e-spec.ts as "(m)", alongside the full
  // reject -> re-send -> approve walk as "(k)".
  it("approve SUCCEEDS on a PARTIALLY_QUOTED leg that reached PENDING_APPROVAL via the A3 deadline-passed path — a legally-permitted send is approvable", async () => {
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
      .expect(200);

    const quote = await prisma.quote.findUnique({ where: { id: quotes.REC.id } });
    expect(quote?.status).toBe("APPROVED");
    const updatedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(updatedLeg?.status).toBe("APPROVED");
    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("APPROVED");

    // The straggler is left exactly where it was: approval closed the leg out, it did not resolve
    // a forwarder who never answered.
    const straggler = await prisma.quote.findUnique({ where: { id: quotes.PENDING.id } });
    expect(straggler?.status).toBe("RFQ_SENT");
  });

  // S5.9 final whole-branch review, CRITICAL 1 — the CONVERSE of the test above, and the reason
  // `isFullyQuotedForDecision` keeps asking `legRollupTarget` at all rather than only reading the
  // status the leg left. Same PARTIALLY_QUOTED-via-A3 fixture, except the straggler's RFQ then
  // EXPIRES while the checker is reviewing: `rollupLegTarget([PENDING_APPROVAL, EXPIRED])` is
  // FULLY_QUOTED (both count as resolved — status.ts's LEG_ROLLUP_RESOLVED), so the leg has
  // genuinely become fully quoted and approval must be allowed even though it was SENT from
  // PARTIALLY_QUOTED. Nothing else recomputes this: `LegQuoteProjector`'s ROLLUP_FROZEN guard
  // skips any leg in PENDING_APPROVAL, so the leg row itself never catches up (the Task-2
  // "nothing recomputes the rollup when a leg leaves a frozen state" carry-forward) — the caller
  // owns the question. Without this test, deleting the live-rollup half of
  // `isFullyQuotedForDecision` as "redundant now that we read the transition log" would leave the
  // whole suite green.
  //
  // The expiry is simulated with a direct DB write (same convention as the A8 test above): only
  // the row's status matters here, not the legality of the transition that produced it.
  it("CRITICAL 1 (converse) — approve succeeds on an A3-sent PARTIALLY_QUOTED leg once the straggler's RFQ has EXPIRED, promoting the live rollup to FULLY_QUOTED", async () => {
    const senderId = randomUUID();
    const { query, leg, quotes } = await seedPendingApproval(
      "partialexpired",
      senderId,
      [
        { key: "REC", status: "QUOTED", deadline: past(), draft: { amount: 83200, transitDays: 3 } },
        { key: "PENDING", status: "RFQ_SENT", deadline: past() },
      ],
      "PARTIALLY_QUOTED",
    );

    await prisma.quote.update({ where: { id: quotes.PENDING.id }, data: { status: "EXPIRED" } });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(200);

    const quote = await prisma.quote.findUnique({ where: { id: quotes.REC.id } });
    expect(quote?.status).toBe("APPROVED");
    const updatedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(updatedLeg?.status).toBe("APPROVED");
    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("APPROVED");
  });

  // S5.9.2 Task 1 review — the live-rollup half of `isFullyQuotedForDecision` moved house. Before
  // the review's IMPORTANT 1, the test above pinned it: approve() needed the rollup to promote an
  // A3-sent leg once its straggler expired. approve() no longer does — the send's own recorded
  // permission carries that case now — so the live-rollup term would be silently deletable if
  // nothing else exercised it. It IS still load-bearing, on the OTHER caller: reject() uses the
  // same predicate to choose RETURN_FULL vs RETURN_PARTIAL, and a leg whose straggler expired
  // during review genuinely IS fully quoted by then, so rejecting it must land on FULLY_QUOTED,
  // not send it back to the PARTIALLY_QUOTED it left. That is the converse of the D4 test below —
  // same fixture, opposite outcome, and the difference is entirely the live rollup.
  it("reject on an A3-sent PARTIALLY_QUOTED leg whose straggler EXPIRED during review lands on FULLY_QUOTED — the live rollup, not the status it left", async () => {
    const senderId = randomUUID();
    const { query, leg, quotes } = await seedPendingApproval(
      "rejectexpired",
      senderId,
      [
        { key: "REC", status: "QUOTED", deadline: past(), draft: { amount: 83200, transitDays: 3 } },
        { key: "PENDING", status: "RFQ_SENT", deadline: past() },
      ],
      "PARTIALLY_QUOTED",
    );

    // Same simulation as the converse test above: only the row's status matters here.
    await prisma.quote.update({ where: { id: quotes.PENDING.id }, data: { status: "EXPIRED" } });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "Different forwarder, please" })
      .expect(200);

    const updatedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
    // NOT PARTIALLY_QUOTED (the status it left): nothing is outstanding any more.
    expect(updatedLeg?.status).toBe("FULLY_QUOTED");
    const quote = await prisma.quote.findUnique({ where: { id: quotes.REC.id } });
    expect(quote?.status).toBe("QUOTED");
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

  // S5.9 Task 4 review round — IMPORTANT 3. Mirrors the A8 test above, but for reject(): if the
  // shortlisted quote has moved off PENDING_APPROVAL since it was sent (e.g. a racing
  // change-order invalidated it — see reject()'s own doc comment), reject() must refuse (409)
  // BEFORE writing anything, not commit the decision to DRAFT and then blow up trying to fire a
  // now-illegal quote transition. Simulates the race the same way the A8 test does — a direct DB
  // write, not through StatusService, since only the DB row's shape (not a legal transition)
  // matters for exercising this guard in isolation.
  it("IMPORTANT 3 — reject when the shortlisted quote is no longer PENDING_APPROVAL (raced by e.g. a change-order) -> 409, nothing moves", async () => {
    const senderId = randomUUID();
    const { query, leg, quotes } = await seedPendingApproval("rejectstale", senderId);

    await prisma.quote.update({ where: { id: quotes.REC.id }, data: { status: "INVALID" } });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "should not matter — refused before any write" })
      .expect(409);

    // Nothing moved: decision still PENDING_APPROVAL (not DRAFT — the half-committed hazard this
    // guard exists to prevent), leg still PENDING_APPROVAL (never fired), quote left exactly as
    // the test set it (INVALID — reject() never touched it).
    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision?.status).toBe("PENDING_APPROVAL");
    const updatedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(updatedLeg?.status).toBe("PENDING_APPROVAL");
    const quote = await prisma.quote.findUnique({ where: { id: quotes.REC.id } });
    expect(quote?.status).toBe("INVALID");
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

  // S5.9.1 Task 4 (R7), CORRECTED by the final whole-branch review (I1) — a rejected leg is
  // workable again (sentByUserId cleared, decision back to DRAFT) but nothing announced it. The
  // announcement goes to the query's ASSIGNED user (`Query.assignedUserId`, written on every query
  // create), exactly as ff-portal.service.ts / rfq-schedule.listener.ts / rfq-notifications.service
  // resolve the same question; the all-active-Executives broadcast is only the fallback for a query
  // with no assignee. Task 4 shipped the fallback half alone, on the false premise that this schema
  // has no assignment concept, so every rejection notified every Executive across every tenant.
  it("notifies the query's ASSIGNED executive — and only them, never the whole Executive pool", async () => {
    const senderId = randomUUID();
    const rejectorId = randomUUID();
    const assignee = await mkExec();
    // An active Executive who is NOT the assignee — the recipient the broadcast would have added,
    // and the one this test exists to prove is left alone.
    const otherExec = await mkExec();
    const { query, leg } = await seedPendingApproval(
      "assigned",
      senderId,
      undefined,
      "FULLY_QUOTED",
      assignee.id,
    );

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", cookieFor(rejectorId, Role.MANAGER))
      .send({ reason: "Transit too long" })
      .expect(200);

    const notes = await prisma.notification.findMany({
      where: { type: "award.rejected", entityId: query.id },
    });
    // EXACTLY one recipient, and it is the assignee — not "the assignee is among them", which the
    // broadcast would also satisfy.
    expect(notes.map((n) => n.recipientUserId)).toEqual([assignee.id]);
    expect(notes.map((n) => n.recipientUserId)).not.toContain(otherExec.id);
  });

  it("falls back to every active Executive only when the query has no assigned user", async () => {
    const senderId = randomUUID();
    const rejectorId = randomUUID();
    const exec = await mkExec();
    // The two rows that make the `role`/`isActive` filters load-bearing: before these, dropping
    // either from the `user.findMany` in reject() left the suite green (I2).
    const inactiveExec = await mkUser({ isActive: false });
    const manager = await mkUser({ role: "MANAGER" });
    const { query, leg } = await seedPendingApproval("notify", senderId); // assignedUserId = null

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", cookieFor(rejectorId, Role.MANAGER))
      .send({ reason: "Transit too long" })
      .expect(200);

    const notes = await prisma.notification.findMany({
      where: { type: "award.rejected", entityId: query.id },
    });
    const recipients = notes.map((n) => n.recipientUserId);
    expect(recipients).toContain(exec.id); // THIS Executive, seeded by this test
    expect(recipients).not.toContain(inactiveExec.id); // `isActive: true`
    expect(recipients).not.toContain(manager.id); // `role: EXECUTIVE`
    // Replaces a schema tautology (`every(n => n.recipientUserId != null)` — the column is NOT
    // NULL, so it could never fail). This one is load-bearing: it fails if the tokens block stops
    // supplying Leg_Code/Query_Code/Reason, because renderTemplate leaves the raw `{{…}}` behind.
    const note = notes.find((n) => n.recipientUserId === exec.id)!;
    expect(note.message).toContain(query.queryCode);
    expect(note.message).toContain("L1");
    expect(note.message).toContain("Transit too long");
    expect(note.message).not.toContain("{{");
  });

  it("still rejects successfully when the notification dispatch THROWS", async () => {
    const senderId = randomUUID();
    const rejectorId = randomUUID();
    const { query, leg } = await seedPendingApproval("notifyfail", senderId);

    // A GENUINE throw (S5.9.1 final review, I2). This test used to delete the
    // `award.rejected.inapp` template row instead — but `NotificationDispatcher.dispatch` treats a
    // null template lookup as "nothing to send" and returns normally
    // (notification-dispatcher.service.ts), so the `catch` was never entered and deleting the whole
    // comms block (or just its try/catch) left the test green. Mocking the dispatch to reject is
    // what actually exercises the guarantee this test claims — and it needs no template deletion,
    // so the afterAll reseed that deletion required is gone too.
    const dispatchSpy = jest
      .spyOn(app.get(NotificationDispatcher), "dispatch")
      .mockRejectedValueOnce(new Error("boom"));

    // Read the call count BEFORE restoring: `mockRestore()` resets the mock's recorded calls as
    // well as putting the real method back, so asserting on the spy afterwards reads zero.
    let dispatchCalls = -1;
    try {
      await request(app.getHttpServer())
        .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
        .set("Cookie", cookieFor(rejectorId, Role.MANAGER))
        .send({ reason: "Price too high" })
        .expect(200);
      dispatchCalls = dispatchSpy.mock.calls.length;
    } finally {
      dispatchSpy.mockRestore();
    }

    // The throw really happened where this test thinks it did — otherwise the 200 above proves
    // nothing (the old version's exact failure mode).
    expect(dispatchCalls).toBe(1);
    const notes = await prisma.notification.findMany({
      where: { type: "award.rejected", entityId: query.id },
    });
    expect(notes).toHaveLength(0);

    // ...and the reject itself is fully committed, not half-done: the decision AND both post-commit
    // status fires (which run BEFORE the comms block) all stand.
    const decision = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: leg.id } });
    expect(decision.status).toBe("DRAFT");
    expect(decision.rejectionReason).toBe("Price too high");
    const rejectedLeg = await prisma.leg.findUniqueOrThrow({ where: { id: leg.id } });
    expect(rejectedLeg.status).toBe("FULLY_QUOTED");
  });
});
