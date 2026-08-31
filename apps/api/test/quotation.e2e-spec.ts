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
        submittedJson: roadDraft(leg.id, origin.id, "INR", 8320, quoteValidityUntil) as unknown as Prisma.InputJsonValue,
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

  // S5.9.3 Task 2 (P4) — multi-leg variant: the caller describes a small chain of named points
  // (so a route can be chained by reusing a label as one leg's `to` and the next leg's `from`, or
  // left disconnected) and the exact order to freeze into `Query.awardSnapshot.legs` —
  // independent of the legs' own creation order, so a test can plant a snapshot in a DELIBERATELY
  // wrong order (the "existing quotation" the product owner was looking at) without needing
  // `award.service.ts`'s own generate path.
  const mkAwardedRouteQuery = async (
    suffix: string,
    points: Record<string, { type: "PICKUP" | "DELIVERY" | "WAREHOUSE"; city: string; country: string }>,
    legs: { legCode: string; from: string; to: string }[],
    snapshotOrderIndexes: number[],
  ) => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-${suffix}`, priority: "MEDIUM", incoterms: "FOB" },
    });

    const pointIds: Record<string, string> = {};
    for (const [label, spec] of Object.entries(points)) {
      const p = await prisma.point.create({
        data: { queryId: query.id, type: spec.type, city: spec.city, country: spec.country },
      });
      pointIds[label] = p.id;
    }

    const built: { legId: string; quoteId: string; ffId: string }[] = [];
    for (let i = 0; i < legs.length; i++) {
      const spec = legs[i];
      const originId = pointIds[spec.from];
      const leg = await prisma.leg.create({
        data: {
          queryId: query.id,
          legCode: spec.legCode,
          mode: "ROAD",
          originPointId: originId,
          destinationPointId: pointIds[spec.to],
        },
      });
      const ff = await mkFf(`FF-${PFX}-${suffix}-${i + 1}`);
      const quote = await prisma.quote.create({
        data: {
          queryId: query.id,
          legId: leg.id,
          freightForwarderId: ff.id,
          status: "APPROVED",
          submittedAt: new Date(),
          draftJson: roadDraft(leg.id, originId, "INR", 8320) as unknown as Prisma.InputJsonValue,
          submittedJson: roadDraft(leg.id, originId, "INR", 8320) as unknown as Prisma.InputJsonValue,
        },
      });
      built.push({ legId: leg.id, quoteId: quote.id, ffId: ff.id });
    }

    const snapshot: QueryAwardSnapshot = {
      generatedByUserId: randomUUID(),
      legs: snapshotOrderIndexes.map((i) => ({
        legId: built[i].legId,
        winningQuoteId: built[i].quoteId,
        freightForwarderId: built[i].ffId,
        variant: "DEDICATED",
        currency: "INR",
        unitsPerUsd: 83.2,
        usdTotal: 100,
        nativeTotal: 8320,
        transitDays: 5,
      })),
      combinedUsd: built.length * 100,
    };
    await prisma.query.update({
      where: { id: query.id },
      data: { awardSnapshot: snapshot as unknown as Prisma.InputJsonValue },
    });

    return { query, legs: built };
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

  // Deliberately omits `bodyText` — S5.9.3 Task 1 made it an OPTIONAL caller override
  // (packages/shared/src/quotation.ts), so every existing test built on this helper keeps
  // exercising the fallback-to-server-render path unchanged. Tests for the override path send
  // `bodyText` explicitly (see the "S5.9.3 Task 1" block below).
  /** The current quotation row's `updatedAt`, as the ISO string `quotationIssueSchema
   *  .expectedUpdatedAt` wants — read straight from the DB rather than over HTTP so calling it
   *  never has the side effect of creating a draft that the test under test didn't ask for. */
  const currentUpdatedAt = async (queryId: string) => {
    const row = await prisma.quotation.findFirstOrThrow({
      where: { queryId },
      orderBy: { version: "desc" },
    });
    return row.updatedAt.toISOString();
  };

  /** S5.9.3 final review IMPORTANT #1 — `expectedUpdatedAt` is REQUIRED on every issue, so this
   *  helper is async now: it reads the row's CURRENT `updatedAt` at call time, which is what makes
   *  every pre-existing test here go on exercising the happy path (their caller is, by
   *  construction, up to date). The staleness tests build their body by hand instead. */
  const issueBody = async (suffix: string, queryId: string) => ({
    recipientEmail: `client-${suffix}@e2e.test`,
    subject: `Quotation for your shipment — ${suffix}`,
    expectedUpdatedAt: await currentUpdatedAt(queryId),
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

  // ── S5.9.6 (register A6) — the client letter's cost lines come from the SUBMITTED offer ─────
  it("S5.9.6 (A6) — the client letter prices its cost lines and validUntil off submittedJson, not the winner's live draft", async () => {
    // Same real route as award-generate.e2e-spec.ts's A6 test: submit → re-quote asked → the
    // forwarder half-edits the reopened portal and saves (`saveDraft` admits REQUOTED and writes
    // `draftJson` verbatim) → silence → the preserved offer is sent for approval and approved.
    // `buildInitialDraft` reads the winning quote directly (NOT the frozen `awardSnapshot`), so
    // before the split the letter's cost lines were built from whatever that forwarder last had
    // saved. Two independent fields are moved by the half-edit — the amount AND the validity —
    // and both are asserted, because `buildInitialDraft` reads the draft object twice.
    const { query, quote, leg } = await mkAwardedQuery("a6");
    const origin = await prisma.point.findFirstOrThrow({
      where: { queryId: query.id, type: "PICKUP" },
    });
    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        draftJson: roadDraft(
          leg.id,
          origin.id,
          "INR",
          4160, // half the submitted price -> $50 instead of $100
          "2050-06-01T00:00:00.000Z", // and a different validity
        ) as unknown as Prisma.InputJsonValue,
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    expect(res.body.pricing.costTotalUsd).toBe(100); // NOT 50
    expect(res.body.validUntil).toBe("2099-01-01T00:00:00.000Z"); // NOT 2050-06-01
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

    const body = await issueBody("8", query.id);
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
    // `issueBody()` (this file) never sends `bodyText`, so this exercises the FALLBACK path —
    // S5.9.3 Task 1 made `bodyText` a caller-editable override, but omitting it must still render
    // the template server-side exactly as before P1 (see the tests below for the override path).
    expect(res.body.bodyText).toContain("USD 100.00");
    expect(res.body.pricing.clientTotalUsd).toBe(100);

    const row = await prisma.quotation.findUnique({ where: { id: res.body.id } });
    expect(row?.status).toBe("ISSUED");
    expect(row?.issuedSnapshot).not.toBeNull();
    expect(row?.issuedByUserId).toBe(userId);

    const updatedQuery = await prisma.query.findUnique({ where: { id: query.id } });
    expect(updatedQuery?.status).toBe("AWAITING_CLIENT_DECISION");
  });

  // ── S5.9.3 Task 1 (P1/P2): the editable body ────────────────────────────────────────────────

  it("persists a caller-edited body verbatim into bodyText/MessageLog, while the grand total stays priced server-side regardless of what the text claims", async () => {
    const userId = randomUUID();
    const { query } = await mkAwardedQuery("8b");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    // Deliberately claims a WRONG total in the prose — this is the exact divergence risk the
    // task brief calls out: the audit record must still capture this verbatim (P2), even though
    // it disagrees with the server-priced `clientTotalUsd` below.
    const editedBody =
      "Dear valued client,\n\nOur best all-in offer stands at USD 999,999.00, today only.\n\nRegards,\nYankalfa Logistics";
    const body = { ...(await issueBody("8b", query.id)), bodyText: editedBody };
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(userId, Role.MANAGER))
      .send(body)
      .expect(200);

    // The audit record reflects exactly what was typed — never the template's own render.
    expect(res.body.bodyText).toBe(editedBody);
    expect(res.body.bodyText).not.toContain("USD 100.00");

    // But the amount the client is actually quoted never comes from that text: it is the SAME
    // priced total the server would have computed regardless, off the frozen draft alone.
    expect(res.body.pricing.clientTotalUsd).toBe(100);

    const row = await prisma.quotation.findUnique({ where: { id: res.body.id } });
    expect(row?.bodyText).toBe(editedBody);
    expect(Number(row?.clientTotalUsd)).toBe(100);
    expect(Number(row?.costTotalUsd)).toBe(100);
    expect((row?.issuedSnapshot as unknown as { clientTotalUsd: number } | null)?.clientTotalUsd).toBe(100);

    const log = await prisma.messageLog.findFirst({
      where: { entityId: query.id, eventKey: "quotation.issued" },
      orderBy: { createdAt: "desc" },
    });
    expect(log?.bodyRendered).toBe(editedBody);
  });

  it("400s an issue whose bodyText is explicitly empty — never silently replaced by the template's render", async () => {
    const { query } = await mkAwardedQuery("8c");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ ...(await issueBody("8c", query.id)), bodyText: "" })
      .expect(400);

    // Refused, not frozen — the draft is untouched by the rejected attempt.
    const row = await prisma.quotation.findFirst({ where: { queryId: query.id } });
    expect(row?.status).toBe("DRAFT");
  });

  it("400s an issue whose bodyText exceeds the sane maximum", async () => {
    const { query } = await mkAwardedQuery("8d");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ ...(await issueBody("8d", query.id)), bodyText: "x".repeat(5001) })
      .expect(400);
  });

  it("issue composes exactly one MessageLog row against quotation.issued.email", async () => {
    const { query } = await mkAwardedQuery("9");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    const body = await issueBody("9", query.id);
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
      .send(await issueBody("15", query.id))
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
      .send(await issueBody("16", query.id))
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
      .send({
        recipientEmail: "client-17@e2e.test", // no subject
        expectedUpdatedAt: await currentUpdatedAt(query.id),
      })
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
      .send(await issueBody("18", query.id))
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
      .send(await issueBody("10", query.id))
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
      .send(await issueBody("11", query.id))
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
      .send(await issueBody("12", query.id))
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
      .send({
        // no subject — let the template win, same as previewSubject
        recipientEmail: "client-20@e2e.test",
        expectedUpdatedAt: draftRes.body.updatedAt,
      })
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
      .send(await issueBody("21", query.id))
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
      .send(await issueBody("13", query.id))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/revise`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "S5.9.5 e2e — reopening to test the supersede/discard behaviour" })
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
      .send(await issueBody("22", query.id))
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
      .send({ reason: "S5.9.5 e2e — reopening to test the fresh-draft-version behaviour" })
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
      .send(await issueBody("23", query.id))
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
      .send(await issueBody("24", query.id))
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
      .send(await issueBody("25", query.id))
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
      .send(await issueBody("26", query.id))
      .expect(200);
    const revised = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/revise`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER, tenantId))
      .expect(200);

    expect(
      (await prisma.quotation.findUniqueOrThrow({ where: { id: revised.body.id } })).tenantId,
    ).toBe(tenantId);
  });

  // ── S5.9.3 final review, IMPORTANT #1: the stale-letter window ────────────────────────────

  // The defect, in full: Manager A opens the preview and reads a letter quoting USD 100.00.
  // Manager B — or A's own second tab — reprices. A's browser never learns (`useQuotation` has no
  // polling; TanStack Query refetches only on focus/mount), so every client-side guard the Task-1
  // re-review added stays quiet: they all react to A's own `quotation` prop, and nothing makes it
  // move. A clicks Issue: the letter says 100.00 while `issue()` reprices from live `draftJson`
  // and charges 125.00. The client reads one figure and the system charges another, with nobody
  // having typed a wrong number. This test drives exactly that sequence over real HTTP against a
  // real database — two independent requests, no mocking of the concurrency.
  //
  // Mutation proof: delete the `current.updatedAt.getTime() !== expectedUpdatedAt.getTime()`
  // guard in `QuotationService.issue` and the 409 half of this test reddens (the stale POST
  // succeeds and charges 125.00 for a letter that says 100.00). The second half is the positive
  // control: same endpoint, same actor, same recipient, ONLY the token and the letter differ —
  // so a 409 that came from anything other than staleness would redden that half instead.
  it("S5.9.3 final review (IMPORTANT #1) — refuses a letter composed against pricing a concurrent PATCH has since moved, then accepts it once the caller has caught up", async () => {
    const { query } = await mkAwardedQuery("stale1");

    // Manager A opens the preview. THIS is the copy their letter is composed against.
    const managerA = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    expect(managerA.body.previewBody).toContain("USD 100.00");

    // Manager B (or A's own second tab) reprices. Nothing tells A.
    const managerB = await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 25 })
      .expect(200);
    expect(managerB.body.pricing.clientTotalUsd).toBe(125);
    expect(managerB.body.updatedAt).not.toBe(managerA.body.updatedAt);

    transportSend.mockClear();

    // A clicks Issue, sending the letter they actually read — the one quoting the OLD total.
    const stale = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({
        recipientEmail: "client-stale1@e2e.test",
        bodyText: managerA.body.previewBody,
        expectedUpdatedAt: managerA.body.updatedAt,
      })
      .expect(409);
    // A message a manager can act on — not "conflict".
    expect(stale.body.message).toContain("repriced");
    expect(stale.body.message).toContain("check it before issuing");

    // Nothing happened: still an editable DRAFT, no letter frozen, no audit row, nothing sent.
    const row = await prisma.quotation.findFirstOrThrow({ where: { queryId: query.id } });
    expect(row.status).toBe("DRAFT");
    expect(row.bodyText).toBeNull();
    expect(row.issuedAt).toBeNull();
    expect(
      await prisma.messageLog.count({
        where: { entityType: "QUERY", entityId: query.id, eventKey: "quotation.issued" },
      }),
    ).toBe(0);
    expect(transportSend).not.toHaveBeenCalled();

    // POSITIVE CONTROL — A refetches (what `useIssueQuotation`'s 409 handler does for them), sees
    // the 125.00 letter, and issues that. Same endpoint, same role, same recipient; the ONLY
    // differences are the token and the letter it agrees with.
    const fresh = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({
        recipientEmail: "client-stale1@e2e.test",
        bodyText: managerB.body.previewBody,
        expectedUpdatedAt: managerB.body.updatedAt,
      })
      .expect(200);
    expect(fresh.body.status).toBe("ISSUED");
    expect(fresh.body.pricing.clientTotalUsd).toBe(125);
    expect(fresh.body.bodyText).toContain("USD 125.00");
    expect(transportSend).toHaveBeenCalledTimes(1);
  });

  // The guard is only a guard if it cannot be skipped by simply not sending the field — an
  // OPTIONAL token would leave every caller that omits it in exactly the pre-fix state. Mutation
  // proof: make `expectedUpdatedAt` `.optional()` in `quotationIssueSchema` and this reddens
  // (the POST 200s instead of 400ing).
  it("S5.9.3 final review (IMPORTANT #1) — the freshness token is required, so no caller can opt out of the check", async () => {
    const { query } = await mkAwardedQuery("stale2");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ recipientEmail: "client-stale2@e2e.test" })
      .expect(400);

    // Positive control for the same request shape: with the token, it goes through.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({
        recipientEmail: "client-stale2@e2e.test",
        expectedUpdatedAt: await currentUpdatedAt(query.id),
      })
      .expect(200);
  });

  // S5.9.3 Task 2 (P4) — product owner: "Legs sequence should be as per route diagram instead of
  // showing the order they got approved." The award snapshot below is frozen with legs in
  // [L2, L1] order (route is L1: p1->p2, then L2: p2->p3) — exactly the arbitrary order
  // `award.service.ts`'s old, unordered `leg.findMany` could freeze. A fresh GET must still price
  // (and render) them route-first, L1 then L2.
  it("S5.9.3 Task 2 (P4) — GET .../quotation prices legs in ROUTE order even when the frozen award snapshot lists them out of order", async () => {
    const { query, legs } = await mkAwardedRouteQuery(
      "route1",
      {
        origin: { type: "PICKUP", city: "Shanghai", country: "CN" },
        mid: { type: "WAREHOUSE", city: "Singapore", country: "SG" },
        dest: { type: "DELIVERY", city: "Dubai", country: "AE" },
      },
      [
        { legCode: "L1", from: "origin", to: "mid" },
        { legCode: "L2", from: "mid", to: "dest" },
      ],
      [1, 0], // freeze the snapshot as [L2, L1] — deliberately wrong (route) order
    );

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    expect(res.body.pricing.legs.map((l: { legId: string }) => l.legId)).toEqual([
      legs[0].legId,
      legs[1].legId,
    ]);
  });

  // The case that actually matches the product owner's complaint: they are looking at a
  // quotation that ALREADY EXISTS (its `draftJson.legs` order already frozen by a first GET,
  // exactly as `getOrCreateDraft` has always worked) — not a fresh one. Ordering only at
  // generate/draft-creation time would leave this row's stored order untouched forever; the fix
  // must re-derive the correct order on every READ, independent of what's persisted. Proven here
  // by manually flipping the persisted `draftJson.legs` order AFTER the draft was created (as if
  // this row predates the fix) and confirming a later GET still returns route order.
  it("S5.9.3 Task 2 (P4) — a quotation whose draftJson was ALREADY frozen in the wrong order (predates this fix) still renders in route order on every later read — no migration needed", async () => {
    const { query, legs } = await mkAwardedRouteQuery(
      "route2",
      {
        origin: { type: "PICKUP", city: "Shanghai", country: "CN" },
        mid: { type: "WAREHOUSE", city: "Singapore", country: "SG" },
        dest: { type: "DELIVERY", city: "Dubai", country: "AE" },
      },
      [
        { legCode: "L1", from: "origin", to: "mid" },
        { legCode: "L2", from: "mid", to: "dest" },
      ],
      [0, 1], // frozen CORRECTLY this time — the corruption below happens to the DRAFT, not the snapshot
    );

    // First GET creates the DRAFT — already correct at this point (route order).
    const firstGet = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    expect(firstGet.body.pricing.legs.map((l: { legId: string }) => l.legId)).toEqual([
      legs[0].legId,
      legs[1].legId,
    ]);

    // Simulate a pre-fix row: reach past the service and flip the persisted draftJson's leg
    // order directly, the way the OLD `buildInitialDraft` (no reorder) could have frozen it.
    const row = await prisma.quotation.findFirstOrThrow({ where: { queryId: query.id } });
    const stored = row.draftJson as { legs: unknown[]; overrides: Record<string, number> };
    await prisma.quotation.update({
      where: { id: row.id },
      data: {
        draftJson: {
          legs: [...stored.legs].reverse(),
          overrides: stored.overrides,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const after = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    // Still route order (L1, L2) — reconstructed live from the Leg table on every read, not
    // trusted from whatever order draftJson happens to store.
    expect(after.body.pricing.legs.map((l: { legId: string }) => l.legId)).toEqual([
      legs[0].legId,
      legs[1].legId,
    ]);
  });

  // ── S5.9.4: register C10 (unguarded patch write) and C11 (false 409 on a no-op patch) ────────

  /** The current quotation row, straight off the DB — the tests below assert on `updatedAt` and on
   *  the persisted money columns, neither of which any DTO can prove on its own. */
  const currentRow = (queryId: string) =>
    prisma.quotation.findFirstOrThrow({ where: { queryId }, orderBy: { version: "desc" } });

  /** Blocks until at least `n` backends on this database are waiting on a lock, or throws.
   *
   *  This is what makes the C10 race test DETERMINISTIC rather than a hopeful `Promise.all`: it is
   *  positive proof that the request we just fired has already got past its own read and is sitting
   *  on the UPDATE. A request that had been refused by `patch()`'s UP-FRONT status check would have
   *  returned immediately and never appeared here — so the test timing out is itself the signal
   *  that the wrong guard fired. */
  const waitForBlockedBackends = async (n: number, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [{ c }] = await prisma.$queryRaw<{ c: number }[]>`
        SELECT count(*)::int AS c FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`;
      if (c >= n) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${n} lock-blocked backends (saw ${c})`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  // 🔴 Register C10 — `patch()` read the row, checked `status !== "DRAFT"`, then wrote on `id`
  // ALONE. A PATCH racing a winning `issue()` could therefore land `marginPct`/`draftJson`/the
  // totals on a quotation that had already gone to the client: the letter says one number, the
  // system of record then says another, with nobody having made a mistake.
  //
  // The race is made deterministic WITHOUT mocking anything: the test opens its own transaction and
  // takes a `SELECT … FOR UPDATE` row lock, then fires the real HTTP issue and the real HTTP PATCH
  // in that order. Postgres queues row-lock waiters FIFO, so when the test releases its lock the
  // issue commits first and the PATCH — which has ALREADY done its read and seen a DRAFT — is the
  // one that has to be refused by the write itself. Both racers are ordinary requests through the
  // real app against the real database.
  //
  // Mutation proof: drop `status: "DRAFT"` from the `updateMany`'s WHERE in `QuotationService.patch`
  // and the PATCH 200s, overwriting the ISSUED row's margin and totals — every assertion below the
  // `.expect(409)` reddens as well, so this cannot pass on a coincidence.
  it(
    "S5.9.4 (C10) — a PATCH that races a winning issue is refused BY THE WRITE, leaving the issued row untouched",
    async () => {
      const { query } = await mkAwardedQuery("c10race");
      await request(app.getHttpServer())
        .get(`/api/queries/${query.id}/quotation`)
        .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
        .expect(200);

      // POSITIVE CONTROL, part 1 — this exact request (same endpoint, same actor, same body shape)
      // succeeds and moves the money while the row is a DRAFT. Whatever refuses it below is
      // therefore about the race, not about the request.
      const control = await request(app.getHttpServer())
        .patch(`/api/queries/${query.id}/quotation`)
        .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
        .send({ marginPct: 10 })
        .expect(200);
      expect(control.body.pricing.clientTotalUsd).toBe(110);

      const before = await currentRow(query.id);
      const expectedUpdatedAt = before.updatedAt.toISOString();

      // The test takes the row lock and holds it until `release()`.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const heldLock = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Quotation" WHERE id = ${before.id}::uuid FOR UPDATE`;
          await gate;
        },
        { timeout: 25_000, maxWait: 15_000 },
      );

      try {
        // Racer 1 — the winner. Queues behind the test's lock at its own UPDATE.
        const issuing = request(app.getHttpServer())
          .post(`/api/queries/${query.id}/quotation/issue`)
          .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
          .send({ recipientEmail: "client-c10race@e2e.test", expectedUpdatedAt });
        const issuePromise = issuing.then((r) => r);
        await waitForBlockedBackends(1);

        // Racer 2 — the loser. Its READ happens now, while the row is still a DRAFT (the issue has
        // not committed), which is precisely the window C10 is about. It then queues second.
        const patching = request(app.getHttpServer())
          .patch(`/api/queries/${query.id}/quotation`)
          .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
          .send({ marginPct: 90 });
        const patchPromise = patching.then((r) => r);
        // Two waiters: the PATCH has passed its own DRAFT check and is on the UPDATE. If the
        // up-front check had been what refused it, it would never have reached a lock at all.
        await waitForBlockedBackends(2);

        release();
        await heldLock;

        const issueRes = await issuePromise;
        const patchRes = await patchPromise;

        expect(issueRes.status).toBe(200);
        expect(issueRes.body.status).toBe("ISSUED");
        expect(issueRes.body.pricing.clientTotalUsd).toBe(110);

        expect(patchRes.status).toBe(409);
        expect(patchRes.body.message).toBe("this quotation is not a draft and can no longer be edited");

        // The row the client was actually sent — untouched by the losing PATCH.
        const after = await currentRow(query.id);
        expect(after.status).toBe("ISSUED");
        expect(Number(after.marginPct)).toBe(10);
        expect(Number(after.clientTotalUsd)).toBe(110);
        expect(Number(after.costTotalUsd)).toBe(100);
        expect((after.issuedSnapshot as unknown as { clientTotalUsd: number }).clientTotalUsd).toBe(110);
        // …and the letter that went out agrees with it.
        expect(after.bodyText).toContain("USD 110.00");
      } finally {
        release();
        await heldLock.catch(() => undefined);
      }
    },
    60_000,
  );

  // 🔴 Register C11, half 1 — Prisma's `@updatedAt` stamps on EVERY update, and no PATCH trigger is
  // dirty-checked, so a PATCH that changed nothing still moved the row's clock. Fixed server-side,
  // because a client-side dirty check cannot cover a DIFFERENT client — which is the whole
  // population `issue()`'s guard exists to protect against.
  //
  // Mutation proof: delete the `if (unchanged) return this.toDto(current);` short-circuit in
  // `QuotationService.patch` and every `toEqual(t1)` below reddens. The last block is the positive
  // control that keeps the comparison honest in the other direction: a PATCH that genuinely drops
  // an override MUST move the clock, so a comparison that simply answered "unchanged" always would
  // redden there instead.
  it("S5.9.4 (C11) — a PATCH that changes nothing writes nothing: updatedAt unmoved, current state returned", async () => {
    const { query, legs } = await mkAwardedRouteQuery(
      "c11noop",
      {
        origin: { type: "PICKUP", city: "Shanghai", country: "CN" },
        mid: { type: "WAREHOUSE", city: "Singapore", country: "SG" },
        dest: { type: "DELIVERY", city: "Dubai", country: "AE" },
      },
      [
        { legCode: "L1", from: "origin", to: "mid" },
        { legCode: "L2", from: "mid", to: "dest" },
      ],
      [0, 1],
    );

    const getRes = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    const keyOf = (i: number) =>
      `${legs[i].legId}:${getRes.body.pricing.legs[i].groups[0].lines[0].id as string}`;
    const [k1, k2] = [keyOf(0), keyOf(1)];

    // A real edit first, so the no-ops below are compared against a NON-trivial state (a margin
    // with a fractional part, and a two-key overrides map) rather than the pristine 0/{} default.
    await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 12.5, overrides: { [k1]: 55, [k2]: 66 } })
      .expect(200);

    const t1 = (await currentRow(query.id)).updatedAt;

    // (a) The exact same state, re-sent — with the overrides map's keys in the OPPOSITE order to
    // the one it was written in (and Postgres `jsonb` has re-sorted the stored copy anyway), and
    // the margin as an equal-but-differently-written number.
    const resend = await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 12.5, overrides: { [k2]: 66, [k1]: 55 } })
      .expect(200);
    expect(resend.body.marginPct).toBe(12.5);
    expect(resend.body.overrides).toEqual({ [k1]: 55, [k2]: 66 });
    expect((await currentRow(query.id)).updatedAt).toEqual(t1);

    // (b) The empty PATCH — nothing supplied at all.
    await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({})
      .expect(200);
    expect((await currentRow(query.id)).updatedAt).toEqual(t1);

    // (c) The literal C11 scenario: "Reset overrides" posted from a second tab that had nothing
    // pinned — here, the same map re-posted wholesale.
    await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ overrides: { [k2]: 66, [k1]: 55 } })
      .expect(200);
    expect((await currentRow(query.id)).updatedAt).toEqual(t1);

    // POSITIVE CONTROL — the comparison must not be so loose that a real edit reads as a no-op.
    // Releasing ONE pin is a genuine change: it must be written, and it must move the clock.
    const real = await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ overrides: { [k1]: 55 } })
      .expect(200);
    expect(real.body.overrides).toEqual({ [k1]: 55 });
    const t2 = (await currentRow(query.id)).updatedAt;
    expect(t2.getTime()).toBeGreaterThan(t1.getTime());
  });

  // 🔴 S5.9.4 review, IMPORTANT — the `draftJson` limb of the no-op comparison had no test that
  // could fail: removing ONLY that limb (keeping margin and both totals) left the suite 37/37 green.
  //
  // The gap is reachable in a single interaction. A pin is KEY PRESENCE, not a value difference:
  // `ChargeEditorTable` prefills the input with `String(line.clientUsd)` — the margin formula's own
  // answer — and deliberately commits a typed value as an override even when it equals that answer
  // (that is the only way to hold a line steady across a later margin change, and was itself the
  // subject of an earlier final-review fix). So a manager can pin a line at exactly the formula
  // value: `marginPct` unmoved, `costTotalUsd` unmoved, `clientTotalUsd` unmoved, and ONLY the
  // overrides map gains a key. Without the `draftJson` limb that PATCH is a silent 200 no-op — the
  // pin is discarded, the clock never moves, and the UI's "Pinned" badge disagrees with the row.
  //
  // Mutation proof: delete ONLY `nextDraftJson === storedDraftJson` (and its two `!== null` guards)
  // from `unchanged` in `QuotationService.patch` and both halves of this test redden.
  it("S5.9.4 (C11) — pinning a line at exactly the margin formula's own value is a real write, even though no total moves", async () => {
    const { query, leg } = await mkAwardedQuery("c11pin");
    const getRes = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    const line = getRes.body.pricing.legs[0].groups[0].lines[0];
    const key = `${leg.id}:${line.id as string}`;
    expect(line.overridden).toBe(false);

    // Give the row a non-zero margin first, so "the formula's own value" is a number the formula
    // actually had to compute rather than the cost passed through unchanged.
    const priced = await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 20 })
      .expect(200);
    const formulaValue = priced.body.pricing.legs[0].groups[0].lines[0].clientUsd as number;
    expect(formulaValue).toBe(120); // round2(100 × 1.20)
    expect(priced.body.pricing.clientTotalUsd).toBe(120);

    const before = await currentRow(query.id);

    // The pin: the SAME number the formula already produces. Nothing about the money moves —
    // margin, cost total and client total are all identical before and after — so this write is
    // visible to the `draftJson` limb of the comparison and to nothing else.
    const pinned = await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ overrides: { [key]: formulaValue } })
      .expect(200);

    expect(pinned.body.overrides).toEqual({ [key]: formulaValue });
    expect(pinned.body.pricing.legs[0].groups[0].lines[0].overridden).toBe(true);
    // Proof the other three limbs are blind to this edit — they see no difference at all.
    expect(pinned.body.marginPct).toBe(20);
    expect(pinned.body.pricing.clientTotalUsd).toBe(120);
    expect(pinned.body.pricing.costTotalUsd).toBe(100);

    const afterPin = await currentRow(query.id);
    expect(Number(afterPin.marginPct)).toBe(20);
    expect(Number(afterPin.clientTotalUsd)).toBe(120);
    expect(Number(afterPin.costTotalUsd)).toBe(100);
    // It was WRITTEN: the pin is persisted and the clock moved, so an in-flight issue is correctly
    // refused rather than sending a letter composed against an un-pinned row.
    expect((afterPin.draftJson as unknown as { overrides: Record<string, number> }).overrides).toEqual({
      [key]: formulaValue,
    });
    expect(afterPin.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    // The mirror case: RELEASING a pin whose value equals the formula is equally invisible to the
    // money and equally a real change.
    const released = await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ overrides: {} })
      .expect(200);
    expect(released.body.overrides).toEqual({});
    expect(released.body.pricing.legs[0].groups[0].lines[0].overridden).toBe(false);
    expect(released.body.pricing.clientTotalUsd).toBe(120); // still no money movement
    const afterRelease = await currentRow(query.id);
    expect((afterRelease.draftJson as unknown as { overrides: Record<string, number> }).overrides).toEqual({});
    expect(afterRelease.updatedAt.getTime()).toBeGreaterThan(afterPin.updatedAt.getTime());
  });

  // S5.9.4 review, MINOR #1 — `marginPct` is `z.number().min(0).max(100)` while the column is
  // `Decimal(5,2)`, and the web client sends `Number(input.value)` unfiltered. A sub-cent margin
  // therefore failed `Decimal.equals` against a stored value Postgres had already rounded it to,
  // making a PATCH that CANNOT change the row a real write — the C11 symptom surviving the C11 fix.
  //
  // Mutation proof: drop `quantizeMargin(...)` from `patch()` (back to
  // `body.marginPct ?? Number(current.marginPct)`) and the two sub-scale blocks redden. The final
  // block is the positive control: a margin that rounds to a DIFFERENT cent must still be a write.
  it("S5.9.4 (C11) — a margin the column cannot store differently is not a difference, but one that rounds to a different cent is", async () => {
    const { query } = await mkAwardedQuery("c11scale");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 12.51 })
      .expect(200);
    const t1 = (await currentRow(query.id)).updatedAt;
    expect(Number((await currentRow(query.id)).marginPct)).toBe(12.51);

    // Both of these are `12.51` the instant Postgres stores them (verified against the live
    // database: `12.505::numeric(5,2)` = `12.51`, `12.514::numeric(5,2)` = `12.51`).
    for (const marginPct of [12.505, 12.514]) {
      const res = await request(app.getHttpServer())
        .patch(`/api/queries/${query.id}/quotation`)
        .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
        .send({ marginPct })
        .expect(200);
      // Returned at the column's own scale, not at the caller's — the response agrees with what a
      // later GET will recompute off the stored value.
      expect(res.body.marginPct).toBe(12.51);
      expect((await currentRow(query.id)).updatedAt).toEqual(t1);
    }

    // POSITIVE CONTROL — `12.516::numeric(5,2)` is `12.52`, a genuinely different stored value.
    const changed = await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 12.516 })
      .expect(200);
    expect(changed.body.marginPct).toBe(12.52);
    const t2 = await currentRow(query.id);
    expect(Number(t2.marginPct)).toBe(12.52);
    expect(t2.updatedAt.getTime()).toBeGreaterThan(t1.getTime());
  });

  // Decision N3 — the DRAFT refusal still applies to a no-op. Accepting one silently would report
  // an already-sent quotation as editable. The DRAFT check therefore runs BEFORE the no-op
  // short-circuit; the second half is the positive control that the very same body is a 200 on a
  // DRAFT, so the 409 is about the row's status and nothing else.
  it("S5.9.4 (N3) — a no-op PATCH against an ISSUED quotation is still refused, though the identical body 200s on a draft", async () => {
    const { query } = await mkAwardedQuery("c11issued");
    await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);

    // POSITIVE CONTROL — margin 0 and an empty overrides map are exactly this draft's current
    // state, i.e. a no-op, and it is accepted while the row is a DRAFT.
    await request(app.getHttpServer())
      .patch(`/api/queries/${query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 0, overrides: {} })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send(await issueBody("c11issued", query.id))
      .expect(200);

    const issued = await currentRow(query.id);
    for (const body of [{}, { marginPct: 0, overrides: {} }]) {
      const res = await request(app.getHttpServer())
        .patch(`/api/queries/${query.id}/quotation`)
        .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
        .send(body)
        .expect(409);
      expect(res.body.message).toBe("this quotation is not a draft and can no longer be edited");
    }
    // Refused, not quietly stamped: the issued row's own clock never moved either.
    expect((await currentRow(query.id)).updatedAt).toEqual(issued.updatedAt);
  });

  // 🔴 Register C11, half 2 — the point of the fix is that `issue()`'s guard stops crying WOLF,
  // never that it fires less. Both halves run the identical sequence (manager A opens the preview,
  // someone else PATCHes, A issues against A's own token); the ONLY difference is whether that
  // intervening PATCH actually changed anything. They must end differently — 200 and 409 — so
  // neither outcome can be reached by a bug that collapses both into one answer.
  //
  // Mutation proof (a): remove the no-op short-circuit and the FIRST half reddens (A's legitimate
  // send is refused, which is C11 itself). Mutation proof (b): loosen the comparison so the genuine
  // reprice is treated as a no-op and the SECOND half reddens — the stale letter goes out.
  it("S5.9.4 (C11) — a no-op PATCH no longer invalidates a pending issue, while a genuine reprice still does", async () => {
    // Half 1 — the false 409 that C11 is about.
    const quiet = await mkAwardedQuery("c11quiet");
    const quietA = await request(app.getHttpServer())
      .get(`/api/queries/${quiet.query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    expect(quietA.body.previewBody).toContain("USD 100.00");

    // A second tab clicks "Reset overrides" with nothing pinned — posts the map unconditionally.
    await request(app.getHttpServer())
      .patch(`/api/queries/${quiet.query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ overrides: {} })
      .expect(200);
    expect((await currentRow(quiet.query.id)).updatedAt.toISOString()).toBe(quietA.body.updatedAt);

    const sent = await request(app.getHttpServer())
      .post(`/api/queries/${quiet.query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({
        recipientEmail: "client-c11quiet@e2e.test",
        bodyText: quietA.body.previewBody,
        expectedUpdatedAt: quietA.body.updatedAt,
      })
      .expect(200);
    expect(sent.body.status).toBe("ISSUED");
    expect(sent.body.pricing.clientTotalUsd).toBe(100);

    // Half 2 — same sequence, but the intervening PATCH genuinely reprices. The guard must still
    // bite, and the clock must still have moved for it to be able to.
    const loud = await mkAwardedQuery("c11loud");
    const loudA = await request(app.getHttpServer())
      .get(`/api/queries/${loud.query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .expect(200);
    expect(loudA.body.previewBody).toContain("USD 100.00");

    await request(app.getHttpServer())
      .patch(`/api/queries/${loud.query.id}/quotation`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ marginPct: 25 })
      .expect(200);
    const repriced = await currentRow(loud.query.id);
    expect(repriced.updatedAt.toISOString()).not.toBe(loudA.body.updatedAt);
    expect(Number(repriced.clientTotalUsd)).toBe(125);

    const refused = await request(app.getHttpServer())
      .post(`/api/queries/${loud.query.id}/quotation/issue`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({
        recipientEmail: "client-c11loud@e2e.test",
        bodyText: loudA.body.previewBody, // the letter quoting the OLD total
        expectedUpdatedAt: loudA.body.updatedAt,
      })
      .expect(409);
    expect(refused.body.message).toContain("repriced");
    expect((await currentRow(loud.query.id)).status).toBe("DRAFT");
  });
});
