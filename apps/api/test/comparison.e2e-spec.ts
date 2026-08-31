process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import { Role, ACCESS_TOKEN_COOKIE, toUsd, type QuoteDraft, type QueryAwardSnapshot } from "@svyft/shared";
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
  nativeTotal: number;
  quoteStatus: string;
  priced: boolean; // S5.9.5 — D4/D8 assert on it directly (an EXPIRED offer must still read priced)
};

describe("GET /queries/:id/comparison (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  // Any authenticated role works — the route carries no @Roles (auth-only, Executive+).
  const cookie = () =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: randomUUID(), role: Role.EXECUTIVE, tenantId: null })}`;

  // S5.9.5 — the D8 test drives the REAL maker+checker endpoints, which need a named actor and a
  // MANAGER role: `approve` carries `@Roles(ADMINISTRATOR, MANAGER)` and `AwardService` enforces
  // four-eyes (the sender may not decide their own send), so the two calls need DIFFERENT `sub`s.
  // `sub` MUST be a real UUID — the actor columns are `@db.Uuid` (same note as
  // award-workflow-checker.e2e-spec.ts's own `cookieFor`).
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
        submittedJson: roadDraft(leg.id, origin.id, "INR", 123000, 3) as unknown as Prisma.InputJsonValue,
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
        submittedJson: roadDraft(leg.id, origin.id, "EUR", 1100, 3) as unknown as Prisma.InputJsonValue,
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
        submittedJson: roadDraft(leg.id, origin.id, "GBP", 5000, 4) as unknown as Prisma.InputJsonValue,
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
        // 8,320 INR ≈ $100 undercuts both on price too) — if the ranking filter did not exclude
        // REQUOTED, THIS would win outright (no tie-break even needed). Asserting the recommendation
        // stays FF-B below therefore proves the exclusion is real (status-based), not a coincidence
        // of these numbers happening to lose anyway.
        draftJson: roadDraft(leg.id, origin.id, "INR", 8320, 1) as unknown as Prisma.InputJsonValue,
        submittedJson: roadDraft(leg.id, origin.id, "INR", 8320, 1) as unknown as Prisma.InputJsonValue,
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
    // ...and is excluded from the recommendation despite being the objectively best offer on the
    // leg (fastest transit AND cheapest) — which proves the exclusion is status-based, not an
    // artifact of it losing on merit. (CORRECTED, S5.9.5 D4: the ranking is no longer "QUOTED-only"
    // — `buildRecommendation` ranks QUOTED *and* EXPIRED now. REQUOTED is still excluded, and for
    // its own stated reason: we are waiting on a revised number, so we must not recommend the old
    // one. That is the exclusion under test here.)
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
        submittedJson: roadDraft(legWithDecision.id, origin.id, "INR", 50000, 5) as unknown as Prisma.InputJsonValue,
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

  it("surfaces the frozen Query.awardSnapshot when present, and null when the query hasn't been generated yet (S5.6 Task 6)", async () => {
    const querySnapshotted = await prisma.query.create({
      data: { queryCode: `${CODE}-3`, priority: "MEDIUM", incoterms: "FOB" },
    });
    const snapshot: QueryAwardSnapshot = {
      generatedByUserId: randomUUID(),
      legs: [
        {
          legId: randomUUID(),
          winningQuoteId: randomUUID(),
          freightForwarderId: randomUUID(),
          variant: "DEDICATED",
          currency: "INR",
          unitsPerUsd: 83.2,
          usdTotal: 601.44,
          nativeTotal: 50040,
          transitDays: 5,
        },
      ],
      combinedUsd: 601.44,
    };
    await prisma.query.update({
      where: { id: querySnapshotted.id },
      data: { awardSnapshot: snapshot as unknown as Prisma.InputJsonValue },
    });

    const resWithSnapshot = await request(app.getHttpServer())
      .get(`/api/queries/${querySnapshotted.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);
    expect(resWithSnapshot.body.awardSnapshot).toEqual(snapshot);

    const queryNoSnapshot = await prisma.query.create({
      data: { queryCode: `${CODE}-4`, priority: "LOW", incoterms: "FOB" },
    });
    const resNoSnapshot = await request(app.getHttpServer())
      .get(`/api/queries/${queryNoSnapshot.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);
    expect(resNoSnapshot.body.awardSnapshot).toBeNull();
  });

  // S5.9.5 (D8) — RE-AIMED, not deleted. This test was written for the S5.6 review-round-1 fix,
  // and its original control asserted `offers`/`pendingForwarders` were BOTH empty for an APPROVED
  // quote — which is what made the `forwarderNames` assertion mean something: with no other route
  // to the name, only a status-UNFILTERED map could produce it. D8 destroys that control (APPROVED
  // is comparable now, and every `OfferDto` carries `freightForwarderName` off the very same
  // `ffNameById` map), so an APPROVED-only fixture can no longer tell a status-unfiltered map from
  // a comparable-only one.
  //
  // FIX ROUND 1, FINDING 2 — the discriminating power is restored with a SECOND forwarder whose
  // quote is `SELECT`: not in COMPARABLE_STATUSES, not in PENDING_STATUSES, so it appears in
  // NEITHER list and `forwarderNames` is the only thing that can name it. `SELECT` is the Quote
  // model's own `@default` and its `rfqId` is nullable — a pre-distribution quote genuinely has no
  // RFQ — so this fixture is the real shape, not a contrivance. If `ffNameById` were ever narrowed
  // to comparable quotes, THIS is the assertion that reddens.
  it("names forwarders in forwarderNames regardless of quote status — including a SELECT quote in neither offers nor pendingForwarders — and (S5.9.5 D8) surfaces an APPROVED winner's offer on its own leg", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-5`, priority: "MEDIUM", incoterms: "FOB" },
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

    const ffWinner = await mkFf(`FF-${PREFIX}-WIN`);
    const rfq = await mkRfq(query.id, ffWinner.id, "WIN", "INR");
    // status: APPROVED directly (mirrors this file's existing direct-status-write convention for
    // REQUOTED/RFQ_SENT/etc above) — this is the exact state `generateClientQuote` leaves a
    // winning quote in once approve() has fired it (award.service.ts). S5.9.5 (D8) put APPROVED in
    // COMPARABLE_STATUSES; PENDING_STATUSES still excludes it.
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffWinner.id,
        rfqId: rfq.id,
        status: "APPROVED",
        submittedAt: new Date(),
        draftJson: roadDraft(leg.id, origin.id, "INR", 45000, 3) as unknown as Prisma.InputJsonValue,
        submittedJson: roadDraft(leg.id, origin.id, "INR", 45000, 3) as unknown as Prisma.InputJsonValue,
      },
    });

    // The discriminator (finding 2): selected for this leg but never distributed — no Rfq row at
    // all, no draft, status SELECT. In neither status list, so neither `offers` nor
    // `pendingForwarders` can ever name it.
    const ffSelected = await mkFf(`FF-${PREFIX}-SEL`);
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffSelected.id,
        status: "SELECT",
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);

    const offers = res.body.legs[0].offers as OfferBody[];
    const pendingIds = (res.body.legs[0].pendingForwarders as { freightForwarderId: string }[]).map(
      (p) => p.freightForwarderId,
    );

    // S5.9.5 (D8) — the APPROVED winner now DOES produce an offer on its own leg (this replaces
    // the pre-S5.9.5 `offers).toEqual([])` control). It is still never a "pending" forwarder.
    expect(
      offers.some((o) => o.freightForwarderId === ffWinner.id && o.quoteStatus === "APPROVED"),
    ).toBe(true);
    expect(pendingIds).not.toContain(ffWinner.id);

    // The SELECT forwarder reaches NEITHER list — the premise the assertion below depends on, and
    // asserted rather than assumed so a future status-list change cannot quietly hollow it out.
    expect(offers.some((o) => o.freightForwarderId === ffSelected.id)).toBe(false);
    expect(pendingIds).not.toContain(ffSelected.id);

    // ...yet forwarderNames names BOTH. For `ffSelected` this is the only possible source, which
    // is what makes it a real test of the status-unfiltered map rather than of `OfferDto`'s own
    // `freightForwarderName` (which reads the same map, and so cannot discriminate).
    expect(res.body.forwarderNames[ffWinner.id]).toBe(ffWinner.companyName);
    expect(res.body.forwarderNames[ffSelected.id]).toBe(ffSelected.companyName);
  });

  // S5.9.3 Task 2 follow-up (P4, review Important) — the SAME "legs sequence should be as per
  // route diagram" complaint on Compare Quotes' `QuotingClientPanel`, which renders
  // `awardSnapshot.legs` straight through. The route here is p1->p2 (L1) then p2->p3 (L2), but
  // the FROZEN snapshot lists them [L2, L1] — deliberately the OPPOSITE of route order, so a
  // fixture whose natural order already happened to match route order couldn't make this pass
  // for the wrong reason. Real `Leg` rows exist (so `getComparison`'s reorder has origin/
  // destination point ids to work with); no quotes/decisions are needed since the award snapshot
  // itself is planted directly, independent of any real generate() call.
  it("S5.9.3 Task 2 follow-up (P4) — the awardSnapshot returned to Compare Quotes is reordered into ROUTE order, even though it was frozen with legs listed in the OPPOSITE order", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-route1`, priority: "MEDIUM", incoterms: "FOB" },
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
    const legL1 = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L1", mode: "ROAD", originPointId: p1.id, destinationPointId: p2.id },
    });
    const legL2 = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L2", mode: "ROAD", originPointId: p2.id, destinationPointId: p3.id },
    });

    const snapshotLeg = (legId: string): QueryAwardSnapshot["legs"][number] => ({
      legId,
      winningQuoteId: randomUUID(),
      freightForwarderId: randomUUID(),
      variant: "DEDICATED",
      currency: "INR",
      unitsPerUsd: 83.2,
      usdTotal: 100,
      nativeTotal: 8320,
      transitDays: 5,
    });
    const snapshot: QueryAwardSnapshot = {
      generatedByUserId: randomUUID(),
      // Frozen order is [L2, L1] — the OPPOSITE of route order [L1, L2].
      legs: [snapshotLeg(legL2.id), snapshotLeg(legL1.id)],
      combinedUsd: 200,
    };
    await prisma.query.update({
      where: { id: query.id },
      data: { awardSnapshot: snapshot as unknown as Prisma.InputJsonValue },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);

    expect(res.body.awardSnapshot.legs.map((l: { legId: string }) => l.legId)).toEqual([
      legL1.id,
      legL2.id,
    ]);

    // READ-ONLY (review requirement) — the stored column itself is never rewritten as a side
    // effect of this GET; it stays frozen in the original (wrong) order forever, and every read
    // re-derives route order live instead.
    const stored = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    const storedSnapshot = stored.awardSnapshot as unknown as QueryAwardSnapshot;
    expect(storedSnapshot.legs.map((l) => l.legId)).toEqual([legL2.id, legL1.id]);
  });

  // 🔴 S5.9.3 final review — P4 was half-applied: the reorder above was added to
  // `awardSnapshot.legs` but NOT to `comparison.legs`, which stayed on the `legCode asc` the
  // Prisma query returns. Both render on the SAME screen (`CompareQuotesPage`: the leg accordion
  // from `legs`, `QuotingClientPanel` from `awardSnapshot.legs`), so one page showed two different
  // leg sequences.
  //
  // The fixture is built so `legCode asc` and route order genuinely DISAGREE — leg "L1" is the
  // SECOND hop (p2->p3) and leg "L2" is the first (p1->p2). A fixture whose codes happened to
  // agree with its route would pass identically with or without the fix.
  //
  // Mutation proof: map over `legs` instead of `routeOrderedLegs` in `getComparison` and the
  // first assertion reddens (it comes back [L1, L2], i.e. legCode order). The awardSnapshot
  // assertion is the positive control — it is already route-ordered by the fix above and stays
  // green under that mutation, so the two halves cannot both be satisfied by one accidental
  // cause, and the "they agree with each other" assertion cannot pass vacuously by both being
  // wrong in the same way.
  it("S5.9.3 final review — the comparison's own legs come back in ROUTE order too, matching awardSnapshot on the same screen instead of contradicting it", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-route2`, priority: "MEDIUM", incoterms: "FOB" },
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
    // Deliberately inverted: the FIRST hop is coded "L2", the second "L1".
    const firstHop = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L2", mode: "ROAD", originPointId: p1.id, destinationPointId: p2.id },
    });
    const secondHop = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L1", mode: "ROAD", originPointId: p2.id, destinationPointId: p3.id },
    });

    const snapshotLeg = (legId: string): QueryAwardSnapshot["legs"][number] => ({
      legId,
      winningQuoteId: randomUUID(),
      freightForwarderId: randomUUID(),
      variant: "DEDICATED",
      currency: "INR",
      unitsPerUsd: 83.2,
      usdTotal: 100,
      nativeTotal: 8320,
      transitDays: 5,
    });
    await prisma.query.update({
      where: { id: query.id },
      data: {
        awardSnapshot: {
          generatedByUserId: randomUUID(),
          legs: [snapshotLeg(secondHop.id), snapshotLeg(firstHop.id)],
          combinedUsd: 200,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);

    const legOrder = res.body.legs.map((l: { legId: string }) => l.legId);
    const snapshotOrder = res.body.awardSnapshot.legs.map((l: { legId: string }) => l.legId);

    // Route order — NOT legCode order, which would be [L1 (second hop), L2 (first hop)].
    expect(legOrder).toEqual([firstHop.id, secondHop.id]);
    expect(snapshotOrder).toEqual([firstHop.id, secondHop.id]);
    // …and therefore the two lists on that one screen agree.
    expect(legOrder).toEqual(snapshotOrder);
  });

  // ── S5.9.5 — APPROVED and priced-EXPIRED quotes are comparable (design D8 / D4) ──────────

  // Setup is driven through the REAL maker+checker endpoints (send-for-approval, then approve by
  // a DIFFERENT manager) rather than writing `status: "APPROVED"` directly the way the
  // forwarderNames fixture above does, so the state under test is one the live workflow actually
  // produces — including the quote's own APPROVED status, which `approve()` fires post-commit.
  it("S5.9.5 (D8) — an APPROVED quote still produces an offer on its own leg", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-appr`, priority: "HIGH", incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", city: "Shanghai", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", city: "Dubai", country: "AE" },
    });
    // FULLY_QUOTED so send-for-approval's A3 guard passes on its ordinary arm (the same fixture
    // shape award-workflow-checker.e2e-spec.ts's `seedLeg` uses).
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L1",
        mode: "ROAD",
        originPointId: origin.id,
        destinationPointId: dest.id,
        status: "FULLY_QUOTED" as never,
      },
    });
    await prisma.fxRate.create({
      data: { currency: "INR", unitsPerUsd: 83.2, note: `${PREFIX} appr` },
    });

    const ffWin = await mkFf(`FF-${PREFIX}-APPRW`);
    const ffLose = await mkFf(`FF-${PREFIX}-APPRL`);
    // FIX ROUND 1/2, FINDING 3 — a third forwarder left at RFQ_SENT, so `pendingForwarders` is
    // genuinely populated on this leg instead of `[]` outright. It carries the `toContain` control
    // at the bottom of this test (drop RFQ_SENT from PENDING_STATUSES and that line reddens). Round
    // 1 also added a `not.toContain(winnerFfId)` alongside it; round 2 DELETED that line as
    // unprovable — see the note at the assertions for why, and for where the subtraction it was
    // reaching for is actually covered.
    const ffPending = await mkFf(`FF-${PREFIX}-APPRP`);
    const rfqWin = await mkRfq(query.id, ffWin.id, "APPRW", "INR");
    const rfqLose = await mkRfq(query.id, ffLose.id, "APPRL", "INR");
    const rfqPending = await mkRfq(query.id, ffPending.id, "APPRP", "INR");
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffWin.id,
        rfqId: rfqWin.id,
        status: "QUOTED",
        submittedAt: new Date(),
        // 2-day transit — HIGH priority ranks speed first, so this is the recommended offer.
        draftJson: roadDraft(leg.id, origin.id, "INR", 83200, 2) as unknown as Prisma.InputJsonValue,
        submittedJson: roadDraft(leg.id, origin.id, "INR", 83200, 2) as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffLose.id,
        rfqId: rfqLose.id,
        status: "QUOTED",
        submittedAt: new Date(),
        draftJson: roadDraft(leg.id, origin.id, "INR", 90000, 5) as unknown as Prisma.InputJsonValue,
        submittedJson: roadDraft(leg.id, origin.id, "INR", 90000, 5) as unknown as Prisma.InputJsonValue,
      },
    });
    // Sent, never submitted — no draftJson, so it produces no offer and stays "awaiting". A3 is
    // satisfied by the leg already being FULLY_QUOTED, so this outstanding RFQ does not block the
    // send below (and A9 only ever looks at REQUOTED quotes).
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffPending.id,
        rfqId: rfqPending.id,
        status: "RFQ_SENT",
      },
    });

    // Name the RECOMMENDED offer so A2's override-reason requirement never fires (same tactic as
    // award-workflow-checker.e2e-spec.ts's `seedPendingApproval`).
    const before = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);
    const legBefore = before.body.legs.find((l: { legId: string }) => l.legId === leg.id);
    const rec = legBefore.recommendation as { quoteId: string; variant: string | null };
    expect(rec).not.toBeNull();
    const winnerFfId = (legBefore.offers as OfferBody[]).find(
      (o) => o.quoteId === rec.quoteId && o.variant === rec.variant,
    )!.freightForwarderId;
    expect(winnerFfId).toBe(ffWin.id);

    const maker = randomUUID();
    const checker = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(maker, Role.MANAGER))
      .send({ quoteId: rec.quoteId, variant: rec.variant })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(checker, Role.MANAGER))
      .expect(200);
    // Sanity: APPROVED was reached by the workflow, not written by this test. Without this the
    // assertions below could pass against a quote the endpoints left at PENDING_APPROVAL (which
    // COMPARABLE_STATUSES already admitted before S5.9.5).
    const winnerQuote = await prisma.quote.findUniqueOrThrow({ where: { id: rec.quoteId } });
    expect(winnerQuote.status).toBe("APPROVED");

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);
    const legDto = res.body.legs.find((l: { legId: string }) => l.legId === leg.id);
    const approved = (legDto.offers as OfferBody[]).filter((o) => o.quoteStatus === "APPROVED");
    expect(approved.length).toBeGreaterThan(0);
    expect(approved[0].freightForwarderId).toBe(winnerFfId);
    // `variantsForMode("ROAD")` is [DEDICATED, GROUPAGE] and only DEDICATED is priced in
    // `roadDraft`, so `approved[0]` is the priced one.
    expect(approved[0].priced).toBe(true);
    // NO `expect(pendingIds).not.toContain(winnerFfId)` HERE, deliberately (fix round 2). It looks
    // like the obvious companion assertion and it is not: no SINGLE fault can put an APPROVED
    // forwarder into both lists, so the line could never redden, and this project requires every
    // absence assertion to be mutation-provable.
    //   * APPROVED is not in PENDING_STATUSES, so dropping `!offeredQuoteIds.has(q.id)` from
    //     `buildLeg`'s pendingForwarders filter removes nothing — there is nothing there to remove.
    //   * Adding APPROVED to PENDING_STATUSES does not do it either — `offeredQuoteIds` already
    //     holds that quote id, so the subtraction blocks it.
    // Only both faults at once would show up here.
    //
    // The `!offeredQuoteIds.has(q.id)` subtraction that such an assertion would be reaching for IS
    // covered, one test down, by "S5.9.5 (D4) — an EXPIRED quote that still carries a price
    // produces an offer; one that does not, does not". EXPIRED is genuinely in BOTH
    // COMPARABLE_STATUSES and PENDING_STATUSES, so there the subtraction is the only thing
    // standing between one forwarder and two rendered cells, and removing it reddens that test
    // (mutation 2 in the task report). Look there rather than re-adding a line here.
    //
    // `toContain(ffPending.id)` below is kept on its own merits: it is a real, mutation-proven
    // control (drop RFQ_SENT from PENDING_STATUSES and it reddens) that the RFQ_SENT forwarder
    // reaches `pendingForwarders` at all.
    const pendingIds = (legDto.pendingForwarders as { freightForwarderId: string }[]).map(
      (p) => p.freightForwarderId,
    );
    expect(pendingIds).toContain(ffPending.id);
  });

  // D4's two EXPIRED scenarios, side by side on one leg. Both halves are in ONE test on purpose:
  // they are the positive and negative control for the same `submittedJson` condition, so no bug
  // that collapses them (e.g. dropping the `if (!submittedJson) continue` skip in `buildLeg`) can
  // satisfy both.
  //
  // WHY THE STATUSES ARE SEEDED DIRECTLY rather than driven through the real expiry sweep: this
  // test owns only the READ MODEL, whose contract is "EXPIRED + a submitted price ⇒ an offer;
  // EXPIRED + none ⇒ a pending forwarder". These fixtures are exactly the two end states D4's table
  // (scenarios B and A) describes. UPDATED (S5.9.5 Task 2) — the sweep
  // (`rfq-schedule.listener.ts#onExpiry`) now genuinely produces the first of them: it never
  // touches `submittedJson`, and discards the scratchpad only for RFQ_SENT. That the sweep does so
  // is pinned by award-requote.e2e-spec.ts's own D4 sweep test, not here.
  it("S5.9.5 (D4) — an EXPIRED quote that still carries a price produces an offer; one that does not, does not", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-exp`, priority: "MEDIUM", incoterms: "FOB" },
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
    await prisma.fxRate.create({
      data: { currency: "INR", unitsPerUsd: 83.2, note: `${PREFIX} exp` },
    });

    const ffWithPrice = await mkFf(`FF-${PREFIX}-EXPP`);
    const ffNoPrice = await mkFf(`FF-${PREFIX}-EXPN`);
    const rfqWithPrice = await mkRfq(query.id, ffWithPrice.id, "EXPP", "INR");
    const rfqNoPrice = await mkRfq(query.id, ffNoPrice.id, "EXPN", "INR");
    // Scenario B — QUOTED -> (request-requote) -> REQUOTED -> expiry sweep -> EXPIRED with the
    // forwarder's already-submitted earlier price still on `submittedJson` (and the scratchpad
    // still on `draftJson`, which the sweep keeps for portal pre-fill — the real post-sweep shape).
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffWithPrice.id,
        rfqId: rfqWithPrice.id,
        status: "EXPIRED",
        submittedAt: new Date(),
        draftJson: roadDraft(leg.id, origin.id, "INR", 41600, 4) as unknown as Prisma.InputJsonValue,
        submittedJson: roadDraft(leg.id, origin.id, "INR", 41600, 4) as unknown as Prisma.InputJsonValue,
      },
    });
    // Scenario A — RFQ_SENT -> expiry sweep -> EXPIRED, never submitted, no draft to keep.
    await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffNoPrice.id,
        rfqId: rfqNoPrice.id,
        status: "EXPIRED",
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);
    const legDto = res.body.legs.find((l: { legId: string }) => l.legId === leg.id);
    const pendingIds = (legDto.pendingForwarders as { freightForwarderId: string }[]).map(
      (p) => p.freightForwarderId,
    );

    const priced = (legDto.offers as OfferBody[]).find(
      (o) => o.freightForwarderId === ffWithPrice.id && o.variant === "DEDICATED",
    );
    expect(priced).toBeDefined();
    expect(priced!.quoteStatus).toBe("EXPIRED");
    expect(priced!.priced).toBe(true);
    // EXPIRED is in BOTH status lists, so this is what the `offeredQuoteIds` subtraction buys:
    // without it this forwarder renders twice, once priced and once as "Not quoted".
    expect(pendingIds).not.toContain(ffWithPrice.id);

    expect(
      (legDto.offers as OfferBody[]).find((o) => o.freightForwarderId === ffNoPrice.id),
    ).toBeUndefined();
    expect(pendingIds).toContain(ffNoPrice.id);
  });


  // ── S5.9.6 (register A6) — the grid prices what was SUBMITTED, not what is merely saved ──────
  //
  // THE DEFECT. `Quote.draftJson` used to mean two things at once: the forwarder's scratchpad
  // while they type, and the price they submitted. `buildLeg` gated and priced on it. So: a
  // forwarder submits 5,000; an executive asks for a better number; the forwarder opens the
  // reopened portal, half-edits it down to 4,200 with the rest still blank, hits Save draft, and
  // goes silent. `saveDraft` has no status guard and no version hash, so 4,200 landed on the very
  // column this grid ranked — and 4,200 appeared here as a ranked, ★-recommendable, approvable
  // offer that nobody had ever offered. Approve it and the client letter is priced from it.
  //
  // The two columns are seeded to DIFFERENT values on purpose: only reading `submittedJson` can
  // satisfy the first assertion, and only reading a live column (rather than something frozen or
  // hardcoded) can satisfy the second. Seeded rather than driven end to end because this test owns
  // the READ MODEL; the write side of the same scenario is driven through the real portal
  // endpoints by ff-portal.e2e-spec.ts's own A6 test.
  it("S5.9.6 (A6) — the grid prices a REQUOTED forwarder off their SUBMITTED price, not their live draft", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-a6`, priority: "MEDIUM", incoterms: "FOB" },
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
    await prisma.fxRate.create({ data: { currency: "INR", unitsPerUsd: 83.2, note: `${PREFIX} a6` } });

    const ff = await mkFf(`FF-${PREFIX}-A6`);
    const rfq = await mkRfq(query.id, ff.id, "A6", "INR");
    // They submitted 5,000. Then they were asked to re-quote and saved a half-edited 4,200 they
    // never submitted — so the two columns disagree, exactly as A6 describes.
    const quote = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ff.id,
        rfqId: rfq.id,
        status: "REQUOTED",
        submittedAt: new Date(),
        draftJson: roadDraft(leg.id, origin.id, "INR", 4200, 4) as unknown as Prisma.InputJsonValue,
        submittedJson: roadDraft(leg.id, origin.id, "INR", 5000, 3) as unknown as Prisma.InputJsonValue,
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);
    const legDto = res.body.legs.find((l: { legId: string }) => l.legId === leg.id);
    const offer = (legDto.offers as OfferBody[]).find(
      (o) => o.freightForwarderId === ff.id && o.variant === "DEDICATED",
    );
    expect(offer).toBeDefined();
    expect(offer!.nativeTotal).toBe(5000); // NOT 4200 — nobody ever offered 4200

    // POSITIVE CONTROL, same test: the forwarder actually SUBMITS 4,750. `submit` writes both
    // columns from one value, so this is the real post-submit shape — and the grid must move.
    // Without this, an implementation that simply ignored the draft (or froze the first price it
    // ever saw) would pass the assertion above.
    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        status: "QUOTED",
        draftJson: roadDraft(leg.id, origin.id, "INR", 4750, 3) as unknown as Prisma.InputJsonValue,
        submittedJson: roadDraft(leg.id, origin.id, "INR", 4750, 3) as unknown as Prisma.InputJsonValue,
      },
    });

    const after = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);
    const legAfter = after.body.legs.find((l: { legId: string }) => l.legId === leg.id);
    const offerAfter = (legAfter.offers as OfferBody[]).find(
      (o) => o.freightForwarderId === ff.id && o.variant === "DEDICATED",
    );
    expect(offerAfter!.nativeTotal).toBe(4750);
  });

  // The ranking half of D4, on ONE forwarder so nothing else can win: the same priced offer must
  // be unrankable while REQUOTED (we are still waiting for a better price) and rankable once the
  // window has closed (the silence IS their final answer). Seeded directly for the same reason as
  // the test above — Task 2 owns the sweep.
  it("S5.9.5 (D4) — an EXPIRED offer carrying a price is rankable; a REQUOTED one is not", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-rank`, priority: "MEDIUM", incoterms: "FOB" },
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
    await prisma.fxRate.create({
      data: { currency: "INR", unitsPerUsd: 83.2, note: `${PREFIX} rank` },
    });

    const ff = await mkFf(`FF-${PREFIX}-RANK`);
    const rfq = await mkRfq(query.id, ff.id, "RANK", "INR");
    const quote = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ff.id,
        rfqId: rfq.id,
        status: "REQUOTED",
        submittedAt: new Date(),
        draftJson: roadDraft(leg.id, origin.id, "INR", 24960, 6) as unknown as Prisma.InputJsonValue,
        submittedJson: roadDraft(leg.id, origin.id, "INR", 24960, 6) as unknown as Prisma.InputJsonValue,
      },
    });

    const whileRequoted = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);
    const legWhileRequoted = whileRequoted.body.legs.find(
      (l: { legId: string }) => l.legId === leg.id,
    );
    // Positive control that the offer is genuinely IN the pool and only its status keeps it out —
    // otherwise a null recommendation here would prove nothing.
    expect((legWhileRequoted.offers as OfferBody[]).some((o) => o.quoteId === quote.id)).toBe(true);
    expect(legWhileRequoted.recommendation).toBeNull();

    await prisma.quote.update({ where: { id: quote.id }, data: { status: "EXPIRED" } });

    const afterExpiry = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookie())
      .expect(200);
    const legAfterExpiry = afterExpiry.body.legs.find((l: { legId: string }) => l.legId === leg.id);
    // Asserted separately so dropping EXPIRED from the ranking filter reddens with a readable
    // "expected null not to be null" rather than a TypeError on the line below.
    expect(legAfterExpiry.recommendation).not.toBeNull();
    expect(legAfterExpiry.recommendation.quoteId).toBe(quote.id);
  });
});
