process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import { Role, ACCESS_TOKEN_COOKIE, toUsd, type QuoteDraft } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";

const PREFIX = "CMP";
const CODE = `YAL00-${PREFIX}`;

type OfferBody = {
  quoteId: string;
  freightForwarderId: string;
  variant: string | null;
  usdTotal: number | null;
  quoteStatus: string;
};

describe("GET /queries/:id/comparison (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  // Any authenticated role works — the route carries no @Roles (auth-only, Executive+).
  const cookie = () =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: randomUUID(), role: Role.EXECUTIVE, tenantId: null })}`;

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

  const mkRfq = (queryId: string, ffId: string, key: string, currency: string) =>
    prisma.rfq.create({
      data: {
        queryId,
        freightForwarderId: ffId,
        rfqNumber: `${CODE}-RFQ-${key}`,
        accessTokenHash: `hash-${PREFIX}-${key}`,
        submissionDeadline: new Date(Date.now() + 86400000),
        incoterms: "FOB",
        currency,
        quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
      },
    });

  // A minimal, valid ROAD draft priced only on the DEDICATED variant (GROUPAGE is left
  // completely blank/unpriced) — exactly enough for computeQuoteTotals to produce one
  // comparable offer at `dedicatedAmount` (no charges/warehouse, so grandTotal == the rate).
  const roadDraft = (
    legId: string,
    originPointId: string,
    currency: string,
    dedicatedAmount: number,
    transitDays: number,
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
        amount: dedicatedAmount,
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

  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    for (const q of qs) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs
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
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("404s for an unknown query", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/queries/00000000-0000-0000-0000-000000000000/comparison")
      .set("Cookie", cookie())
      .expect(404);
    expect(res.body.message).toBe("Query not found");
  });

  it("assembles USD-normalised offers per (FF x variant), a HIGH-priority tie->cheaper-USD recommendation, pending vs quoted FFs, and null usdTotal without an FX rate", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-1`, priority: "HIGH", incoterms: "FOB" },
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

    await prisma.fxRate.create({ data: { currency: "INR", unitsPerUsd: 83.2, note: `${PREFIX} inr` } });
    await prisma.fxRate.create({ data: { currency: "EUR", unitsPerUsd: 0.92, note: `${PREFIX} eur` } });
    // deliberately NO FxRate row for GBP — proves the no-rate-on-file path.

    const ffA = await mkFf(`FF-${PREFIX}-A`);
    const ffB = await mkFf(`FF-${PREFIX}-B`);
    const ffPending = await mkFf(`FF-${PREFIX}-PEND`);
    const ffNoFx = await mkFf(`FF-${PREFIX}-NOFX`);
    const ffRequoted = await mkFf(`FF-${PREFIX}-REQ`);

    const rfqA = await mkRfq(query.id, ffA.id, "A", "INR");
    const rfqB = await mkRfq(query.id, ffB.id, "B", "EUR");
    const rfqPending = await mkRfq(query.id, ffPending.id, "PEND", "USD");
    const rfqNoFx = await mkRfq(query.id, ffNoFx.id, "NOFX", "GBP");
    const rfqRequoted = await mkRfq(query.id, ffRequoted.id, "REQ", "INR");

    const t0 = new Date();
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffA.id,
        rfqId: rfqA.id,
        status: "QUOTED",
        submittedAt: t0,
        // FF-A: INR 123,000, 3-day transit.
        draftJson: roadDraft(leg.id, origin.id, "INR", 123000, 3) as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffB.id,
        rfqId: rfqB.id,
        status: "QUOTED",
        submittedAt: new Date(t0.getTime() + 1000),
        // FF-B: EUR 1,100, ALSO 3-day transit — ties on transit, wins on cheaper USD.
        draftJson: roadDraft(leg.id, origin.id, "EUR", 1100, 3) as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffPending.id,
        rfqId: rfqPending.id,
        status: "RFQ_SENT", // sent, never submitted — no draftJson
      },
    });
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffNoFx.id,
        rfqId: rfqNoFx.id,
        status: "QUOTED",
        submittedAt: t0,
        // Quoted in GBP, which has no FxRate row on file.
        draftJson: roadDraft(leg.id, origin.id, "GBP", 5000, 4) as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffRequoted.id,
        rfqId: rfqRequoted.id,
        status: "REQUOTED", // change-order re-ask: earlier price stays visible, but unranked
        submittedAt: t0,
        // Deliberately the BEST possible offer in the pool (1-day transit beats A/B's 3, and
        // 8,320 INR ≈ $100 undercuts both on price too) — if the QUOTED-only ranking filter were
        // missing, THIS would win outright (no tie-break even needed). Asserting the recommendation
        // stays FF-B below therefore proves the exclusion is real (status-based), not a coincidence
        // of these numbers happening to lose anyway.
        draftJson: roadDraft(leg.id, origin.id, "INR", 8320, 1) as unknown as Prisma.InputJsonValue,
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);

    expect(res.body.priority).toBe("HIGH");
    expect(res.body.legs).toHaveLength(1);
    const legDto = res.body.legs[0];
    expect(legDto.legId).toBe(leg.id);

    const offers = legDto.offers as OfferBody[];
    const offerA = offers.find((o) => o.freightForwarderId === ffA.id && o.variant === "DEDICATED");
    const offerB = offers.find((o) => o.freightForwarderId === ffB.id && o.variant === "DEDICATED");
    expect(offerA).toBeDefined();
    expect(offerB).toBeDefined();
    expect(offerA!.usdTotal).toBe(toUsd(123000, "INR", { unitsPerUsd: 83.2 })); // ~1478.37
    expect(offerB!.usdTotal).toBe(toUsd(1100, "EUR", { unitsPerUsd: 0.92 })); // ~1195.65

    // Both 3-day transit -> tie -> FF-B wins on cheaper USD (HIGH priority = speed-first).
    expect(legDto.recommendation.quoteId).toBe(offerB!.quoteId);

    const pendingIds = (legDto.pendingForwarders as { freightForwarderId: string }[]).map(
      (p) => p.freightForwarderId,
    );
    expect(pendingIds).toContain(ffPending.id);
    expect(offers.some((o) => o.freightForwarderId === ffPending.id)).toBe(false);

    const offerNoFx = offers.find((o) => o.freightForwarderId === ffNoFx.id && o.variant === "DEDICATED");
    expect(offerNoFx).toBeDefined();
    expect(offerNoFx!.usdTotal).toBeNull();
    expect(legDto.recommendation.quoteId).not.toBe(offerNoFx!.quoteId);

    // REQUOTED (FF-C): the earlier price stays visible as an offer (with its own status)...
    const offerRequoted = offers.find(
      (o) => o.freightForwarderId === ffRequoted.id && o.variant === "DEDICATED",
    );
    expect(offerRequoted).toBeDefined();
    expect(offerRequoted!.quoteStatus).toBe("REQUOTED");
    expect(offerRequoted!.usdTotal).toBe(toUsd(8320, "INR", { unitsPerUsd: 83.2 })); // = 100
    // ...but is NOT "pending" (it has a comparable price, just a stale one)...
    expect(pendingIds).not.toContain(ffRequoted.id);
    // ...and is excluded from the recommendation (QUOTED-only ranking) despite being the
    // objectively best offer on the leg (fastest transit AND cheapest) — proves the exclusion is
    // status-based, not an artifact of it losing on merit.
    expect(legDto.recommendation.quoteId).not.toBe(offerRequoted!.quoteId);
    expect(legDto.recommendation.quoteId).toBe(offerB!.quoteId);
    // ...and flips the leg-level "awaiting a revised quote" flag.
    expect(legDto.awaitingReQuote).toBe(true);
  });

  it("exposes the award decision + its event timeline per leg, and itemised per-offer charge lines (S5.6)", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-2`, priority: "MEDIUM", incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", city: "Shanghai", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", city: "Dubai", country: "AE" },
    });
    // Two legs on the same query: one gets a decision + event, the other stays untouched — proves
    // the null/[] default path alongside the populated path in a single round-trip.
    const legWithDecision = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L1",
        mode: "ROAD",
        originPointId: origin.id,
        destinationPointId: dest.id,
      },
    });
    const legNoDecision = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L2",
        mode: "ROAD",
        originPointId: origin.id,
        destinationPointId: dest.id,
      },
    });

    await prisma.fxRate.create({ data: { currency: "INR", unitsPerUsd: 83.2, note: `${PREFIX} inr2` } });

    const ff = await mkFf(`FF-${PREFIX}-DEC`);
    const rfq = await mkRfq(query.id, ff.id, "DEC", "INR");
    const quote = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: legWithDecision.id,
        freightForwarderId: ff.id,
        rfqId: rfq.id,
        status: "QUOTED",
        submittedAt: new Date(),
        draftJson: roadDraft(legWithDecision.id, origin.id, "INR", 50000, 5) as unknown as Prisma.InputJsonValue,
      },
    });

    const senderId = randomUUID();
    await prisma.legAwardDecision.create({
      data: {
        legId: legWithDecision.id,
        queryId: query.id,
        shortlistedQuoteId: quote.id,
        shortlistedVariant: "DEDICATED",
        status: "PENDING_APPROVAL",
        sentByUserId: senderId,
        sentForApprovalAt: new Date(),
      },
    });
    await prisma.awardDecisionEvent.create({
      data: {
        legId: legWithDecision.id,
        queryId: query.id,
        type: "SHORTLIST",
        quoteId: quote.id,
        variant: "DEDICATED",
        actorId: senderId,
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);

    type ChargeLineBody = {
      label: string;
      group: string;
      nativeAmount: number;
      usdAmount: number | null;
    };
    type LegDtoBody = {
      legId: string;
      decision: {
        status: string;
        shortlistedQuoteId: string | null;
        sentByUserId: string | null;
        sentForApprovalAt: string | null;
      } | null;
      timeline: Array<{ type: string; at: string; quoteId: string | null }>;
      offers: Array<{
        quoteId: string;
        variant: string | null;
        nativeTotal: number;
        charges: ChargeLineBody[];
      }>;
    };
    const legs = res.body.legs as LegDtoBody[];

    // Populated path: decision fields + the SHORTLIST event surfaced verbatim.
    const legDtoWithDecision = legs.find((l) => l.legId === legWithDecision.id)!;
    expect(legDtoWithDecision.decision).not.toBeNull();
    expect(legDtoWithDecision.decision!.status).toBe("PENDING_APPROVAL");
    expect(legDtoWithDecision.decision!.shortlistedQuoteId).toBe(quote.id);
    expect(legDtoWithDecision.decision!.sentByUserId).toBe(senderId);
    expect(typeof legDtoWithDecision.decision!.sentForApprovalAt).toBe("string");
    expect(Number.isNaN(Date.parse(legDtoWithDecision.decision!.sentForApprovalAt!))).toBe(false);

    expect(legDtoWithDecision.timeline.length).toBeGreaterThan(0);
    const shortlistEvent = legDtoWithDecision.timeline.find((e) => e.type === "SHORTLIST");
    expect(shortlistEvent).toBeDefined();
    expect(shortlistEvent!.quoteId).toBe(quote.id);
    expect(typeof shortlistEvent!.at).toBe("string");
    expect(Number.isNaN(Date.parse(shortlistEvent!.at))).toBe(false);

    // Empty-default path: a leg nobody has touched yet gets null/[] , not undefined/missing.
    const legDtoNoDecision = legs.find((l) => l.legId === legNoDecision.id)!;
    expect(legDtoNoDecision.decision).toBeNull();
    expect(legDtoNoDecision.timeline).toEqual([]);

    // Itemised charges: non-empty, well-typed, and reconcile to the same offer's nativeTotal.
    const offer = legDtoWithDecision.offers.find(
      (o) => o.quoteId === quote.id && o.variant === "DEDICATED",
    );
    expect(offer).toBeDefined();
    expect(offer!.charges.length).toBeGreaterThan(0);
    for (const line of offer!.charges) {
      expect(typeof line.label).toBe("string");
      expect(typeof line.group).toBe("string");
      expect(typeof line.nativeAmount).toBe("number");
      expect(line.usdAmount === null || typeof line.usdAmount === "number").toBe(true);
    }
    const chargesSum = offer!.charges.reduce((s, l) => s + l.nativeAmount, 0);
    expect(chargesSum).toBeCloseTo(offer!.nativeTotal, 6);
  });
});
