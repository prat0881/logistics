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

// S5.4 Task 4 — the two TERMINAL endpoints of the maker-checker award workflow (design
// §5.6/§8.3/§9): POST .../generate-client-quote freezes the per-leg winners onto
// Query.awardSnapshot and rolls the query up to QUOTING_CLIENT; POST .../reopen-comparison
// clears the snapshot and rolls back to QUOTED. Both are QUERY-scoped (no :legId — unlike
// shortlist/send-for-approval/approve/reject).
//
// Setup seeds the POST-APPROVAL state DIRECTLY (leg APPROVED, quote APPROVED with a
// submittedJson, LegAwardDecision APPROVED) rather than driving shortlist->send->approve through the
// real endpoints — that round trip is already covered end-to-end by
// award-workflow-{maker,checker}.e2e-spec.ts; this file is only about what happens once every
// leg is already approved.
const PREFIX = "AWGN";
const CODE = `YAL00-${PREFIX}`;

type SnapshotLeg = {
  legId: string;
  winningQuoteId: string;
  freightForwarderId: string;
  variant: string | null;
  currency: string | null;
  unitsPerUsd: number | null;
  usdTotal: number;
  nativeTotal: number;
  transitDays: number | null;
};
type Snapshot = { generatedByUserId: string; legs: SnapshotLeg[]; combinedUsd: number };

describe("award workflow — generate-client-quote / reopen-comparison (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

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

  // Same minimal ROAD-draft shape as the maker/checker specs' roadDraft — priced only on the
  // DEDICATED variant, so computeQuoteTotals produces exactly one comparable (nativeTotal,
  // transitDays) pair per quote.
  // S5.9.6 review (A6, the currency limb) — `currency` is a PARAMETER now, and every caller passes
  // the same value it gives the quote's own Rfq. It used to be hardcoded "INR" while `seedQuery`
  // set the Rfq to `spec.currency`, which is a row the product cannot produce: `submit` builds the
  // authoritative draft with `currency: scope.rfq.currency` (ff-portal.service.ts), so the two
  // always agree on a genuinely submitted quote. That divergence went unnoticed only because
  // `generateClientQuote` read the Rfq row; now that it reads the submitted draft, the A7 fixture
  // has to be honest about which currency the forwarder actually quoted in.
  const roadDraft = (
    legId: string,
    originPointId: string,
    amount: number,
    transitDays: number,
    currency = "INR",
  ): QuoteDraft => ({
    legId,
    mode: "ROAD",
    currency,
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

  const future = () => new Date(Date.now() + 86400000);

  type LegSpec = {
    // APPROVED = leg APPROVED, quote APPROVED, a fully-decided LegAwardDecision (status
    //   APPROVED, shortlisted = the seeded quote) — exactly the state Task 3's real approve()
    //   endpoint leaves behind.
    // PENDING_APPROVAL = leg FULLY_QUOTED, quote QUOTED, a LegAwardDecision that exists but was
    //   only ever sent (status PENDING_APPROVAL, never decided) — A6's "decision exists but
    //   isn't APPROVED" arm (task-4 review IMP-3).
    // NONE = leg FULLY_QUOTED, quote QUOTED, NO LegAwardDecision row at all — A6's "never
    //   shortlisted at all" arm.
    decision: "APPROVED" | "PENDING_APPROVAL" | "NONE";
    currency: string;
    amount: number;
    transitDays: number;
    // Four-eyes test only (task-4 review IMP-1) — override the decision's sentByUserId with a
    // known id instead of a fresh randomUUID() per leg, so a test can call generate AS that id.
    sentByUserId?: string;
  };

  // One Query + N Legs, each with its own dedicated FF/Rfq/Quote.
  async function seedQuery(label: string, legs: LegSpec[]) {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-${label}`, priority: "HIGH", incoterms: "FOB" },
    });

    const legRows: { id: string; quoteId: string }[] = [];
    for (let i = 0; i < legs.length; i++) {
      const spec = legs[i];
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
          status: (spec.decision === "APPROVED" ? "APPROVED" : "FULLY_QUOTED") as never,
        },
      });
      const ffRow = await mkFf(`FF-${PREFIX}-${key}`);
      const rfq = await prisma.rfq.create({
        data: {
          queryId: query.id,
          freightForwarderId: ffRow.id,
          rfqNumber: `${CODE}-RFQ-${key}`,
          accessTokenHash: `hash-${PREFIX}-${key}`,
          submissionDeadline: future(),
          incoterms: "FOB",
          currency: spec.currency,
          quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
        },
      });
      const quote = await prisma.quote.create({
        data: {
          queryId: query.id,
          legId: leg.id,
          freightForwarderId: ffRow.id,
          rfqId: rfq.id,
          status: (spec.decision === "APPROVED" ? "APPROVED" : "QUOTED") as never,
          submittedAt: new Date(),
          draftJson: roadDraft(
            leg.id,
            origin.id,
            spec.amount,
            spec.transitDays,
            spec.currency,
          ) as unknown as Prisma.InputJsonValue,
          submittedJson: roadDraft(
            leg.id,
            origin.id,
            spec.amount,
            spec.transitDays,
            spec.currency,
          ) as unknown as Prisma.InputJsonValue,
        },
      });

      if (spec.decision === "APPROVED") {
        await prisma.legAwardDecision.create({
          data: {
            legId: leg.id,
            queryId: query.id,
            shortlistedQuoteId: quote.id,
            shortlistedVariant: "DEDICATED",
            status: "APPROVED",
            sentByUserId: spec.sentByUserId ?? randomUUID(),
            sentForApprovalAt: new Date(),
            decidedByUserId: randomUUID(),
            decidedAt: new Date(),
          },
        });
      } else if (spec.decision === "PENDING_APPROVAL") {
        await prisma.legAwardDecision.create({
          data: {
            legId: leg.id,
            queryId: query.id,
            shortlistedQuoteId: quote.id,
            shortlistedVariant: "DEDICATED",
            status: "PENDING_APPROVAL",
            sentByUserId: spec.sentByUserId ?? randomUUID(),
            sentForApprovalAt: new Date(),
          },
        });
      }

      legRows.push({ id: leg.id, quoteId: quote.id });
    }

    return { query, legs: legRows };
  }

  // S5.9.3 Task 2 (P4) — like `seedQuery`, but the caller supplies each leg's own
  // origin/destination Point ids (so a test can chain legs into a real route, or leave them
  // disconnected) and its own legCode, instead of `seedQuery`'s fixed Shanghai->Dubai-per-leg,
  // `L${i+1}`-numbered shape. Every leg is APPROVED (decision + quote + leg), same as `seedQuery`'s
  // "APPROVED" arm — these tests are only about snapshot LEG ORDER, not the A6/A7 approval gates
  // already covered above.
  type RouteLegSpec = { legCode: string; originId: string; destinationId: string };
  async function seedRouteQuery(query: { id: string }, label: string, legs: RouteLegSpec[]) {
    const legRows: { id: string; legCode: string; quoteId: string }[] = [];
    for (let i = 0; i < legs.length; i++) {
      const spec = legs[i];
      const key = `${label}-${i + 1}`;
      const leg = await prisma.leg.create({
        data: {
          queryId: query.id,
          legCode: spec.legCode,
          mode: "ROAD",
          originPointId: spec.originId,
          destinationPointId: spec.destinationId,
          status: "APPROVED" as never,
        },
      });
      const ffRow = await mkFf(`FF-${PREFIX}-${key}`);
      const rfq = await prisma.rfq.create({
        data: {
          queryId: query.id,
          freightForwarderId: ffRow.id,
          rfqNumber: `${CODE}-RFQ-${key}`,
          accessTokenHash: `hash-${PREFIX}-${key}`,
          submissionDeadline: future(),
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
          status: "APPROVED" as never,
          submittedAt: new Date(),
          draftJson: roadDraft(leg.id, spec.originId, 8320, 5) as unknown as Prisma.InputJsonValue,
          submittedJson: roadDraft(leg.id, spec.originId, 8320, 5) as unknown as Prisma.InputJsonValue,
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
      legRows.push({ id: leg.id, legCode: spec.legCode, quoteId: quote.id });
    }
    return legRows;
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
    // The only FX rate on file for this spec is INR — the A7 test relies on EUR having NONE.
    await prisma.fxRate.create({ data: { currency: "INR", unitsPerUsd: 83.2, note: PREFIX } });
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("2-leg query, both legs approved (INR) -> generate (MANAGER) 200: QUOTING_CLIENT + a 2-leg snapshot; then reopen (MANAGER) 200: back to QUOTED, snapshot null, legs still APPROVED", async () => {
    const { query, legs } = await seedQuery("happy", [
      { decision: "APPROVED", currency: "INR", amount: 83200, transitDays: 3 }, // -> $1000 USD
      { decision: "APPROVED", currency: "INR", amount: 41600, transitDays: 5 }, // -> $500 USD
    ]);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(200);

    expect(res.body.status).toBe("QUOTING_CLIENT");
    expect(res.body.awardSnapshot.legs).toHaveLength(2);

    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(updated.status).toBe("QUOTING_CLIENT");
    const snapshot = updated.awardSnapshot as unknown as Snapshot;
    expect(snapshot.legs).toHaveLength(2);
    const totalFromLegs = snapshot.legs.reduce((s, l) => s + l.usdTotal, 0);
    expect(snapshot.combinedUsd).toBe(totalFromLegs);
    expect(snapshot.combinedUsd).toBe(1500);
    expect(snapshot.legs.map((l) => l.legId).sort()).toEqual(legs.map((l) => l.id).sort());
    const leg1Snap = snapshot.legs.find((l) => l.legId === legs[0].id)!;
    expect(leg1Snap.usdTotal).toBe(1000);
    expect(leg1Snap.transitDays).toBe(3);
    expect(leg1Snap.winningQuoteId).toBe(legs[0].quoteId);

    const genEvents = await prisma.awardDecisionEvent.findMany({
      where: { queryId: query.id, type: "GENERATE" },
    });
    expect(genEvents).toHaveLength(2);
    expect(genEvents.map((e) => e.legId).sort()).toEqual(legs.map((l) => l.id).sort());
    // Each GENERATE event carries its OWN leg's winner (quoteId/variant), not left null
    // (task-4 review MIN-5) — mirrors how SHORTLIST/APPROVE events record them.
    const genEventsByLeg = new Map(genEvents.map((e) => [e.legId, e]));
    expect(genEventsByLeg.get(legs[0].id)?.quoteId).toBe(legs[0].quoteId);
    expect(genEventsByLeg.get(legs[1].id)?.quoteId).toBe(legs[1].quoteId);
    expect(genEvents.every((e) => e.variant === "DEDICATED")).toBe(true);

    // Legs stay APPROVED — generate never fires a leg/quote transition (AWARDED is reserved for
    // post-client-Won, Stage 6).
    const legRows = await prisma.leg.findMany({ where: { queryId: query.id } });
    expect(legRows.every((l) => l.status === "APPROVED")).toBe(true);

    // --- reopen-comparison, same query ---
    // S5.9.5 (D6) — reopen is Manager/Admin only and takes a required reason (see the dedicated
    // role/reason tests below); this happy-path call just needs to keep succeeding.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "Client pushed the dates" })
      .expect(200);

    const reopened = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(reopened.awardSnapshot).toBeNull();
    expect(reopened.status).toBe("QUOTED");

    const legRowsAfter = await prisma.leg.findMany({ where: { queryId: query.id } });
    expect(legRowsAfter.every((l) => l.status === "APPROVED")).toBe(true); // untouched by reopen

    const reopenEvents = await prisma.awardDecisionEvent.findMany({
      where: { queryId: query.id, type: "REOPEN" },
    });
    expect(reopenEvents).toHaveLength(2);
  });

  it("A6 (first arm) — 2-leg query with only ONE leg approved (the other FULLY_QUOTED, NO decision at all) -> generate 409, status/snapshot untouched", async () => {
    const { query } = await seedQuery("a6", [
      { decision: "APPROVED", currency: "INR", amount: 83200, transitDays: 3 },
      { decision: "NONE", currency: "INR", amount: 20000, transitDays: 4 },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(409);

    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(updated.awardSnapshot).toBeNull();
    expect(updated.status).not.toBe("QUOTING_CLIENT");
  });

  it("A6 (second arm, task-4 review IMP-3) — 2-leg query where one leg's decision exists but is only PENDING_APPROVAL (never decided) -> generate 409, status/snapshot untouched", async () => {
    const { query } = await seedQuery("a6pending", [
      { decision: "APPROVED", currency: "INR", amount: 83200, transitDays: 3 },
      { decision: "PENDING_APPROVAL", currency: "INR", amount: 20000, transitDays: 4 },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(409);

    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(updated.awardSnapshot).toBeNull();
    expect(updated.status).not.toBe("QUOTING_CLIENT");
  });

  it("A7 — 1-leg approved query whose winner's currency (EUR) has no FX rate on file -> generate 409", async () => {
    const { query } = await seedQuery("a7", [
      { decision: "APPROVED", currency: "EUR", amount: 900, transitDays: 2 },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(409);

    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(updated.awardSnapshot).toBeNull();
    expect(updated.status).not.toBe("QUOTING_CLIENT");
  });

  // ── S5.9.6 (register A6) — the frozen snapshot prices the SUBMITTED offer ────────────────────
  it("S5.9.6 (A6) — the winner is priced off submittedJson, so a half-edited draft saved after they quoted cannot reach the client letter", async () => {
    // THE ROUTE THAT PRODUCES THIS ROW, end to end and all of it real: the forwarder submits
    // 83,200 (submit writes both JSON columns from one value); an executive asks for a better
    // number (REQUOTED); the forwarder half-edits the reopened portal down to 41,600 and hits Save
    // draft — `saveDraft` admits REQUOTED and writes `draftJson` verbatim, so now the two columns
    // disagree; they then go silent, the deadline sweep expires the quote KEEPING both columns
    // (D4), and the executive sends that preserved offer for approval (EXPIRED is in
    // SENDABLE_STATUSES, D4/D8) and it is approved. Every step exists in the product today.
    //
    // Before the split, `generateClientQuote` read `draftJson`, so the snapshot the client letter
    // is priced from would have frozen 41,600 — a number the forwarder never offered.
    const { query, legs } = await seedQuery("a6submitted", [
      { decision: "APPROVED", currency: "INR", amount: 83200, transitDays: 3 },
    ]);
    const origin = await prisma.point.findFirstOrThrow({
      where: { queryId: query.id, type: "PICKUP" },
    });
    await prisma.quote.update({
      where: { id: legs[0].quoteId },
      data: {
        draftJson: roadDraft(legs[0].id, origin.id, 41600, 3) as unknown as Prisma.InputJsonValue,
      },
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(200);

    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    const snapshot = updated.awardSnapshot as unknown as Snapshot;
    expect(snapshot.legs).toHaveLength(1);
    expect(snapshot.legs[0].nativeTotal).toBe(83200); // NOT 41600
    expect(snapshot.legs[0].usdTotal).toBe(1000); // 83200 / 83.2
    expect(snapshot.combinedUsd).toBe(1000);
  });

  // ── S5.9.6 review (A6, the currency limb) — the frozen snapshot's UNIT is submitted too ──────
  it("S5.9.6 (A6) — moving only Rfq.currency after the winner submitted does NOT re-denominate the frozen snapshot", async () => {
    // The half-edit above moved the AMOUNT; this moves the UNIT, through the other field the same
    // `saveDraft` call writes. `saveDraft` upserts `Rfq.currency` and admits `REQUOTED`, and this
    // method used to read `quote.rfq?.currency` live at generate time — so a forwarder who was
    // asked to re-quote and saved a draft in another currency re-denominated the winner, and the
    // wrong unit was frozen VERBATIM into `Query.awardSnapshot` and priced into the client letter.
    // `Rfq` is `@@unique([queryId, freightForwarderId])`, so one such save moved every offer that
    // forwarder held on the query. `submit` freezes the currency into the draft it writes, and
    // `Q_CURRENCY` (quote-engine.ts) blocks a submit without one, so `submittedJson` always has it.
    //
    // A JPY rate is on file deliberately: without it the broken behaviour would 409 on A7 rather
    // than produce a wrong number, and a refusal is a much weaker signal than $1,000 -> $554.67.
    await prisma.fxRate.create({ data: { currency: "JPY", unitsPerUsd: 150, note: `${PREFIX}-jpy` } });
    const { query, legs } = await seedQuery("a6currency", [
      { decision: "APPROVED", currency: "INR", amount: 83200, transitDays: 3 },
    ]);
    const quoteBefore = await prisma.quote.findUniqueOrThrow({
      where: { id: legs[0].quoteId },
      select: { rfqId: true },
    });
    await prisma.rfq.update({ where: { id: quoteBefore.rfqId! }, data: { currency: "JPY" } });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(200);

    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    const snapshot = updated.awardSnapshot as unknown as Snapshot;
    expect(snapshot.legs[0].currency).toBe("INR"); // NOT "JPY"
    expect(snapshot.legs[0].unitsPerUsd).toBe(83.2); // NOT 150
    expect(snapshot.legs[0].usdTotal).toBe(1000); // NOT 554.67
    expect(snapshot.combinedUsd).toBe(1000);
  });

  it("task-4 review IMP-2 — combinedUsd is re-rounded to cents after summing (3 winners whose individually-rounded usdTotals sum to a float artifact)", async () => {
    // 83208.32 / 41620.8 / 19413.056 INR @ 83.2 -> toUsd yields exactly 1000.10 / 500.25 /
    // 233.33 per leg (verified independently), but the raw JS sum of those three floats is
    // 1733.6799999999998, not 1733.68 — this only passes once combinedUsd re-rounds the sum.
    const { query, legs } = await seedQuery("roundcombined", [
      { decision: "APPROVED", currency: "INR", amount: 83208.32, transitDays: 3 },
      { decision: "APPROVED", currency: "INR", amount: 41620.8, transitDays: 3 },
      { decision: "APPROVED", currency: "INR", amount: 19413.056, transitDays: 3 },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(200);

    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    const snapshot = updated.awardSnapshot as unknown as Snapshot;
    expect(snapshot.legs).toHaveLength(3);
    const byLeg = new Map(snapshot.legs.map((l) => [l.legId, l]));
    expect(byLeg.get(legs[0].id)?.usdTotal).toBe(1000.1);
    expect(byLeg.get(legs[1].id)?.usdTotal).toBe(500.25);
    expect(byLeg.get(legs[2].id)?.usdTotal).toBe(233.33);
    const rawSum = snapshot.legs.reduce((s, l) => s + l.usdTotal, 0);
    expect(rawSum).not.toBe(1733.68); // proves the artifact is real, not a vacuous assertion
    expect(snapshot.combinedUsd).toBe(1733.68);
  });

  it("task-4 review Round 3 FIX #2 (design §16 O4) — a Manager who sent one of the approved legs can STILL generate -> 200 (no four-eyes on generate; per-leg four-eyes already happened at approve)", async () => {
    const senderId = randomUUID();
    const { query } = await seedQuery("selfgen", [
      {
        decision: "APPROVED",
        currency: "INR",
        amount: 83200,
        transitDays: 3,
        sentByUserId: senderId,
      },
      { decision: "APPROVED", currency: "INR", amount: 41600, transitDays: 5 }, // sent by someone else
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(senderId, Role.MANAGER)) // same id that sent leg 1's approval
      .send()
      .expect(200);

    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(updated.status).toBe("QUOTING_CLIENT");
    expect(updated.awardSnapshot).not.toBeNull();
  });

  it("RBAC — an EXECUTIVE calling generate-client-quote -> 403 (RolesGuard)", async () => {
    const { query } = await seedQuery("rbac", [
      { decision: "APPROVED", currency: "INR", amount: 83200, transitDays: 3 },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.EXECUTIVE))
      .send()
      .expect(403);

    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(updated.awardSnapshot).toBeNull();
  });

  it("task-4 review IMP-4/MIN-3 — generate on a real ZERO-leg query -> 409 (distinct from a nonexistent query -> 404)", async () => {
    const { query } = await seedQuery("zerolegs", []);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(409);
    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(updated.awardSnapshot).toBeNull();

    await request(app.getHttpServer())
      .post(`/api/queries/${randomUUID()}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(404);
  });

  it("reopen-comparison when awardSnapshot is already null -> 409", async () => {
    const { query } = await seedQuery("reopennull", []);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "x" })
      .expect(409);
  });

  // S5.9.5 (D6) — reopen-comparison had no @Roles at all before this task, so any authenticated
  // role (including EXECUTIVE) could reopen a client-quoted comparison; it is now Manager/Admin
  // only, matching the checker tier of approve/reject/generate-client-quote above.
  it("S5.9.5 (D6) — reopen is Manager/Admin only", async () => {
    const { query } = await seedQuery("reopenrbac", [
      { decision: "APPROVED", currency: "INR", amount: 83200, transitDays: 3 },
    ]);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", cookieFor(randomUUID(), Role.EXECUTIVE))
      .send({ reason: "x" })
      .expect(403);
    // The 403 changed nothing — still locked, not reopened by a role the guard should have blocked.
    const stillLocked = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(stillLocked.awardSnapshot).not.toBeNull();

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "x" })
      .expect(200);
  });

  // S5.9.5 (D6) — reopening supersedes an ISSUED client quotation and discards a DRAFT one, so
  // it is a consequential, auditable act like reject(): it requires a non-blank reason, and that
  // reason lands on every leg's own REOPEN AwardDecisionEvent (not just one row for the query).
  it("S5.9.5 (D6) — reopen requires a reason, and stores it on every leg's REOPEN event", async () => {
    const { query, legs } = await seedQuery("reopenreason", [
      { decision: "APPROVED", currency: "INR", amount: 83200, transitDays: 3 },
      { decision: "APPROVED", currency: "INR", amount: 41600, transitDays: 5 },
    ]);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(200);

    const managerCookie = cookieFor(randomUUID(), Role.MANAGER);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", managerCookie)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", managerCookie)
      .send({ reason: "   " })
      .expect(400);
    // Neither rejected attempt reopened the query.
    const stillLocked = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(stillLocked.awardSnapshot).not.toBeNull();

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", managerCookie)
      .send({ reason: "Client pushed the dates" })
      .expect(200);

    const events = await prisma.awardDecisionEvent.findMany({
      where: { queryId: query.id, type: "REOPEN" },
    });
    expect(events).toHaveLength(legs.length);
    expect(events.every((e) => e.reason === "Client pushed the dates")).toBe(true);
  });

  // S5.9.3 Task 2 (P4) — the product owner's finding: "legs sequence should be as per route
  // diagram instead of showing the order they got approved." `generateClientQuote` used to build
  // `awardSnapshot.legs` straight off `leg.findMany({ where: { queryId } })` with no `orderBy` —
  // effectively insertion order. Here the route is P1->P2 (leg L1) then P2->P3 (leg L2), but L2 is
  // CREATED FIRST — so the old, unordered code would freeze [L2, L1] (insertion order) into the
  // snapshot; the fix must freeze [L1, L2] (route order) regardless of creation order.
  it("S5.9.3 Task 2 (P4) — the award snapshot freezes legs in ROUTE order, not the order they were created/approved in", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-route1`, priority: "HIGH", incoterms: "FOB" },
    });
    const p1 = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", city: "Shanghai", country: "CN" },
    });
    const p2 = await prisma.point.create({
      data: { queryId: query.id, type: "WAREHOUSE", city: "Singapore", country: "SG" },
    });
    const p3 = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", city: "Dubai", country: "AE" },
    });

    // Created in REVERSE route order: L2 (the second leg on the route) first, L1 second.
    const [legL2, legL1] = await seedRouteQuery(query, "route1", [
      { legCode: "L2", originId: p2.id, destinationId: p3.id },
      { legCode: "L1", originId: p1.id, destinationId: p2.id },
    ]);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(200);

    // Route order (L1 then L2), NOT creation order (L2 then L1) and NOT a coincidence of `.sort()`
    // on ids — an exact array equality on the id sequence.
    expect(res.body.awardSnapshot.legs.map((l: { legId: string }) => l.legId)).toEqual([
      legL1.id,
      legL2.id,
    ]);

    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    const snapshot = updated.awardSnapshot as unknown as Snapshot;
    expect(snapshot.legs.map((l) => l.legId)).toEqual([legL1.id, legL2.id]);
  });

  // The case the brief calls out as "the one most likely to be wrong": when the route itself
  // can't order two legs (they don't share a point — a disconnected/ambiguous route, which real
  // data does contain), the result must still be deterministic — leg code, not whatever order the
  // database happened to return. Both legs are 1-hop and share no point, so route topology places
  // them in the SAME column pair and cannot break the tie; legZ is created FIRST (so insertion
  // order would put it first) but legCode "A1" must still sort before "Z9".
  it("S5.9.3 Task 2 (P4) — a disconnected/ambiguous route falls back to a deterministic LEG-CODE tiebreak, not DB/insertion order", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-route2`, priority: "HIGH", incoterms: "FOB" },
    });
    const pz1 = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", city: "Shanghai", country: "CN" },
    });
    const pz2 = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", city: "Dubai", country: "AE" },
    });
    const pa1 = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", city: "Mumbai", country: "IN" },
    });
    const pa2 = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", city: "Doha", country: "QA" },
    });

    // legZ ("Z9") created FIRST — insertion order would put it before legA ("A1").
    const [legZ, legA] = await seedRouteQuery(query, "route2", [
      { legCode: "Z9", originId: pz1.id, destinationId: pz2.id },
      { legCode: "A1", originId: pa1.id, destinationId: pa2.id },
    ]);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(200);

    expect(res.body.awardSnapshot.legs.map((l: { legId: string }) => l.legId)).toEqual([
      legA.id,
      legZ.id,
    ]);
  });
});
