process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import {
  ACCESS_TOKEN_COOKIE,
  LegEvent,
  LegStatus,
  QuoteEvent,
  QuoteStatus,
  Role,
  type QuoteDraft,
} from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { StatusService } from "../src/modules/status/status.service";

// S5.9 Task 2 (design §4.4): while a leg is under review (PENDING_APPROVAL) its status is owned
// by the approval flow, not the quote rollup — LegQuoteProjector.ROLLUP_FROZEN skips the rollup
// recompute entirely for a frozen leg (leg-quote.projector.ts, see its own comment for exactly
// what this guard does and does not protect against — CORRECTED in code review round 2, below).
//
// Three tests, each proving something different:
//   1. BEHAVIOUR — a straggler forwarder resolving (submit/expire) after send-for-approval leaves
//      the leg at PENDING_APPROVAL. True with or without ROLLUP_FROZEN: PENDING_APPROVAL/APPROVED
//      have no QUOTE_FULL/QUOTE_PARTIAL edge to begin with, so an un-guarded recompute attempt
//      fails inside StatusService.fire's own transaction and rolls back harmlessly (see the
//      projector's comment). This is still a real regression guard for the leg machine as a
//      whole — it would catch a future PENDING_APPROVAL --quote.full--> edge silently reactivating
//      the rollup — but it does NOT, by itself, prove ROLLUP_FROZEN is doing anything. Mutation-
//      tested: deleting `ROLLUP_FROZEN` from leg-quote.projector.ts does not turn this test red.
//   2. THE GUARD ITSELF — spies on StatusService.fire and asserts the projector never even
//      ATTEMPTS a "leg" fire while frozen. This is what actually distinguishes "guard present"
//      from "guard absent". Mutation-tested: deleting `ROLLUP_FROZEN` turns THIS test red (the
//      spy then observes a "leg"/QUOTE_FULL call attempt); restoring it turns it green again.
//   3. THE SIBLING ADMITTANCE — comparison.service.ts's COMPARABLE_STATUSES must also recognise
//      the new QuoteStatus.PENDING_APPROVAL, or the selected offer vanishes from the compare grid
//      the instant it's sent for approval — exactly the regression APPROVED once caused
//      (leg-rollup-approved.e2e-spec.ts).
//
// Headless for the first two (mirrors leg-rollup-approved.e2e-spec.ts / award-machine.e2e-
// spec.ts — StatusService.fire driven directly, spied on via `app.get(StatusService)` the same
// way award-workflow-checker.e2e-spec.ts does); the third goes over the real HTTP endpoint to
// prove the read model, same convention as award-workflow-maker.e2e-spec.ts.
const PFX = "S59ROLLUP";

describe(`${PFX} leg rollup freeze (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let status: StatusService;
  let jwt: JwtService;

  // Any authenticated role works — GET .../comparison carries no @Roles. actorId must be a real
  // UUID: the cookie's `sub` lands on `@db.Uuid` actor columns elsewhere in the request path.
  const cookieFor = (userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role: Role.EXECUTIVE, tenantId: null })}`;

  const mkFf = (code: string) =>
    prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "PIC",
        contactNumber: "+10000000000",
        email: `${code.toLowerCase()}@e2e.test`,
        availableCountries: ["AE"],
        modes: ["ROAD"],
        handleDg: false,
      },
    });

  const mkRfq = (queryId: string, ffId: string, key: string) =>
    prisma.rfq.create({
      data: {
        queryId,
        freightForwarderId: ffId,
        rfqNumber: `${PFX}-RFQ-${key}`,
        accessTokenHash: `hash-${PFX}-${key}`,
        submissionDeadline: new Date(Date.now() + 86400000),
        incoterms: "FOB",
        currency: "INR",
        quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
      },
    });

  // Same minimal ROAD-draft shape as award-workflow-maker.e2e-spec.ts's roadDraft — priced only
  // on the DEDICATED variant, so computeQuoteTotals produces exactly one comparable offer.
  const roadDraft = (legId: string): QuoteDraft => ({
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
        legEndpointPointId: randomUUID(),
        truckingType: "DEDICATED",
        basis: "FIXED",
        amount: 1000,
        rateVariant: "DEDICATED",
        tonnage: null,
      },
    ],
    seaRates: [],
    warehouse: [],
    transit: {
      departureDate: null,
      arrivalDate: null,
      guaranteedTransitDaysByVariant: { DEDICATED: 3 },
    },
    dgSurchargeNote: null,
    termsConditions: null,
  });

  // One Query + one Leg + two FF/Rfq/Quote rows (A = QUOTED with a draft, B = still RFQ_SENT),
  // seeded straight at FULLY_QUOTED-eligible state via real quote statuses (not seeded directly
  // at the leg's target status) so the rollup projector's own machinery drives the leg.
  async function seedLeg(label: string) {
    const query = await prisma.query.create({
      data: { queryCode: `${PFX}-${label}`, priority: "HIGH", incoterms: "FOB" },
    });
    const leg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L1", mode: "ROAD", status: LegStatus.PARTIALLY_QUOTED },
    });

    const ffA = await mkFf(`FF-${PFX}-${label}-A`);
    const rfqA = await mkRfq(query.id, ffA.id, `${label}-A`);
    const quoteA = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffA.id,
        rfqId: rfqA.id,
        status: QuoteStatus.QUOTED,
        submittedAt: new Date(),
        draftJson: roadDraft(leg.id) as unknown as Prisma.InputJsonValue,
      },
    });

    const ffB = await mkFf(`FF-${PFX}-${label}-B`);
    const rfqB = await mkRfq(query.id, ffB.id, `${label}-B`);
    const quoteB = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffB.id,
        rfqId: rfqB.id,
        status: QuoteStatus.RFQ_SENT,
      },
    });

    return { queryId: query.id, legId: leg.id, quoteA, quoteB };
  }

  async function cleanup(): Promise<void> {
    const queries = await prisma.query.findMany({
      where: { queryCode: { startsWith: PFX } },
      select: { id: true },
    });
    const queryIds = queries.map((q) => q.id);
    const legs = await prisma.leg.findMany({ where: { queryId: { in: queryIds } }, select: { id: true } });
    const legIds = legs.map((l) => l.id);
    const quotes = await prisma.quote.findMany({ where: { queryId: { in: queryIds } }, select: { id: true } });
    const quoteIds = quotes.map((q) => q.id);

    // StatusTransition has no FK to Leg/Quote (entity/entityId is a free-text log key) — Query's
    // cascade delete won't touch it, so the log rows need an explicit sweep first.
    await prisma.statusTransition.deleteMany({
      where: {
        OR: [
          { entity: "leg", entityId: { in: legIds } },
          { entity: "quote", entityId: { in: quoteIds } },
        ],
      },
    });
    await prisma.quote.deleteMany({ where: { queryId: { in: queryIds } } });
    await prisma.rfq.deleteMany({ where: { queryId: { in: queryIds } } });
    await prisma.query.deleteMany({ where: { id: { in: queryIds } } }); // cascades Leg
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: `FF-${PFX}` } } });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    status = moduleRef.get(StatusService);
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(prisma);
    await cleanup(); // in case a prior failed run left rows behind
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("BEHAVIOURAL: a leg under review reads PENDING_APPROVAL after a straggler resolves (true with or without the guard — see file header)", async () => {
    const { queryId, legId, quoteA, quoteB } = await seedLeg("frozen");

    // Send the shortlisted quote and the leg itself for approval.
    await status.fire("quote", quoteA.id, QuoteEvent.SEND_FOR_APPROVAL, { queryId });
    await status.fire("leg", legId, LegEvent.SEND_FOR_APPROVAL, { queryId });

    let leg = await prisma.leg.findUniqueOrThrow({ where: { id: legId } });
    expect(leg.status).toBe(LegStatus.PENDING_APPROVAL);

    // The straggler FF's RFQ window now closes. NOT proof ROLLUP_FROZEN did anything by itself:
    // even with the guard deleted, rollupLegTarget([PENDING_APPROVAL, EXPIRED]) computes
    // FULLY_QUOTED, the projector attempts an illegal QUOTE_FULL off PENDING_APPROVAL,
    // StatusService.fire's own transaction throws and rolls back BEFORE writing anything, and the
    // projector's try/catch swallows it — leg.status ends up PENDING_APPROVAL either way. Still a
    // valid regression guard for the leg machine as a whole (see file header); the guard's OWN
    // effect is proven separately by the next test.
    await status.fire("quote", quoteB.id, QuoteEvent.EXPIRE, { queryId });

    leg = await prisma.leg.findUniqueOrThrow({ where: { id: legId } });
    expect(leg.status).toBe(LegStatus.PENDING_APPROVAL);
  });

  it("THE GUARD ITSELF: ROLLUP_FROZEN stops the projector from even attempting a leg fire while under review (mutation-tested)", async () => {
    const { queryId, legId, quoteA, quoteB } = await seedLeg("frozen-spy");

    await status.fire("quote", quoteA.id, QuoteEvent.SEND_FOR_APPROVAL, { queryId });
    await status.fire("leg", legId, LegEvent.SEND_FOR_APPROVAL, { queryId });

    // Same idiom as award-workflow-checker.e2e-spec.ts's fireSpy: spy on the real singleton
    // StatusService (`app.get`, not a mock) so it calls through — this only OBSERVES calls,
    // it doesn't change behaviour. Installed AFTER the two setup fires above so their calls
    // aren't in the recorded history; only the straggler's resolution onward is under test.
    const fireSpy = jest.spyOn(app.get(StatusService), "fire");

    await status.fire("quote", quoteB.id, QuoteEvent.EXPIRE, { queryId });

    // The projector must never even ATTEMPT a "leg" fire for this leg while it's frozen — this is
    // what ROLLUP_FROZEN actually buys. Deleting `ROLLUP_FROZEN` in leg-quote.projector.ts turns
    // this red (the spy then records a ("leg", legId, "quote.full", ...) call attempt, even
    // though that attempt itself would go on to throw+roll back) — verified by hand: commenting
    // out the guard's early-return makes this assertion fail while the BEHAVIOURAL test above
    // stays green, exactly the asymmetry code review round 2 flagged. Restoring the guard makes
    // it pass again.
    const legFireAttempts = fireSpy.mock.calls.filter((call) => call[0] === "leg" && call[1] === legId);
    expect(legFireAttempts).toHaveLength(0);

    fireSpy.mockRestore();

    const leg = await prisma.leg.findUniqueOrThrow({ where: { id: legId } });
    expect(leg.status).toBe(LegStatus.PENDING_APPROVAL);
  });

  it("THE SIBLING ADMITTANCE: a quote under review still appears in the comparison grid", async () => {
    const { queryId, legId, quoteA } = await seedLeg("comparable");

    await status.fire("quote", quoteA.id, QuoteEvent.SEND_FOR_APPROVAL, { queryId });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${queryId}/comparison`)
      .set("Cookie", cookieFor(randomUUID()))
      .expect(200);

    const leg = res.body.legs.find((l: { legId: string }) => l.legId === legId);
    expect(leg).toBeTruthy();
    const offers = leg.offers as { quoteId: string }[];
    expect(offers.map((o) => o.quoteId)).toContain(quoteA.id);
  });
});
