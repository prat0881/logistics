process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import type { QuoteDraft, ChargeZone } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

// S5.9 Task 7 (D10) — the stale-page guard on POST .../quotes/:legId/submit. A forwarder's tab
// can sit open long after the token stops rotating (Task 5), so the submit must refuse to price
// against a basis that moved underneath it (quote status / submission deadline / manifest
// snapshot / charge-config snapshot) rather than silently accepting stale terms.
//
// Deliberately NOT `Quote.updatedAt` (see ff-portal.service.ts's `legVersion`): the portal
// autosaves drafts, and `@updatedAt` bumps on every save — that would let the forwarder's own
// typing invalidate their own page. The version is a fingerprint over status/deadline/manifest/
// charge-config only, so a draft PATCH must leave it untouched (test 3 below).
const PFX = "S59STALE";
const CODE = `YAL00-${PFX}`;

describe(`${PFX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  // Mirrors ff-portal-requote-submit.e2e-spec.ts's own cleanup() — self-cleans the comms rows
  // too (ScheduledEvent/MessageLog reference entityId as a plain string, not a Prisma relation).
  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    const queryIds = qs.map((q) => q.id);
    const rfqs = queryIds.length
      ? await prisma.rfq.findMany({ where: { queryId: { in: queryIds } }, select: { id: true } })
      : [];
    const rfqIds = rfqs.map((r) => r.id);

    if (rfqIds.length) {
      await prisma.scheduledEvent.deleteMany({
        where: { entityType: "RFQ", entityId: { in: rfqIds } },
      });
    }
    if (queryIds.length) {
      await prisma.messageLog.deleteMany({
        where: { entityType: "QUERY", entityId: { in: queryIds } },
      });
    }
    for (const q of qs) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items
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
    await app.close();
  });

  /**
   * Build a minimal distribute fixture and return the raw accessToken + the leg id — verbatim
   * pattern from ff-portal-requote-submit.e2e-spec.ts's own distributeFixture (Query -> origin/
   * destination Points -> Cargo->Package (LegPackage-assigned) -> Leg(AIR, READY_FOR_RFQ) ->
   * FreightForwarder -> PUT ff-selection -> POST distribute). Duplicated locally per this
   * codebase's established per-spec-file fixture-builder convention.
   */
  let fixtureSeq = 0;
  async function distributeFixture(): Promise<{ token: string; legId: string }> {
    const admin = cookie(Role.ADMINISTRATOR);
    const seq = ++fixtureSeq;

    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-FIXTURE-${seq}`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `L-${PFX}-${seq}`,
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: `PO-${PFX}-${seq}`, dimL: 10, dimW: 20, dimH: 30, grossWt: 5 }],
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);

    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PFX}-${seq}`,
        companyName: `FF ${PFX} Co ${seq}`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PFX.toLowerCase()}-${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["AIR"],
        handleDg: false,
        defaultCurrency: "USD",
      },
    });

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    const entry = res.body.rfqs[0];
    return { token: entry.accessToken as string, legId: leg.id };
  }

  /**
   * A complete, submittable v4 Air draft built off the GET response body — verbatim copy of
   * ff-portal-requote-submit.e2e-spec.ts's own fullValidDraft (see that file for the full
   * rationale of every field).
   */
  function fullValidDraft(
    legId: string,
    getBody: {
      legs: Array<{
        manifest: {
          cargo: Array<{ packageId: string; grossWt: string; volumeCbm: string | null }>;
        };
        seededCharges: Array<{
          zone: ChargeZone | null;
          definitionKey?: string;
          inputType?: string;
          presetKey: string | null;
          label: string;
        }>;
      }>;
    },
  ): QuoteDraft {
    const leg = getBody.legs[0];
    return {
      legId,
      mode: "AIR",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 125,
      notes: null,
      cargo: leg.manifest.cargo.map((c) => ({
        packageId: c.packageId,
        grossWtKg: Number(c.grossWt),
        cbm: Number(c.volumeCbm ?? 0),
      })),
      charges: leg.seededCharges.map((c) =>
        c.inputType === "HEAVY_WEIGHT_CALC"
          ? {
              zone: c.zone,
              definitionKey: c.definitionKey,
              presetKey: c.presetKey,
              label: c.label,
              amount: null,
              rateVariant: null,
              pieceWeightKg: 4,
              airlineLimitKg: 2,
              ratePerExcessKg: 2.5,
            }
          : {
              zone: c.zone,
              definitionKey: c.definitionKey,
              presetKey: c.presetKey,
              label: c.label,
              amount: 10,
              rateVariant: null,
            },
      ),
      trucking: [],
      seaRates: [],
      warehouse: [],
      transit: {
        departureDate: new Date(Date.now() + 30 * 86400000).toISOString(),
        arrivalDate: new Date(Date.now() + 32 * 86400000).toISOString(),
        guaranteedTransitDaysByVariant: { AIR: 2 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };
  }

  // ── the DTO carries a version at all ──

  it("GET .../rfq/:token returns a non-empty version string on every leg", async () => {
    const { token } = await distributeFixture();
    const res = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    expect(typeof res.body.legs[0].version).toBe("string");
    expect((res.body.legs[0].version as string).length).toBeGreaterThan(0);
  });

  // ── the version guard itself ──

  it("refuses a submit carrying a stale version, with a message telling the forwarder to refresh", async () => {
    const { token, legId } = await distributeFixture();

    const before = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const staleVersion = before.body.legs[0].version as string;

    // The basis changes underneath the open page — a re-quote request lands on this very leg
    // (mirrors ff-portal-requote-submit.e2e-spec.ts's own direct-seed convention for a status the
    // negotiate HTTP surface produces elsewhere, not built by this task).
    const quote = await prisma.quote.findFirstOrThrow({ where: { legId } });
    await prisma.quote.update({ where: { id: quote.id }, data: { status: "REQUOTED" } });

    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: staleVersion })
      .expect(409);
    expect(res.body.message).toMatch(/refresh/i);
  });

  it("accepts a submit carrying the current version (full round-trip to QUOTED)", async () => {
    const { token, legId } = await distributeFixture();

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const draft = fullValidDraft(legId, got.body);
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(draft)
      .expect(200);

    const fresh = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: fresh.body.legs[0].version })
      .expect(201);
    expect(res.body.status).toBe("QUOTED");
  });

  it("rejects a submit with no version / an unrecognised version (400 shape-check, not a 500)", async () => {
    const { token, legId } = await distributeFixture();
    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: "not-a-real-version" })
      .expect(409);
  });

  // ── the trap the design explicitly calls out: an autosave must not self-invalidate ──

  it("a forwarder's own draft save does not change the leg version", async () => {
    const { token, legId } = await distributeFixture();

    const before = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const version = before.body.legs[0].version as string;
    const draft = fullValidDraft(legId, before.body);

    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(draft)
      .expect(200);

    const after = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    expect(after.body.legs[0].version).toBe(version);

    // ...and the version captured before that draft save still submits cleanly — proof the guard
    // truly never saw the autosave as a basis change, not just that the two GETs happened to match.
    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version })
      .expect(201);
  });

  // ── ordering: the brief requires the version guard to run BEFORE the generic status guard, so
  // a stale page gets the actionable message even when the current status is also "not open". ──

  it("orders the version guard first: a stale version against a now-terminal status still gets the refresh message, not the generic one", async () => {
    const { token, legId } = await distributeFixture();

    const before = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const staleVersion = before.body.legs[0].version as string;

    // Move straight to a terminal, non-open status. Both guards would independently 409 this
    // request — the version guard on the mismatched fingerprint, the status guard on QUOTED not
    // being RFQ_SENT/REQUOTED. Whichever runs first determines the message the forwarder sees.
    const quote = await prisma.quote.findFirstOrThrow({ where: { legId } });
    await prisma.quote.update({ where: { id: quote.id }, data: { status: "QUOTED" } });

    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: staleVersion })
      .expect(409);
    expect(res.body.message).toMatch(/refresh/i);
    expect(res.body.message).not.toMatch(/already been submitted/i);
  });

  // ── a REQUOTED forwarder revising their bid (Task 6) must still be able to submit when their
  // page IS current — the version guard must not regress that flow. ──

  it("a REQUOTED leg with a current version still submits (Task 6 regression guard)", async () => {
    const { token, legId } = await distributeFixture();

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const draft = fullValidDraft(legId, got.body);
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(draft)
      .expect(200);

    const quote = await prisma.quote.findFirstOrThrow({ where: { legId } });
    await prisma.quote.update({
      where: { id: quote.id },
      data: { status: "REQUOTED", submittedAt: new Date() },
    });

    const fresh = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    expect(fresh.body.legs[0].status).toBe("REQUOTED");

    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: fresh.body.legs[0].version })
      .expect(201);
    expect(res.body.status).toBe("QUOTED");
  });
});
