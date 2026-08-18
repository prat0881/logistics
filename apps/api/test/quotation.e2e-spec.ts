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
import { MESSAGE_TRANSPORT, type MessageTransport } from "../src/modules/comms/transport";

const PFX = "s58q";
const CODE = `YAL00-${PFX}`;

describe("Quotation (e2e) — GET/PATCH /queries/:id/quotation", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  // Fix round 1 (review IMPORTANT #2) — spies on the MESSAGE_TRANSPORT the whole app shares, so
  // issue()'s post-commit `transport.send(...)` call is observable without a real SMTP transport.
  let transportSend: jest.Mock;

  // `tenantId` is optional because almost every test here is tenant-agnostic; the one that isn't
  // (final review MINOR #9 — `Quotation.tenantId` was never written, leaving `@@index([tenantId])`
  // dead) needs a real uuid on the token to tell "stamped from the caller" apart from "left null".
  const cookieFor = (userId: string, role: Role, tenantId: string | null = null) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role, tenantId })}`;

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
  const roadDraft = (
    legId: string,
    originPointId: string,
    currency: string,
    amount: number,
    quoteValidityUntil: string | null = "2099-01-01T00:00:00.000Z",
  ): QuoteDraft => ({
    legId,
    mode: "ROAD",
    currency,
    quoteValidityUntil,
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
  const mkAwardedQuery = async (suffix: string, quoteValidityUntil: string | null = "2099-01-01T00:00:00.000Z") => {
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
        draftJson: roadDraft(leg.id, origin.id, "INR", 8320, quoteValidityUntil) as unknown as Prisma.InputJsonValue,
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

  // Task 4's issue() writes a MessageLog keyed by entityId = queryId — a plain field, not a
  // relation (no FK, no cascade) — so it survives a Query delete unless cleaned up explicitly,
  // exactly like ScheduledEvent/MessageLog rows in rfq-distribute-comms.e2e-spec.ts.
  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    for (const q of qs) {
      await prisma.messageLog.deleteMany({ where: { entityId: q.id } });
      await prisma.quotation.deleteMany({ where: { queryId: q.id } });
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PFX}` } },
    });
  };

  // Task 4, fix round 1 — `.../issue`'s body no longer carries `bodyText` at all (schema
  // change, packages/shared/src/quotation.ts): the letter is always rendered server-side from
  // the seeded template, never accepted as free text.
  const issueBody = (suffix: string) => ({
    recipientEmail: `client-${suffix}@e2e.test`,
    subject: `Quotation for your shipment — ${suffix}`,
  });

  beforeAll(async () => {
    transportSend = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MESSAGE_TRANSPORT)
      .useValue({ send: transportSend } satisfies MessageTransport)
      .compile();
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

  // Task 4, pre-authorised decision (design doc Q2) — validUntil is null, not an empty string
  // or today's date, when every winning quote's own validity is null. Not one of the six
  // brief-listed cases but the only test that distinguishes "no data" from "zero-value".
  it("validUntil is null (not empty) when the winning quote's own validity is null", async () => {
    const { query } = await mkAwardedQuery("1b", null);

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    expect(res.body.validUntil).toBeNull();
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
    // Task 4 — validUntil is now the winning quote's own quoteValidityUntil (roadDraft's
    // fixture value below), no longer the Task 1-3 placeholder null.
    expect(res.body.validUntil).toBe("2099-01-01T00:00:00.000Z");
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

  // ── Task 4: issue / revise / AWAITING_CLIENT_DECISION / reopen supersedes ─────────────────

  it("issue freezes a snapshot, stamps ISSUED, and rolls the query to AWAITING_CLIENT_DECISION", async () => {
    const userId = randomUUID();
    const { query } = await mkAwardedQuery("8");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    const body = issueBody("8");
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(userId, Role.MANAGER))
      .send(body)
      .expect(200);

    expect(res.body.status).toBe("ISSUED");
    expect(res.body.version).toBe(1);
    expect(res.body.issuedByUserId).toBe(userId);
    expect(res.body.issuedAt).not.toBeNull();
    expect(res.body.recipientEmail).toBe(body.recipientEmail);
    expect(res.body.subject).toBe(body.subject); // caller-supplied subject wins over the template's
    // bodyText is always server-rendered now (fix round 1) — never the caller's, since there is
    // no bodyText field on the request body anymore.
    expect(res.body.bodyText).toContain("USD 100.00");
    expect(res.body.pricing.clientTotalUsd).toBe(100);

    const row = await prisma.quotation.findUnique({ where: { id: res.body.id } });
    expect(row?.status).toBe("ISSUED");
    expect(row?.issuedSnapshot).not.toBeNull();
    expect(row?.issuedByUserId).toBe(userId);

    const updatedQuery = await prisma.query.findUnique({ where: { id: query.id } });
    expect(updatedQuery?.status).toBe("AWAITING_CLIENT_DECISION");
  });

  it("issue composes exactly one MessageLog row against quotation.issued.email", async () => {
    const { query } = await mkAwardedQuery("9");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    const body = issueBody("9");
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(body)
      .expect(200);

    const logs = await prisma.messageLog.findMany({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "quotation.issued" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].templateKey).toBe("quotation.issued.email");
    expect(logs[0].channel).toBe("EMAIL");
    expect(logs[0].toAddress).toBe(body.recipientEmail);
    expect(logs[0].subject).toBe(body.subject);
    // The MessageLog's rendered body is the SAME text frozen onto Quotation.bodyText — one
    // render, written to both places (fix round 1).
    expect(logs[0].bodyRendered).toBe(res.body.bodyText);
    expect(logs[0].bodyRendered).toContain("USD 100.00");
    // Real tokens now (fix round 1, review MINOR #3) — not the placeholder `{}`.
    expect(logs[0].tokens).toMatchObject({
      Query_ID: expect.any(String),
      Grand_Total: "100.00",
    });
  });

  // Fix round 1, review IMPORTANT #1 — the design's absolute rule ("grand total only, no
  // forwarder names, no cost, no margin") has to be enforced by the render itself, not merely
  // by the shape of a request body nobody can send withheld content through anymore. Mutation
  // proof (a): reverting the render back to a verbatim/hand-built body (one that includes the
  // forwarder's name and native cost instead of the grand total) must turn this red.
  it("renders the body server-side from the template — grand total present, forwarder identity and OUR OWN COST withheld", async () => {
    const { query, ff } = await mkAwardedQuery("15");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    // 🔴 Final review MINOR #7 — this test used to run at the default margin 0, where cost and
    // client total are the SAME number ("100.00"), so a body leaking the COST total passed the
    // "grand total present" assertion identically to one that didn't. At 25% they are distinct
    // ($100 cost → $125 client), which is what lets `not.toContain("100.00")` actually bite.
    await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 25 })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(issueBody("15"))
      .expect(200);

    // present: the one number the client is allowed to see — the CLIENT total.
    expect(res.body.bodyText).toContain("USD 125.00");
    // withheld: our own cost total, forwarder identity, native currency/amount, anything
    // margin-shaped.
    expect(res.body.bodyText).not.toContain("100.00");
    expect(res.body.bodyText).not.toContain(ff.companyName);
    expect(res.body.bodyText).not.toContain("8320");
    expect(res.body.bodyText).not.toContain("INR");
    expect(res.body.bodyText.toLowerCase()).not.toContain("margin");

    const log = await prisma.messageLog.findFirst({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "quotation.issued" },
    });
    expect(log?.bodyRendered).toBe(res.body.bodyText);
  });

  it("omits the valid-until line entirely from the rendered body when every winning quote's validity is null", async () => {
    const { query } = await mkAwardedQuery("16", null);
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(issueBody("16"))
      .expect(200);

    expect(res.body.bodyText).not.toMatch(/valid until/i);
  });

  it("falls back to the template's own rendered subject when the caller omits subject", async () => {
    const { query } = await mkAwardedQuery("17");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ recipientEmail: "client-17@e2e.test" }) // no subject
      .expect(200);

    expect(res.body.subject).toContain(query.queryCode);
  });

  // Fix round 1, review IMPORTANT #2 — transport.send() must fire post-commit or quotations
  // will silently never be delivered once SmtpTransport lands at go-live, with nothing to show
  // why. Mutation proof (b): removing the `this.transport.send(logId)` call must turn this red.
  it("issue hands the composed MessageLog to the transport after the transaction commits", async () => {
    transportSend.mockClear();
    const { query } = await mkAwardedQuery("18");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(issueBody("18"))
      .expect(200);

    const log = await prisma.messageLog.findFirst({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "quotation.issued" },
    });
    expect(transportSend).toHaveBeenCalledWith(log?.id);
  });

  it("issue 409s when the draft has no priced legs", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-10`, priority: "MEDIUM", incoterms: "FOB" },
    });
    await prisma.quotation.create({
      data: {
        queryId: query.id,
        version: 1,
        status: "DRAFT",
        marginPct: 0,
        draftJson: { legs: [], overrides: {} } as unknown as Prisma.InputJsonValue,
        costTotalUsd: 0,
        clientTotalUsd: 0,
      },
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(issueBody("10"))
      .expect(409);
  });

  it("403s an EXECUTIVE on issue", async () => {
    const { query } = await mkAwardedQuery("11");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.EXECUTIVE))
      .send(issueBody("11"))
      .expect(403);
  });

  it("revise clones the issued version into a new DRAFT at version + 1, carrying margin and overrides", async () => {
    const { query, leg } = await mkAwardedQuery("12");
    const getRes = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    const lineId = getRes.body.pricing.legs[0].groups[0].lines[0].id as string;
    const key = `${leg.id}:${lineId}`;

    await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 15, overrides: { [key]: 99 } })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(issueBody("12"))
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/revise`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    expect(res.body.version).toBe(2);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.marginPct).toBe(15);
    expect(res.body.overrides).toEqual({ [key]: 99 });

    const rows = await prisma.quotation.findMany({
      where: { queryId: query.id },
      orderBy: { version: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("ISSUED");
    expect(rows[1].status).toBe("DRAFT");
  });

  // ── Task 6: server-rendered preview fields on GET/PATCH, and the GET-after-issue fix ──────

  // The design correction that governs Task 6: the client preview must be rendered from the SAME
  // template/token/render chain `issue()` itself uses (never reconstructed client-side), exposed
  // as two new read-only `QuotationDto` fields. This test is the DRAFT-time equivalent of the
  // existing "renders the body server-side..." issue-time test above — same withheld-content
  // assertions, but read straight off a plain GET, before anything has ever been issued.
  it("GET exposes a previewSubject/previewBody rendered from the SAME template — grand total present, forwarder identity and OUR OWN COST withheld", async () => {
    const { query, ff } = await mkAwardedQuery("19");

    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    // Margin 25 for the same reason as the issue-time test above (final review MINOR #7): at the
    // default 0 the cost and client totals are the same string, so "leaks the cost" and "shows the
    // client total" are indistinguishable.
    const res = await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 25 })
      .expect(200);

    expect(res.body.status).toBe("DRAFT");
    expect(typeof res.body.previewSubject).toBe("string");
    expect(res.body.previewSubject.length).toBeGreaterThan(0);
    // present: the one number the client is allowed to see — the CLIENT total.
    expect(res.body.previewBody).toContain("USD 125.00");
    // withheld: our own cost total, forwarder identity, native currency/amount, anything
    // margin-shaped — same rule as the issue-time render, since this is generated by the identical
    // renderFromTemplate() call.
    expect(res.body.previewBody).not.toContain("100.00");
    expect(res.body.previewBody).not.toContain(ff.companyName);
    expect(res.body.previewBody).not.toContain("8320");
    expect(res.body.previewBody).not.toContain("INR");
    expect(res.body.previewBody.toLowerCase()).not.toContain("margin");
  });

  // The whole justification for rendering the preview server-side (S5.8 Task 6 ruling) rather
  // than reconstructing it client-side: a manager reading the GET response BEFORE clicking
  // "Issue quotation" must see exactly what issuing will actually send — not an approximation
  // that could drift from the template. Issued WITHOUT a caller-supplied subject (matching the
  // pre-existing "falls back to the template's own rendered subject" test) so both previewSubject
  // and previewBody can be compared directly against what issue() persists, with nothing
  // (a caller-supplied subject override) in the way.
  it("previewSubject/previewBody on GET are byte-identical to what issue() persists as subject/bodyText", async () => {
    const { query } = await mkAwardedQuery("20");

    const draftRes = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    expect(draftRes.body.previewBody).toContain("USD 100.00");

    const issueRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ recipientEmail: "client-20@e2e.test" }) // no subject — let the template win, same as previewSubject
      .expect(200);

    expect(issueRes.body.subject).toBe(draftRes.body.previewSubject);
    expect(issueRes.body.bodyText).toBe(draftRes.body.previewBody);
  });

  // `getOrCreateDraft`'s pre-Task-6 "find a DRAFT, else create version 1" logic breaks the instant
  // there's a current quotation that ISN'T a draft: `Quotation` has `@@unique([queryId, version])`
  // and every draft this service creates is hardcoded to version 1, so falling through to `create`
  // after `issue()` has flipped the only row to ISSUED collides with that same row's own version 1
  // and 409s ("Already exists") instead of just showing it. This is exactly the request the web
  // preview dialog's `useIssueQuotation` fires via its post-success `invalidateQueries(["quotation",
  // queryId])` (T6 ambiguity resolution #4) the instant "Issue quotation" succeeds — undetected
  // until now because no earlier task's flow ever issued a quotation and then re-GET'd it in the
  // same session.
  it("GET after issue returns the current ISSUED quotation read-only, instead of colliding with it on a duplicate version 1", async () => {
    const { query } = await mkAwardedQuery("21");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    const issueRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(issueBody("21"))
      .expect(200);

    const getAfterIssue = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    expect(getAfterIssue.body.id).toBe(issueRes.body.id);
    expect(getAfterIssue.body.status).toBe("ISSUED");
    expect(getAfterIssue.body.version).toBe(1);

    // No duplicate/second row was created behind the scenes.
    const rows = await prisma.quotation.findMany({ where: { queryId: query.id } });
    expect(rows).toHaveLength(1);
  });

  it("reopening the comparison supersedes issued quotations, discards the draft, and returns the query to QUOTED", async () => {
    const { query, leg } = await mkAwardedQuery("13");
    // A genuinely-awarded leg is always APPROVED by the time a client quote exists; this
    // fixture otherwise leaves the leg at its DRAFT default (irrelevant to Tasks 1-3's
    // pricing-only tests), which would make the post-reopen rollup land on DRAFT instead of
    // QUOTED — set it explicitly so this assertion actually exercises the leg-rollup path.
    await prisma.leg.update({ where: { id: leg.id }, data: { status: "APPROVED" } });

    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(issueBody("13"))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/revise`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    const rows = await prisma.quotation.findMany({ where: { queryId: query.id } });
    expect(rows).toHaveLength(1); // the v2 DRAFT was discarded; only the superseded v1 remains
    expect(rows[0].status).toBe("SUPERSEDED");
    expect(rows[0].version).toBe(1);

    const updatedQuery = await prisma.query.findUnique({ where: { id: query.id } });
    expect(updatedQuery?.status).toBe("QUOTED");
    expect(updatedQuery?.awardSnapshot).toBeNull();
  });

  // ── Final review fixes ────────────────────────────────────────────────────────────────────

  // 🔴 CRITICAL #3 — the OTHER half of the reopen behaviour Task 4 built, which no e2e reached.
  // `reopenComparison` supersedes v1 and deletes the draft; re-freezing the award and opening the
  // builder then found neither a DRAFT nor an ISSUED row and fell through to a hardcoded
  // `create({ version: 1 })`, colliding with the SUPERSEDED v1 on `@@unique([queryId, version])`
  // — a PERMANENT 409 on every subsequent GET, directly contradicting the design's "a new
  // quotation starts fresh once the award is re-frozen". Mutation proof: hardcode `version: 1`
  // back into `getOrCreateDraft`'s create and this test 409s.
  it("reopen → re-award → GET starts a FRESH draft at the next version instead of colliding with the superseded one", async () => {
    const { query, leg } = await mkAwardedQuery("22");
    await prisma.leg.update({ where: { id: leg.id }, data: { status: "APPROVED" } });

    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(issueBody("22"))
      .expect(200);

    // Capture the frozen award before the reopen clears it — the "re-award" step below re-freezes
    // exactly the same snapshot, which is what `generateClientQuote` would produce again.
    const frozen = await prisma.query.findUniqueOrThrow({
      where: { id: query.id },
      select: { awardSnapshot: true },
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    expect((await prisma.quotation.findFirstOrThrow({ where: { queryId: query.id } })).status).toBe(
      "SUPERSEDED",
    );

    await prisma.query.update({
      where: { id: query.id },
      data: { awardSnapshot: frozen.awardSnapshot as Prisma.InputJsonValue },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    expect(res.body.status).toBe("DRAFT");
    expect(res.body.version).toBe(2);
    expect(res.body.marginPct).toBe(0); // genuinely fresh, not a clone of the superseded one

    const rows = await prisma.quotation.findMany({
      where: { queryId: query.id },
      orderBy: { version: "asc" },
    });
    expect(rows.map((r) => [r.version, r.status])).toEqual([
      [1, "SUPERSEDED"],
      [2, "DRAFT"],
    ]);

    // …and it stays idempotent from there — the second GET returns that same v2 draft.
    const again = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    expect(again.body.id).toBe(res.body.id);
  });

  // 🔴 IMPORTANT #5 — `omitEmptyTokenLine` was applied to `Valid_Until` alone, so a query with no
  // vessel (or no PO reference, no description, no packages, no ready date — all nullable, none
  // unusual) sent the CLIENT a letter full of bare labels: `Vessel: `, `Your reference: `,
  // `Port of call: `. `mkAwardedQuery` already leaves every one of those null, which is exactly
  // how invisible this was. Mutation proof: narrow OMITTABLE_TOKENS back to ["Valid_Until"].
  it("omits an optional token's whole line rather than sending the client a dangling label", async () => {
    const { query } = await mkAwardedQuery("23", null);
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(issueBody("23"))
      .expect(200);

    const body = res.body.bodyText as string;
    for (const label of [
      "Your reference",
      "Shipment:",
      "Vessel:",
      "Port of call",
      "Cargo:",
      "Cargo ready",
      "Quotation valid until",
    ]) {
      expect(body).not.toContain(label);
    }
    // The generic net, so a token added to the template later can't quietly reintroduce this:
    // no line may be left as a bare "Some label:" with nothing after it.
    expect(body.split("\n").filter((l) => /\S.*:\s*$/.test(l))).toEqual([]);
    // …while everything that IS populated survives untouched.
    expect(body).toContain(`Our reference: ${query.queryCode}`);
    expect(body).toContain("USD 100.00");
  });

  // The other half of the pair above: proof the omission is data-driven, not the template quietly
  // having lost those lines. Without this, deleting them from the seed would pass the test above.
  it("keeps an optional token's line when the query actually carries that data", async () => {
    const { query } = await mkAwardedQuery("24");
    await prisma.query.update({
      where: { id: query.id },
      data: {
        vesselName: "MV Testarossa",
        portOfCall: "Jebel Ali",
        shipmentDescription: "Spare parts, palletised",
      },
    });

    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(issueBody("24"))
      .expect(200);

    expect(res.body.bodyText).toContain("Vessel: MV Testarossa");
    expect(res.body.bodyText).toContain("Port of call: Jebel Ali");
    expect(res.body.bodyText).toContain("Shipment: Spare parts, palletised");
    expect(res.body.bodyText).toContain("Quotation valid until: 2099-01-01");
  });

  // MINOR #8 — `toDto` re-rendered the preview from LIVE query data for every status, so an
  // ISSUED quotation's "this is what we sent" could drift from the `bodyText` actually sent the
  // moment anyone touched the query afterwards. Mutation proof: drop the `status !== "DRAFT"`
  // early return in `previewFor` and this test sees "MV Renamed".
  it("a non-DRAFT quotation's preview replays the letter that was issued, not a re-render off live query data", async () => {
    const { query } = await mkAwardedQuery("25");
    await prisma.query.update({ where: { id: query.id }, data: { vesselName: "MV Original" } });

    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    const issueRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(issueBody("25"))
      .expect(200);
    expect(issueRes.body.bodyText).toContain("MV Original");

    // The query keeps moving after the letter has gone out.
    await prisma.query.update({ where: { id: query.id }, data: { vesselName: "MV Renamed" } });

    const after = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    expect(after.body.status).toBe("ISSUED");
    expect(after.body.previewBody).toBe(issueRes.body.bodyText);
    expect(after.body.previewSubject).toBe(issueRes.body.subject);
    expect(after.body.previewBody).not.toContain("MV Renamed");
  });

  // MINOR #9 — every peer service stamps `tenantId` from the caller; this one never did, so
  // `@@index([tenantId])` indexed a column that was always null. Mutation proof: drop
  // `tenantId: user.tenantId` from `getOrCreateDraft`'s create.
  it("stamps the caller's tenant on the quotation it creates, and carries it into a revision", async () => {
    const tenantId = randomUUID();
    const { query } = await mkAwardedQuery("26");

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER, tenantId))
      .expect(200);
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: res.body.id } })).tenantId).toBe(
      tenantId,
    );

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER, tenantId))
      .send(issueBody("26"))
      .expect(200);
    const revised = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/revise`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER, tenantId))
      .expect(200);

    expect(
      (await prisma.quotation.findUniqueOrThrow({ where: { id: revised.body.id } })).tenantId,
    ).toBe(tenantId);
  });
});
