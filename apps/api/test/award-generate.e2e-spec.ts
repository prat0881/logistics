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
// Setup seeds the POST-APPROVAL state DIRECTLY (leg APPROVED, quote APPROVED with a submitted
// draftJson, LegAwardDecision APPROVED) rather than driving shortlist->send->approve through the
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

  const future = () => new Date(Date.now() + 86400000);

  type LegSpec = {
    // false = FULLY_QUOTED, quote QUOTED, NO LegAwardDecision row at all — A6's "not every leg
    // has an approved winner" case.
    approved: boolean;
    currency: string;
    amount: number;
    transitDays: number;
  };

  // One Query + N Legs, each with its own dedicated FF/Rfq/Quote. `approved` legs get a
  // fully-decided LegAwardDecision (status APPROVED, shortlisted = the seeded quote) — exactly
  // the state Task 3's real approve() endpoint leaves behind.
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
          status: (spec.approved ? "APPROVED" : "FULLY_QUOTED") as never,
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
          status: (spec.approved ? "APPROVED" : "QUOTED") as never,
          submittedAt: new Date(),
          draftJson: roadDraft(
            leg.id,
            origin.id,
            spec.amount,
            spec.transitDays,
          ) as unknown as Prisma.InputJsonValue,
        },
      });

      if (spec.approved) {
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
      }

      legRows.push({ id: leg.id, quoteId: quote.id });
    }

    return { query, legs: legRows };
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

  it("2-leg query, both legs approved (INR) -> generate (MANAGER) 200: QUOTING_CLIENT + a 2-leg snapshot; then reopen (EXECUTIVE) 200: back to QUOTED, snapshot null, legs still APPROVED", async () => {
    const { query, legs } = await seedQuery("happy", [
      { approved: true, currency: "INR", amount: 83200, transitDays: 3 }, // -> $1000 USD
      { approved: true, currency: "INR", amount: 41600, transitDays: 5 }, // -> $500 USD
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

    // Legs stay APPROVED — generate never fires a leg/quote transition (AWARDED is reserved for
    // post-client-Won, Stage 6).
    const legRows = await prisma.leg.findMany({ where: { queryId: query.id } });
    expect(legRows.every((l) => l.status === "APPROVED")).toBe(true);

    // --- reopen-comparison, same query ---
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", cookieFor(randomUUID(), Role.EXECUTIVE))
      .send()
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

  it("A6 — 2-leg query with only ONE leg approved (the other FULLY_QUOTED, no decision) -> generate 409, status/snapshot untouched", async () => {
    const { query } = await seedQuery("a6", [
      { approved: true, currency: "INR", amount: 83200, transitDays: 3 },
      { approved: false, currency: "INR", amount: 20000, transitDays: 4 },
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
      { approved: true, currency: "EUR", amount: 900, transitDays: 2 },
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

  it("RBAC — an EXECUTIVE calling generate-client-quote -> 403 (RolesGuard)", async () => {
    const { query } = await seedQuery("rbac", [
      { approved: true, currency: "INR", amount: 83200, transitDays: 3 },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.EXECUTIVE))
      .send()
      .expect(403);

    const updated = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(updated.awardSnapshot).toBeNull();
  });

  it("reopen-comparison when awardSnapshot is already null -> 409", async () => {
    const { query } = await seedQuery("reopennull", []);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", cookieFor(randomUUID(), Role.EXECUTIVE))
      .send()
      .expect(409);
  });
});
