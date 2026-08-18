process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import { Role, ACCESS_TOKEN_COOKIE, type QuoteDraft, type QueryAwardSnapshot } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";

const PFX = "s58q";
const CODE = `YAL00-${PFX}`;

describe("Quotation (e2e) — GET/PATCH /queries/:id/quotation", () => {
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

  // A minimal ROAD draft priced only on the DEDICATED variant, with one trucking charge line —
  // exactly enough for buildQuotationCostLines to produce one FREIGHT group with one line.
  const roadDraft = (legId: string, originPointId: string, currency: string, amount: number): QuoteDraft => ({
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
      guaranteedTransitDaysByVariant: { DEDICATED: 5 },
    },
    dgSurchargeNote: null,
    termsConditions: null,
  });

  // Builds one query + one leg + one APPROVED winning quote (8320 INR @ 83.2 units/USD = $100
  // cost) and freezes Query.awardSnapshot so the query has something to price. Returns the ids
  // the tests need.
  const mkAwardedQuery = async (suffix: string) => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-${suffix}`, priority: "MEDIUM", incoterms: "FOB" },
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
      },
    });
    const ff = await mkFf(`FF-${PFX}-${suffix}`);
    const quote = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ff.id,
        status: "APPROVED",
        submittedAt: new Date(),
        draftJson: roadDraft(leg.id, origin.id, "INR", 8320) as unknown as Prisma.InputJsonValue,
      },
    });

    const snapshot: QueryAwardSnapshot = {
      generatedByUserId: randomUUID(),
      legs: [
        {
          legId: leg.id,
          winningQuoteId: quote.id,
          freightForwarderId: ff.id,
          variant: "DEDICATED",
          currency: "INR",
          unitsPerUsd: 83.2,
          usdTotal: 100,
          nativeTotal: 8320,
          transitDays: 5,
        },
      ],
      combinedUsd: 100,
    };
    await prisma.query.update({
      where: { id: query.id },
      data: { awardSnapshot: snapshot as unknown as Prisma.InputJsonValue },
    });

    return { query, leg, ff, quote };
  };

  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    for (const q of qs) {
      await prisma.quotation.deleteMany({ where: { queryId: q.id } });
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PFX}` } },
    });
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
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("creates a DRAFT on first GET, priced from the awarded quotes at margin 0", async () => {
    const { query, leg } = await mkAwardedQuery("1");

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    expect(res.body.queryId).toBe(query.id);
    expect(res.body.version).toBe(1);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.marginPct).toBe(0);
    expect(res.body.overrides).toEqual({});
    expect(res.body.validUntil).toBeNull();
    expect(res.body.pricing.clientTotalUsd).toBe(res.body.pricing.costTotalUsd);
    expect(res.body.pricing.costTotalUsd).toBe(100);
    expect(res.body.pricing.legs).toHaveLength(1);
    expect(res.body.pricing.legs[0].legId).toBe(leg.id);
    expect(res.body.pricing.legs[0].groups.length).toBeGreaterThan(0);

    // exactly one DRAFT row was created for this query.
    const rows = await prisma.quotation.findMany({ where: { queryId: query.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
  });

  it("is idempotent — a second GET returns the same draft, not a second one", async () => {
    const { query } = await mkAwardedQuery("2");

    const res1 = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    const res2 = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    expect(res2.body.id).toBe(res1.body.id);
    expect(res2.body.version).toBe(1);

    const rows = await prisma.quotation.findMany({ where: { queryId: query.id } });
    expect(rows).toHaveLength(1);
  });

  it("PATCH applies a margin and recalculates every line", async () => {
    const { query } = await mkAwardedQuery("3");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    const res = await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 20 })
      .expect(200);

    expect(res.body.marginPct).toBe(20);
    expect(res.body.pricing.costTotalUsd).toBe(100);
    expect(res.body.pricing.clientTotalUsd).toBe(120); // round2(100 * 1.2)
    expect(res.body.version).toBe(1); // still the same draft, not a new version
  });

  it("PATCH stores an override that survives a later margin change", async () => {
    const { query, leg } = await mkAwardedQuery("4");
    const getRes = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    const lineId = getRes.body.pricing.legs[0].groups[0].lines[0].id as string;
    const key = `${leg.id}:${lineId}`;

    const patch1 = await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ overrides: { [key]: 55 } })
      .expect(200);
    expect(patch1.body.overrides).toEqual({ [key]: 55 });
    const overriddenLine1 = patch1.body.pricing.legs[0].groups[0].lines[0];
    expect(overriddenLine1.clientUsd).toBe(55);
    expect(overriddenLine1.overridden).toBe(true);

    // Changing the margin (no overrides in the body) must leave the pinned line untouched.
    const patch2 = await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 30 })
      .expect(200);
    expect(patch2.body.marginPct).toBe(30);
    expect(patch2.body.overrides).toEqual({ [key]: 55 });
    const overriddenLine2 = patch2.body.pricing.legs[0].groups[0].lines[0];
    expect(overriddenLine2.clientUsd).toBe(55);
    expect(overriddenLine2.overridden).toBe(true);
  });

  it("403s an EXECUTIVE on both GET and PATCH", async () => {
    const { query } = await mkAwardedQuery("5");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.EXECUTIVE))
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.EXECUTIVE))
      .send({ marginPct: 10 })
      .expect(403);
  });

  it("409s when the query has no frozen award snapshot", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-6`, priority: "MEDIUM", incoterms: "FOB", status: "QUOTED" },
    });

    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(409);
  });

  it("409s a PATCH when the current quotation is not DRAFT (already issued)", async () => {
    const { query } = await mkAwardedQuery("7");
    const getRes = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    // Issuing itself is Task 4's endpoint — not built yet, so mark it ISSUED directly, exactly
    // the way this suite's siblings (comparison.e2e-spec.ts) write LegAwardDecision/
    // AwardDecisionEvent rows directly to reach a state the app doesn't yet expose a route for.
    await prisma.quotation.update({
      where: { id: getRes.body.id },
      data: { status: "ISSUED" },
    });

    await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 15 })
      .expect(409);
  });
});
