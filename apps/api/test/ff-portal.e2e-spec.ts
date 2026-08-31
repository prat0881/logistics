process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
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

const PREFIX = "FF-PORTAL";
const CODE = `YAL00-${PREFIX}`;

describe("GET /ff/rfq/:token (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  // S5.9.5 Task 7 — the award endpoints stamp `actorId`/`sentByUserId`/`decidedByUserId`, all
  // `@db.Uuid`; `cookie()`'s `sub: "u-ADMINISTRATOR"` 500s on Prisma P2023 against those columns.
  const cookieFor = (userId: string, role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role, tenantId: null })}`;

  // Self-clean the comms rows too (Task 11): ScheduledEvent/MessageLog reference entityId
  // as a plain string, not a Prisma relation, so they survive a Query/Rfq delete.
  // Notification.queryId IS a real relation (onDelete: Cascade), so those cascade for free.
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
      // S5.9.6 — the A6 test drives `request-requote`, whose `rfq.requote_requested` dispatch is
      // scoped to the RFQ (negotiation.service.ts), not the query, so the QUERY-scoped sweep below
      // would leave those rows behind.
      await prisma.messageLog.deleteMany({
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
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items/notifications
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: `${PREFIX.toLowerCase()}-exec-` } },
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

  /**
   * Build a minimal distribute fixture and return the raw accessToken + the leg id.
   * Creates Query → origin/destination Points → Cargo→Package (LegPackage-assigned) →
   * Leg(AIR, READY_FOR_RFQ) → FreightForwarder → PUT ff-selection → POST distribute.
   * The distribute response carries rfqs[0].accessToken.
   */
  let fixtureSeq = 0;
  async function distributeFixture(
    execUserId?: string,
    opts?: { warehouseIncluded?: boolean },
  ): Promise<{ token: string; legId: string; queryId: string; rfqId: string }> {
    const admin = cookie(Role.ADMINISTRATOR);
    const seq = ++fixtureSeq;

    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-FIXTURE-${seq}`, incoterms: "FOB", assignedUserId: execUserId },
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
        legCode: `L-${PREFIX}-${seq}`,
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        warehouseHandlingIncluded: opts?.warehouseIncluded ?? false,
      },
    });
    // F1 (leg completeness) now gates on >=1 assigned package via LegPackage, not the dropped
    // flat CargoItem/LegCargo model — see helpers/cargo.ts.
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: `PO-${PREFIX}-${seq}`, dimL: 10, dimW: 20, dimH: 30, grossWt: 5 }],
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);

    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-${seq}`,
        companyName: `FF ${PREFIX} Co ${seq}`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PREFIX.toLowerCase()}-${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["AIR"],
        handleDg: false,
        defaultCurrency: "USD",
      },
    });

    // Select FF to mint the SELECT quote
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    // Distribute → mints the RFQ + returns accessToken
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    const entry = res.body.rfqs[0];
    expect(entry.accessToken).toBeDefined();
    return {
      token: entry.accessToken as string,
      legId: leg.id,
      queryId: query.id,
      rfqId: entry.rfqId as string,
    };
  }

  /**
   * Build a complete valid v3 Air draft from the GET response body (mirrors
   * ff-portal-grain.e2e-spec.ts / charge-config-distribute.e2e-spec.ts's fullValidDraft).
   * - chargedWeightKg: one leg-level FF-entered value (v3 — was per-package pre-v3); grossWtKg/cbm
   *   stay display-only, re-derived from the manifest server-side at submit regardless of what's
   *   sent here (satisfies Q_WEIGHT)
   * - charges: every PLAIN preset priced at amount=10, each carrying rateVariant: null (Air's
   *   single implicit column, unchanged by Round 4 — Air's charges were always common); the
   *   HEAVY_WEIGHT_CALC line (AIR_MAIN_HEAVY_WEIGHT) priced via its 3 calc inputs instead
   *   (satisfies Q_PRICED). pieceWeightKg is kept <= distributeFixture's package grossWt (5kg) —
   *   Round 4's Q_PIECE_WEIGHT (design D4, quote-engine.ts) blocks a piece heavier than the whole
   *   manifested shipment.
   * - trucking/seaRates/warehouse: empty (no trucking/warehouse endpoints in fixture; mode AIR
   *   never gates on Q_RATE)
   * - transit: departure + arrival + guaranteedTransitDaysByVariant.AIR set (satisfies Q_TRANSIT).
   *   Dates are kept ahead of "now" — Round 4's Q_PAST_DATE (design D3) unconditionally blocks any
   *   FF-entered datetime earlier than the real submit-time clock.
   * - currency: USD (satisfies Q_CURRENCY)
   * - quoteValidityUntil: after the RFQ deadline (satisfies Q_VALIDITY)
   * - no DG-specific submit gate (QuoteDraftCargo has no isDangerous field) → dgSurchargeNote: null
   * The return type is annotated `QuoteDraft` so the compiler — not just the runtime Zod schema —
   * enforces the v3 shape.
   */
  function fullValidDraft(
    legId: string,
    getBody: {
      legs: Array<{
        // S5.9.5 Task 7 — the multi-leg fixture below needs a draft for a NAMED leg, so this picks
        // the matching entry rather than assuming `legs[0]`. Single-leg callers are unaffected
        // (their only leg IS the match); the `?? legs[0]` fallback preserves the old behaviour for
        // any caller passing a body whose legs predate this field.
        legId?: string;
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
    const leg = getBody.legs.find((l) => l.legId === legId) ?? getBody.legs[0];
    return {
      legId,
      mode: "AIR",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 125, // v3: one leg-level chargeable weight (was per-package)
      notes: null,
      cargo: leg.manifest.cargo.map((c) => ({
        packageId: c.packageId,
        grossWtKg: Number(c.grossWt),
        cbm: Number(c.volumeCbm ?? 0),
      })),
      // seededCharges are keyed by definitionKey (frozen from chargeConfigSnapshot); presetKey is
      // always null (kept only for shape compatibility, per FfPortalSeededCharge). rateVariant:
      // null on every cell — Air's single implicit column (v3).
      charges: leg.seededCharges.map((c) =>
        c.inputType === "HEAVY_WEIGHT_CALC"
          ? {
              zone: c.zone,
              definitionKey: c.definitionKey,
              presetKey: c.presetKey,
              label: c.label,
              amount: null,
              rateVariant: null,
              pieceWeightKg: 4, // <= distributeFixture's 5kg package gross weight (Q_PIECE_WEIGHT)
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

  it("GET resolves the scoped RFQ with seeded charges + the per-package manifest (no auth cookie)", async () => {
    const { token, legId } = await distributeFixture();

    const res = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200); // NO cookie

    expect(res.body.rfqNumber).toMatch(/-RFQ/);
    expect(res.body.currency).toBe("USD"); // Rfq.currency ?? FF.defaultCurrency
    expect(res.body.legs).toHaveLength(1);

    const leg = res.body.legs[0];
    expect(leg.legId).toBe(legId);
    expect(leg.manifest.cargo.length).toBeGreaterThan(0); // from the frozen snapshot
    expect(leg.seededCharges.map((c: { definitionKey: string }) => c.definitionKey)).toContain(
      "AIR_MAIN_FREIGHT",
    ); // Air cores (Task 9: seededCharges now keyed by definitionKey, frozen from chargeConfigSnapshot)
    // v2 dropped the whole density model — no FreightDensityFactor/seededDensity concept survives
    // on the DTO. The replacement grain proof: the manifest is package-grain (packageId, no
    // cargoItemId), and there's no pre-seeded PRICING value anywhere — v3: resolveScope seeds a
    // starter QuoteDraft (the per-variant charge matrix) rather than `null` once the leg has >=1
    // active charge-config line (design §5; AIR_MAIN_FREIGHT above proves this leg does) — so "no
    // pre-seeded value" now means the seeded draft's chargedWeightKg/notes are unset, not that the
    // draft itself is null.
    expect(leg).not.toHaveProperty("seededDensity");
    expect(leg.manifest.cargo[0]).toMatchObject({ packageId: expect.any(String) });
    expect(leg.manifest.cargo[0]).not.toHaveProperty("cargoItemId");
    expect(leg.draft).not.toBeNull();
    expect(leg.draft.chargedWeightKg).toBeNull(); // Charged Wt starts unset, not defaulted
    expect(leg.draft.notes).toBeNull();
  });

  it("rejects a bad token with 401", async () => {
    await request(app.getHttpServer()).get("/api/ff/rfq/deadbeef").expect(401);
  });

  it("PATCH saves a draft and GET resumes it; a foreign leg is 403", async () => {
    const { token, legId } = await distributeFixture();
    const draft = {
      legId,
      mode: "AIR",
      currency: "EUR",
      quoteValidityUntil: "2026-09-01T00:00:00.000Z",
      chargedWeightKg: null,
      notes: null,
      cargo: [],
      charges: [
        {
          zone: "ORIGIN",
          presetKey: "AIR_ORIGIN_THC",
          label: "Origin THC",
          amount: 42,
          rateVariant: null,
        },
      ],
      trucking: [],
      seaRates: [],
      warehouse: [],
      transit: null,
      dgSurchargeNote: null,
      termsConditions: null,
    };
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(draft)
      .expect(200);
    const res = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    expect(res.body.legs[0].draft.charges[0].amount).toBe(42);
    expect(res.body.currency).toBe("EUR"); // upserted to Rfq
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/00000000-0000-0000-0000-000000000000`)
      .send(draft)
      .expect(403);
  });

  // ── submit tests ──

  it("submit: valid Air quote → 201 QUOTED, leg rolls up, child tables populated", async () => {
    const { token, legId } = await distributeFixture();

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);

    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(fullValidDraft(legId, got.body))
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: got.body.legs[0].version })
      .expect(201);

    expect(res.body.status).toBe("QUOTED");
    expect(res.body.quoteId).toBeDefined();

    const q = await prisma.quote.findFirst({
      where: { legId },
      include: { chargeLines: true, quoteCargoLines: true },
    });
    expect(q?.status).toBe("QUOTED");
    expect(q?.submittedAt).not.toBeNull();
    expect(q?.chargeLines.length).toBeGreaterThan(0);
    expect(q?.quoteCargoLines.length).toBeGreaterThan(0);
    expect(Number(q?.grandTotal)).toBeGreaterThan(0);

    const leg = await prisma.leg.findUnique({ where: { id: legId } });
    expect(leg?.status).toBe("FULLY_QUOTED"); // only FF on the leg
  });

  it("submit: missing charged weight/currency → 422 findings, Quote stays RFQ_SENT", async () => {
    const { token, legId } = await distributeFixture();
    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);

    // PATCH a draft that is missing currency and chargedWeightKg (v3: the one leg-level
    // Chargeable Weight — Q_WEIGHT gates directly on it now, not a per-package derivation) + no
    // charges. Submit re-derives draft.cargo from the FROZEN manifest regardless of `cargo: []`
    // here (ff-portal.service.ts's submit()), but chargedWeightKg/notes pass through from the
    // stored draft as-is — leaving it null is what trips Q_WEIGHT.
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send({
        legId,
        mode: "AIR",
        currency: null,
        quoteValidityUntil: null,
        chargedWeightKg: null,
        notes: null,
        cargo: [],
        charges: [],
        trucking: [],
        seaRates: [],
        warehouse: [],
        transit: null,
        dgSurchargeNote: null,
        termsConditions: null,
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: got.body.legs[0].version })
      .expect(422);

    expect(res.body.findings.map((f: { rule: string }) => f.rule)).toEqual(
      expect.arrayContaining(["Q_WEIGHT", "Q_CURRENCY"]),
    );

    const q = await prisma.quote.findFirst({ where: { legId } });
    expect(q?.status).toBe("RFQ_SENT");
  });

  it("submit: past the deadline → 422 with Q_DEADLINE", async () => {
    const { token, legId } = await distributeFixture();

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);

    // Find the rfq via the quote/leg and force the deadline into the past
    const q = await prisma.quote.findFirst({ where: { legId }, select: { rfqId: true } });
    await prisma.rfq.update({
      where: { id: q!.rfqId! },
      data: { submissionDeadline: new Date(Date.now() - 1000) },
    });

    // PATCH a valid draft
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(fullValidDraft(legId, got.body))
      .expect(200);

    // The deadline mutation above changed the leg's version (it's part of the fingerprint, S5.9
    // D10) — a fresh GET so the submit below exercises Q_DEADLINE specifically, not an incidental
    // stale-version 409 from `got`'s now-superseded version.
    const current = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);

    // POST submit → should fail with Q_DEADLINE (deadline passed)
    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: current.body.legs[0].version })
      .expect(422);

    expect(res.body.findings.map((f: { rule: string }) => f.rule)).toEqual(
      expect.arrayContaining(["Q_DEADLINE"]),
    );
  });

  it("submit: an already-QUOTED quote → 409", async () => {
    const { token, legId } = await distributeFixture();

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);

    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(fullValidDraft(legId, got.body))
      .expect(200);

    // First submit → 201 QUOTED
    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: got.body.legs[0].version })
      .expect(201);

    // Second submit → 409 (already submitted). Fresh GET so this exercises the STATUS guard (the
    // point of this test) rather than the version guard — the first submit changed the leg's
    // status, which changed its version too (S5.9 D10).
    const after = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: after.body.legs[0].version })
      .expect(409);
  });

  it("submit logs an acknowledgement + notifies the Executive + cancels reminders", async () => {
    const seq = ++fixtureSeq;
    const exec = await prisma.user.create({
      data: {
        name: "FF Portal Exec",
        email: `${PREFIX.toLowerCase()}-exec-${seq}@e2e.test`,
        passwordHash: "x",
        role: "EXECUTIVE",
      },
    });

    const { token, legId, queryId, rfqId } = await distributeFixture(exec.id);

    // sanity: distribute already seeded live future-tier reminders anchored to this RFQ —
    // proves the later "0 live reminders" assertion actually exercises the cancel(), not
    // vacuously true because none were ever scheduled.
    const remindersBefore = await prisma.scheduledEvent.count({
      where: {
        entityType: "RFQ",
        entityId: rfqId,
        eventKey: "rfq.reminder",
        firedAt: null,
        cancelledAt: null,
      },
    });
    expect(remindersBefore).toBeGreaterThan(0);

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);

    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(fullValidDraft(legId, got.body))
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: got.body.legs[0].version })
      .expect(201);

    const ack = await prisma.messageLog.count({
      where: { entityId: queryId, eventKey: "rfq.submission_ack" },
    });
    expect(ack).toBeGreaterThanOrEqual(1);

    const notif = await prisma.notification.count({
      where: { recipientUserId: exec.id, type: "quote.received" },
    });
    expect(notif).toBeGreaterThanOrEqual(1);

    const liveReminders = await prisma.scheduledEvent.count({
      where: {
        entityType: "RFQ",
        entityId: rfqId,
        eventKey: "rfq.reminder",
        firedAt: null,
        cancelledAt: null,
      },
    });
    expect(liveReminders).toBe(0);
  });

  // ── Opus whole-branch review: security / immutability tests ──

  it("submit: foreign point in warehouse → 422 SCOPE, Quote stays RFQ_SENT", async () => {
    // Task 9: warehouse draft rows are gated on the leg's frozen warehouseIncluded — must be
    // true here, else the tampered warehouse array is discarded (as unauthorized) BEFORE the
    // SCOPE check ever sees it, which would make this test vacuous.
    const { token, legId } = await distributeFixture(undefined, { warehouseIncluded: true });

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);

    // Build a valid draft but inject a foreign warehousePointId
    const tampered = {
      ...fullValidDraft(legId, got.body),
      warehouse: [
        {
          warehousePointId: "00000000-0000-0000-0000-000000000000",
          position: "ORIGIN",
          label: "X",
          amount: 10,
        },
      ],
    };

    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(tampered)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: got.body.legs[0].version })
      .expect(422);

    // Must contain a SCOPE finding referencing the foreign point
    expect(
      res.body.findings.some(
        (f: { rule: string; scope?: { type: string } }) =>
          f.rule === "SCOPE" || f.scope?.type === "point",
      ),
    ).toBe(true);

    // Quote must NOT have been persisted
    const q = await prisma.quote.findFirst({ where: { legId } });
    expect(q?.status).toBe("RFQ_SENT");
  });

  it("C1: GM-entered package weight is frozen as canonical kg in the manifest", async () => {
    // Arrange: create a Cargo with weightUnit=GM, then a Package with grossWt=5000 (= 5 kg) —
    // routed through the REAL cargo/package HTTP controllers (not helpers/cargo.ts, which only
    // builds rows at already-canonical cm/kg directly via Prisma — this test's whole point is the
    // entry-unit -> canonical conversion PackageService.create performs via toCanonicalWeight).
    const admin = cookie(Role.ADMINISTRATOR);
    const seq = ++fixtureSeq;
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-GM-${seq}`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });

    const cargoRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/cargo`)
      .set("Cookie", admin)
      .send({ label: "GmWidget", dimUnit: "CM", weightUnit: "GM" })
      .expect(201);
    const cargoId = cargoRes.body.id as string;

    const pkgRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/cargo/${cargoId}/packages`)
      .set("Cookie", admin)
      .send({
        packageNo: `PK-GM-${seq}`,
        packageType: "BOX",
        dimL: 10,
        dimW: 10,
        dimH: 10,
        grossWt: 5000,
      }) // 5000 GM = 5 kg
      .expect(201);
    const packageId = pkgRes.body.id as string;

    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `L-${PREFIX}-GM-${seq}`,
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    await assignPackagesToLeg(prisma, leg.id, [packageId]);

    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-GM-${seq}`,
        companyName: `FF GM Co ${seq}`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-gm-${seq}@e2e.test`,
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
    const distRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const token = distRes.body.rfqs[0].accessToken as string;

    // Act: resolve the FF portal — manifest.cargo[].grossWt should be kg-normalized
    const portalRes = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);

    // The frozen manifest grossWt must be kg-normalised (5000 GM → 5 kg)
    const manifestCargo = portalRes.body.legs[0].manifest.cargo;
    expect(manifestCargo).toHaveLength(1);
    expect(Number(manifestCargo[0].grossWt)).toBeCloseTo(5, 6); // 5 kg, NOT 5000
    // v3: resolveScope seeds a starter draft (the per-variant matrix) once the leg has active
    // charge-config lines rather than returning null — the manifest is still the ground truth for
    // grossWt/cbm (re-derived server-side at submit regardless of the draft), it's just no longer
    // signalled by a null draft.
    expect(portalRes.body.legs[0].draft).not.toBeNull();
  });

  it("submit: tampered cargo immutables (grossWtKg/cbm) are ignored — server re-derives from the manifest", async () => {
    const { token, legId } = await distributeFixture();

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);

    // Build a valid draft, then tamper the display-only cargo immutables (grossWtKg/cbm) — v2
    // dropped isDangerous from QuoteDraftCargo entirely (no DG-specific submit gate survives the
    // re-model, see ff-portal-grain.e2e-spec.ts's header comment), so there's nothing analogous
    // to tamper there any more; chargedWeightKg is left honest (v3: it's a separate leg-level
    // field on the draft, not part of `cargo` at all any more — tampering it would just change
    // the legitimate price, not prove anything about server-side immutability of cargo).
    const base = fullValidDraft(legId, got.body);
    const tampered = {
      ...base,
      cargo: base.cargo.map((c: { packageId: string }) => ({
        ...c,
        grossWtKg: 9999,
        cbm: 9999,
      })),
    };

    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(tampered)
      .expect(200);

    // Submit must succeed — grossWtKg/cbm are re-derived from the frozen manifest at submit
    // (ff-portal.service.ts never reads them off the stored draft), so the tampered values have
    // no effect at all.
    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: got.body.legs[0].version })
      .expect(201);

    expect(res.body.status).toBe("QUOTED");

    // Persisted chargedWeightKg reflects the honest FF-entered value from fullValidDraft (125),
    // never the tampered 9999 — v3: chargedWeightKg lives on Quote (leg-level), not
    // QuoteCargoLine, which (both pre- and post-v3) has no grossWt/cbm column at all, so those
    // tampered fields structurally cannot leak into any persisted table.
    const q = await prisma.quote.findFirst({
      where: { legId },
      include: { quoteCargoLines: true },
    });
    expect(q?.quoteCargoLines.length).toBeGreaterThan(0);
    expect(Number(q!.chargedWeightKg)).toBe(125);

    // The frozen manifest itself (server-side truth) is untouched by the client's tampered draft.
    const manifest = q!.manifestSnapshot as { cargo: Array<{ grossWt: string }> };
    expect(Number(manifest.cargo[0].grossWt)).toBeLessThan(100);
  });

  // progress.md Task-9 MINOR #2: "seaRates unpriced-filter has NO e2e (trucking tested; SEA
  // correct by inspection — no SEA-mode submit spec exists) — add in Unit 5." This file is the
  // canonical FF-portal GET/submit spec, so it's the natural home — mirrors
  // ff-portal-grain.e2e-spec.ts's proven ROAD dual-rate-with-one-blank-row equivalent.
  it("submit: SEA dual-rate — only the priced rate variant materializes as a SeaFreightRate row", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const seq = ++fixtureSeq;
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-SEA-${seq}`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: `PK-SEA-${seq}`, dimL: 100, dimW: 100, dimH: 100, grossWt: 500 }],
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `L-${PREFIX}-SEA-${seq}`,
        mode: "SEA",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);

    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-SEA-${seq}`,
        companyName: `FF SEA Co ${seq}`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PREFIX.toLowerCase()}-sea-${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["SEA"],
        handleDg: false,
        defaultCurrency: "USD",
      },
    });
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    const distRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const token = distRes.body.rfqs[0].accessToken as string;

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const legDto = got.body.legs[0];

    // FCL priced; LCL row present but amount left blank — Q_RATE only requires ONE of the two SEA
    // variants filled, so this is a legitimate, submittable draft. seededCharges here are the 5
    // SEA CORE PLAIN origin lines (SEA_MAIN_FREIGHT is retired/inactive — sea freight prices via
    // seaRates instead); v3: charges are per-variant matrix cells, so each is priced under FCL
    // only ($10 x 5 = $50) — v4 (Round 4): charges are COMMON (rateVariant: null, one row per
    // definitionKey) — they fold into EVERY seaRates column equally, not just FCL's. LCL is left
    // completely untouched on its OWN freight rate, proving it stays a legitimate blank column
    // rather than needing its own rate too (freight stays per-variant, only charges went common).
    const draft = {
      legId: leg.id,
      mode: "SEA",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 520, // v3: one leg-level chargeable weight (was per-package)
      notes: null,
      cargo: legDto.manifest.cargo.map(
        (c: { packageId: string; grossWt: string; volumeCbm: string | null }) => ({
          packageId: c.packageId,
          grossWtKg: Number(c.grossWt),
          cbm: Number(c.volumeCbm ?? 0),
        }),
      ),
      charges: legDto.seededCharges.map(
        (c: { zone: string | null; definitionKey: string; label: string }) => ({
          zone: c.zone,
          definitionKey: c.definitionKey,
          presetKey: null,
          label: c.label,
          amount: 10,
          rateVariant: null,
        }),
      ),
      trucking: [],
      seaRates: [
        { rateVariant: "FCL", containerSize: "FORTY", amount: 1800, remarks: "FCL priced" },
        { rateVariant: "LCL", containerSize: null, amount: null },
      ],
      warehouse: [],
      transit: {
        // Relative to submit-time "now" (unconditional Q_PAST_DATE, design D3) — see the
        // 86400000 note on fullValidDraft's transit block above.
        departureDate: new Date(Date.now() + 30 * 86400000).toISOString(),
        arrivalDate: new Date(Date.now() + 39 * 86400000).toISOString(),
        // v4 (Round 4): Sea's Guaranteed Transit Time is now ONE common value (keyed by
        // SEA_VARIANT_KEY = "SEA"), not per-FCL/LCL — a single vessel/voyage doesn't arrive twice.
        guaranteedTransitDaysByVariant: { SEA: 9 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };

    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${leg.id}`)
      .send(draft)
      .expect(200);
    // Before Task 9's post-review fix: `seaFreightRate.create`'s `amount: r.amount!` force-
    // unwraps null onto a NOT NULL column for the (legitimately blank) LCL row — this would crash
    // instead of succeeding, even though the draft is fully valid per Q_RATE (>=1 of the two
    // variants filled is enough to submit).
    const submitRes = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${leg.id}/submit`)
      .send({ version: legDto.version })
      .expect(201);
    expect(submitRes.body.status).toBe("QUOTED");

    // Exactly ONE SeaFreightRate persisted — the unpriced LCL row is dropped entirely rather than
    // written with a null (or 0-substituted) amount.
    const rates = await prisma.seaFreightRate.findMany({
      where: { quoteId: submitRes.body.quoteId },
    });
    expect(rates).toHaveLength(1);
    expect(rates[0]!.rateVariant).toBe("FCL");
    expect(Number(rates[0]!.amount)).toBe(1800);

    // Quote.grandTotal = the engine's MAX variant grand total: FCL = 1800 (rate) + $50 (COMMON
    // charges, v4) + $0 warehouse = 1850; LCL (its own rate untouched) = 0 (rate) + $50 (the SAME
    // common charges — they fold into every variant) + $0 = 50. max(1850, 50) = 1850.
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: submitRes.body.quoteId } });
    expect(Number(quote.grandTotal)).toBe(1850);
  });

  // ── Round 4 (charge-model & UX refinements, Task 2): common charges + per-mode transit ──
  // Task 1 (packages/shared) made every `draft.charges` row COMMON (rateVariant: null, one row per
  // definitionKey or custom line, priced once — not once per rate-variant column) and collapsed
  // Sea's Guaranteed Transit Time to ONE value (SEA_VARIANT_KEY, materializing as a single
  // TransitPlan row with rateVariant: null — a vessel/voyage doesn't arrive twice for FCL vs LCL).
  // This is Task 2's own RED->GREEN proof that ff-portal.service.ts's materialize was brought in
  // line: a common ChargeLine per priced line (incl. a custom [+ Add Charge] line, which must
  // round-trip through GET afterwards), per-variant SeaFreightRate as always, exactly ONE
  // TransitPlan (not one per priced seaRates column), and Quote.grandTotal = the max variant total
  // (freight(v) + the common additionalChargeSum + warehouseSum).
  it("submit: SEA — common charges + a custom line + per-variant freight + ONE Sea GTT → common ChargeLines (rateVariant null), custom line round-trips, ONE Sea TransitPlan, grandTotal = max variant (Round 4)", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const seq = ++fixtureSeq;
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-R4SEA-${seq}`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: `PK-R4SEA-${seq}`, dimL: 100, dimW: 100, dimH: 100, grossWt: 500 }],
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `L-${PREFIX}-R4SEA-${seq}`,
        mode: "SEA",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);

    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-R4SEA-${seq}`,
        companyName: `FF R4 SEA Co ${seq}`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PREFIX.toLowerCase()}-r4sea-${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["SEA"],
        handleDg: false,
        defaultCurrency: "USD",
      },
    });
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    const distRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const token = distRes.body.rfqs[0].accessToken as string;

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const legDto = got.body.legs[0];
    // sanity: the 5 SEA CORE lines seed as ONE common row each (v4) — not fanned across FCL/LCL.
    expect(legDto.draft.charges).toHaveLength(5);
    expect(
      (legDto.draft.charges as { rateVariant: null }[]).every((c) => c.rateVariant === null),
    ).toBe(true);

    const draft = {
      legId: leg.id,
      mode: "SEA",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 520,
      notes: null,
      cargo: legDto.manifest.cargo.map(
        (c: { packageId: string; grossWt: string; volumeCbm: string | null }) => ({
          packageId: c.packageId,
          grossWtKg: Number(c.grossWt),
          cbm: Number(c.volumeCbm ?? 0),
        }),
      ),
      // the 5 seeded CORE lines priced at $10 each ($50) PLUS one ad-hoc [+ Add Charge] custom
      // line ($25, no definitionKey/presetKey — the "custom-line tolerance") — every row common.
      charges: [
        ...legDto.seededCharges.map(
          (c: { zone: string | null; definitionKey: string; label: string }) => ({
            zone: c.zone,
            definitionKey: c.definitionKey,
            presetKey: null,
            label: c.label,
            amount: 10,
            rateVariant: null,
          }),
        ),
        {
          zone: null,
          definitionKey: null,
          presetKey: null,
          label: "Special handling fee",
          amount: 25,
          rateVariant: null,
          note: "customer-requested crating",
        },
      ],
      trucking: [],
      // per-variant freight, unchanged by Round 4 — both FCL and LCL priced differently so the
      // MAX-variant grandTotal logic is unambiguous.
      seaRates: [
        { rateVariant: "FCL", containerSize: "FORTY", amount: 1800, remarks: "FCL priced" },
        { rateVariant: "LCL", containerSize: null, amount: 900, remarks: "LCL priced" },
      ],
      warehouse: [],
      transit: {
        // Relative to submit-time "now" (unconditional Q_PAST_DATE, design D3) — see the
        // 86400000 note on fullValidDraft's transit block above.
        departureDate: new Date(Date.now() + 30 * 86400000).toISOString(),
        arrivalDate: new Date(Date.now() + 39 * 86400000).toISOString(),
        // ONE common Sea GTT (SEA_VARIANT_KEY) covering both FCL and LCL.
        guaranteedTransitDaysByVariant: { SEA: 12 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };

    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${leg.id}`)
      .send(draft)
      .expect(200);
    const submitRes = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${leg.id}/submit`)
      .send({ version: legDto.version })
      .expect(201);
    expect(submitRes.body.status).toBe("QUOTED");
    const quoteId = submitRes.body.quoteId as string;

    // ── common ChargeLines: 6 rows (5 catalogue + 1 custom), EVERY one rateVariant: null ──
    const chargeLines = await prisma.chargeLine.findMany({ where: { quoteId } });
    expect(chargeLines).toHaveLength(6);
    expect(chargeLines.every((c) => c.rateVariant === null)).toBe(true);
    const customLine = chargeLines.find((c) => c.definitionKey === null);
    expect(customLine).toBeDefined();
    expect(customLine?.presetKey).toBeNull();
    expect(customLine?.label).toBe("Special handling fee");
    expect(Number(customLine?.amount)).toBe(25);
    expect(customLine?.note).toBe("customer-requested crating");

    // ── freight stays per-variant: both SeaFreightRate rows persist ──
    const seaRates = await prisma.seaFreightRate.findMany({ where: { quoteId } });
    expect(seaRates).toHaveLength(2);
    expect(seaRates.find((r) => r.rateVariant === "FCL")?.amount.toString()).toBe("1800");
    expect(seaRates.find((r) => r.rateVariant === "LCL")?.amount.toString()).toBe("900");

    // ── exactly ONE Sea TransitPlan (rateVariant: null) — NOT one per priced seaRates column ──
    const transitPlans = await prisma.transitPlan.findMany({ where: { quoteId } });
    expect(transitPlans).toHaveLength(1);
    expect(transitPlans[0]!.rateVariant).toBeNull();
    expect(transitPlans[0]!.guaranteedTransitDays).toBe(12);

    // ── Quote.grandTotal = max variant: FCL = 1800 + 75 (50 common + 25 custom) + 0 = 1875;
    //    LCL = 900 + 75 + 0 = 975. max(1875, 975) = 1875. ──
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
    expect(Number(quote.grandTotal)).toBe(1875);

    // ── GET round-trips the submitted draft (design §6 finding #8): custom line + common
    //    rateVariant + the ONE Sea GTT key all survive a fresh request, not a blank reseed. ──
    const after = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const afterDraft = after.body.legs[0].draft;
    expect(afterDraft.charges).toHaveLength(6);
    expect(afterDraft.charges.every((c: { rateVariant: null }) => c.rateVariant === null)).toBe(
      true,
    );
    const afterCustom = afterDraft.charges.find(
      (c: { label: string }) => c.label === "Special handling fee",
    );
    expect(afterCustom?.amount).toBe(25);
    expect(afterCustom?.note).toBe("customer-requested crating");
    expect(afterDraft.transit.guaranteedTransitDaysByVariant).toEqual({ SEA: 12 });
  });

  // Task 2 (Round 4) carry-forward proof, UPDATED for the Road-mandatory reversal: the user
  // reversed Round 3's "freight required Air/Sea, optional Road" rule — Road trucking is now
  // REQUIRED, symmetric with Sea. `validateQuote` is IMPORTED wholesale from `@svyft/shared` into
  // ff-portal.service.ts (never mirrored), so this propagates to the API automatically — this test
  // pins the HTTP-level contract end to end: a Road submit with NO trucking rate anywhere is now
  // REJECTED (422, Q_RATE) exactly like Sea, common charges alone no longer carry it; a Road
  // submit WITH its own trucking rate still succeeds (201/QUOTED), same as before.
  it("submit: ROAD is REJECTED without a trucking rate, even with priced common charges (Round 4: freight now required); succeeds once its own trucking rate is set; SEA is still rejected without its own freight rate", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const seq = ++fixtureSeq;

    // ── ROAD half ──
    const roadQuery = await prisma.query.create({
      data: { queryCode: `${CODE}-R4GATE-ROAD-${seq}`, incoterms: "FOB" },
    });
    const roadOrigin = await prisma.point.create({
      data: { queryId: roadQuery.id, type: "PICKUP", country: "CN" },
    });
    const roadDest = await prisma.point.create({
      data: { queryId: roadQuery.id, type: "DELIVERY", country: "AE" },
    });
    const roadLeg = await prisma.leg.create({
      data: {
        queryId: roadQuery.id,
        legCode: `L-${PREFIX}-R4GATE-ROAD-${seq}`,
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: roadOrigin.id,
        destinationPointId: roadDest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    const { packageIds: roadPkgIds } = await createCargoWithPackages(prisma, {
      queryId: roadQuery.id,
      packages: [{ packageNo: `PK-R4GATE-ROAD-${seq}`, dimL: 10, dimW: 20, dimH: 30, grossWt: 5 }],
    });
    await assignPackagesToLeg(prisma, roadLeg.id, roadPkgIds);
    // Road has no CORE PLAIN lines — explicitly select one STANDARD line so there's an active
    // common charge to price (mirrors ff-portal-v3.e2e-spec.ts's distributeRoadFixture).
    const tailLift = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "ROAD_STD_TAIL_LIFT" },
    });
    await prisma.legChargeLineSelection.create({
      data: { legId: roadLeg.id, definitionId: tailLift.id },
    });
    const roadFf = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-R4GR-${seq}`,
        companyName: `FF R4 Gate Road Co ${seq}`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PREFIX.toLowerCase()}-r4gr-${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        handleDg: false,
        defaultCurrency: "USD",
      },
    });
    await request(app.getHttpServer())
      .put(`/api/queries/${roadQuery.id}/legs/${roadLeg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [roadFf.id] })
      .expect(200);
    const roadDist = await request(app.getHttpServer())
      .post(`/api/queries/${roadQuery.id}/legs/${roadLeg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const roadToken = roadDist.body.rfqs[0].accessToken as string;

    const roadGot = await request(app.getHttpServer()).get(`/api/ff/rfq/${roadToken}`).expect(200);
    const roadLegDto = roadGot.body.legs[0];
    expect(roadLegDto.draft.trucking).toHaveLength(2); // seeded DEDICATED + GROUPAGE, both blank

    const roadDraft = {
      ...roadLegDto.draft,
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 5,
      // price the ONE common charge; trucking is left EXACTLY as seeded — both rows amount: null.
      charges: roadLegDto.draft.charges.map((c: { amount: number | null }) => ({
        ...c,
        amount: 60,
      })),
    };
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${roadToken}/quotes/${roadLeg.id}`)
      .send(roadDraft)
      .expect(200);
    // THE PROOF (Round 4, reversed): 422 Q_RATE, NOT 201 — Road freight is now REQUIRED, so a
    // priced common charge alone can no longer carry the leg to submission.
    const roadRejected = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${roadToken}/quotes/${roadLeg.id}/submit`)
      .send({ version: roadLegDto.version })
      .expect(422);
    expect(roadRejected.body.findings.map((f: { rule: string }) => f.rule)).toContain("Q_RATE");
    expect((await prisma.quote.findFirst({ where: { legId: roadLeg.id } }))?.status).toBe(
      "RFQ_SENT",
    );

    // ── ROAD half, continued: priced with its OWN trucking rate now succeeds (unchanged shape,
    //    just no longer optional) ──
    const roadDraftWithTrucking = {
      ...roadDraft,
      trucking: roadDraft.trucking.map((t: { rateVariant: string | null }) =>
        t.rateVariant === "DEDICATED" ? { ...t, amount: 400, tonnage: "T_5" } : t,
      ),
      transit: { ...roadDraft.transit, guaranteedTransitDaysByVariant: { DEDICATED: 3 } },
    };
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${roadToken}/quotes/${roadLeg.id}`)
      .send(roadDraftWithTrucking)
      .expect(200);
    const roadSubmit = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${roadToken}/quotes/${roadLeg.id}/submit`)
      .send({ version: roadLegDto.version })
      .expect(201);
    expect(roadSubmit.body.status).toBe("QUOTED");

    const roadQuoteId = roadSubmit.body.quoteId as string;
    expect(await prisma.truckingCharge.count({ where: { quoteId: roadQuoteId } })).toBe(1); // only the priced DEDICATED row materializes
    const roadTrucking = await prisma.truckingCharge.findFirstOrThrow({
      where: { quoteId: roadQuoteId },
    });
    expect(roadTrucking.rateVariant).toBe("DEDICATED");
    expect(Number(roadTrucking.amount)).toBe(400);
    expect(await prisma.transitPlan.count({ where: { quoteId: roadQuoteId } })).toBe(1); // ONE priced freight variant -> ONE GTT row
    const roadCharge = await prisma.chargeLine.findFirstOrThrow({
      where: { quoteId: roadQuoteId },
    });
    expect(roadCharge.rateVariant).toBeNull();
    expect(Number(roadCharge.amount)).toBe(60);
    const roadQuote = await prisma.quote.findUniqueOrThrow({ where: { id: roadQuoteId } });
    // grandTotal = max variant: DEDICATED = 400 (trucking) + 60 (common) = 460; GROUPAGE (still
    // untouched) = 0 + 60 = 60. max(460, 60) = 460.
    expect(Number(roadQuote.grandTotal)).toBe(460);

    // ── SEA half: common charges alone do NOT satisfy Q_RATE — Sea freight stays required ──
    const seaQuery = await prisma.query.create({
      data: { queryCode: `${CODE}-R4GATE-SEA-${seq}`, incoterms: "FOB" },
    });
    const seaOrigin = await prisma.point.create({
      data: { queryId: seaQuery.id, type: "PICKUP", country: "CN" },
    });
    const seaDest = await prisma.point.create({
      data: { queryId: seaQuery.id, type: "DELIVERY", country: "AE" },
    });
    const seaLeg = await prisma.leg.create({
      data: {
        queryId: seaQuery.id,
        legCode: `L-${PREFIX}-R4GATE-SEA-${seq}`,
        mode: "SEA",
        status: "READY_FOR_RFQ",
        originPointId: seaOrigin.id,
        destinationPointId: seaDest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    const { packageIds: seaPkgIds } = await createCargoWithPackages(prisma, {
      queryId: seaQuery.id,
      packages: [{ packageNo: `PK-R4GATE-SEA-${seq}`, dimL: 10, dimW: 20, dimH: 30, grossWt: 5 }],
    });
    await assignPackagesToLeg(prisma, seaLeg.id, seaPkgIds);
    const seaFf = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-R4GS-${seq}`,
        companyName: `FF R4 Gate Sea Co ${seq}`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PREFIX.toLowerCase()}-r4gs-${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["SEA"],
        handleDg: false,
        defaultCurrency: "USD",
      },
    });
    await request(app.getHttpServer())
      .put(`/api/queries/${seaQuery.id}/legs/${seaLeg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [seaFf.id] })
      .expect(200);
    const seaDist = await request(app.getHttpServer())
      .post(`/api/queries/${seaQuery.id}/legs/${seaLeg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const seaToken = seaDist.body.rfqs[0].accessToken as string;

    const seaGot = await request(app.getHttpServer()).get(`/api/ff/rfq/${seaToken}`).expect(200);
    const seaLegDto = seaGot.body.legs[0];

    const seaDraft = {
      ...seaLegDto.draft,
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 5,
      // every common charge priced; BOTH seaRates rows left exactly as seeded (amount: null).
      charges: seaLegDto.draft.charges.map((c: { amount: number | null }) => ({
        ...c,
        amount: 15,
      })),
    };
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${seaToken}/quotes/${seaLeg.id}`)
      .send(seaDraft)
      .expect(200);
    const seaSubmit = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${seaToken}/quotes/${seaLeg.id}/submit`)
      .send({ version: seaLegDto.version })
      .expect(422);
    expect(seaSubmit.body.findings.map((f: { rule: string }) => f.rule)).toContain("Q_RATE");
    expect((await prisma.quote.findFirst({ where: { legId: seaLeg.id } }))?.status).toBe(
      "RFQ_SENT",
    );
  });

  // ── S5.9.5 (D5): the forwarder portal closes an approved leg ─────────────────────────────────
  //
  // Fixture: ONE query, THREE Air legs, TWO forwarders — and, because `Rfq` is
  // `@@unique([queryId, freightForwarderId])`, exactly ONE RFQ and ONE portal token per forwarder
  // covering every leg they hold. That one-token-many-legs shape is precisely why the rule under
  // test is per-LEG and never per-RFQ.
  //
  //   L1 — ffA + ffB · ffA submits, ffA is APPROVED (real maker+checker calls) → CLOSED to ffB
  //   L2 — ffA + ffB · ffA submits, sent for approval only                     → still OPEN to ffB
  //   L3 —       ffB · untouched                                               → still OPEN to ffB
  //
  // ffB never submits anywhere, so every ffB quote stays RFQ_SENT with a saved draft — the exact
  // shape that sailed through the portal before this task, whose submit guard only ever asked
  // about the forwarder's OWN quote status.
  async function closedLegFixture(): Promise<{
    queryId: string;
    tokenA: string;
    tokenB: string;
    ffIds: { a: string; b: string };
    legIds: { approved: string; pending: string; sibling: string };
  }> {
    const admin = cookie(Role.ADMINISTRATOR);
    const seq = ++fixtureSeq;
    // Sender and approver are deliberately different users: approve() enforces four-eyes.
    const senderId = randomUUID();
    const approverId = randomUUID();

    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-CLOSED-${seq}`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });

    const mkLeg = async (code: string) => {
      const leg = await prisma.leg.create({
        data: {
          queryId: query.id,
          legCode: `L-${PREFIX}-${code}-${seq}`,
          mode: "AIR",
          status: "READY_FOR_RFQ",
          originPointId: origin.id,
          destinationPointId: dest.id,
          readyDate: new Date(),
          targetDelivery: new Date(Date.now() + 86400000),
          warehouseHandlingIncluded: false,
        },
      });
      // F1 (leg completeness) gates distribution on >= 1 package assigned to THIS leg.
      const { packageIds } = await createCargoWithPackages(prisma, {
        queryId: query.id,
        packages: [
          { packageNo: `PO-${PREFIX}-${code}-${seq}`, dimL: 10, dimW: 20, dimH: 30, grossWt: 5 },
        ],
      });
      await assignPackagesToLeg(prisma, leg.id, packageIds);
      return leg.id;
    };
    const approvedLeg = await mkLeg("CA");
    const pendingLeg = await mkLeg("CP");
    const siblingLeg = await mkLeg("CS");

    const mkFf = (suffix: string) =>
      prisma.freightForwarder.create({
        data: {
          freightForwarderCode: `FF-${PREFIX}-${suffix}-${seq}`,
          companyName: `FF ${PREFIX} ${suffix} ${seq}`,
          pic: "P",
          contactNumber: "+1000000000",
          email: `ff-${PREFIX.toLowerCase()}-${suffix.toLowerCase()}-${seq}@e2e.test`,
          availableCountries: ["CN", "AE"],
          modes: ["AIR"],
          handleDg: false,
          defaultCurrency: "USD",
        },
      });
    const ffA = await mkFf("CLA");
    const ffB = await mkFf("CLB");

    for (const [legId, ffIds] of [
      [approvedLeg, [ffA.id, ffB.id]],
      [pendingLeg, [ffA.id, ffB.id]],
      [siblingLeg, [ffB.id]],
    ] as const) {
      await request(app.getHttpServer())
        .put(`/api/queries/${query.id}/legs/${legId}/ff-selection`)
        .set("Cookie", admin)
        .send({ ffIds })
        .expect(200);
    }

    // ONE distribute for the whole query → one RFQ per forwarder, spanning their legs.
    const dist = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/distribute-all`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const entryFor = (ffId: string) =>
      dist.body.rfqs.find((r: { freightForwarderId: string }) => r.freightForwarderId === ffId);
    const tokenA = entryFor(ffA.id).accessToken as string;
    const tokenB = entryFor(ffB.id).accessToken as string;
    expect(entryFor(ffB.id).legIds).toHaveLength(3); // one RFQ really does cover all three legs

    const view = (token: string) =>
      request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const legOf = (body: { legs: { legId: string }[] }, legId: string) =>
      body.legs.find((l) => l.legId === legId) as {
        legId: string;
        version: string;
        status: string;
      };

    // ffA prices and SUBMITS the two legs they are competing for — a real portal round-trip, so
    // the offers the maker endpoint later names are genuinely materialized ones.
    for (const legId of [approvedLeg, pendingLeg]) {
      const got = await view(tokenA);
      await request(app.getHttpServer())
        .patch(`/api/ff/rfq/${tokenA}/quotes/${legId}`)
        .send(fullValidDraft(legId, got.body))
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/ff/rfq/${tokenA}/quotes/${legId}/submit`)
        .send({ version: legOf(got.body, legId).version })
        .expect(201);
    }

    // ffB SAVES a complete, submittable draft on the leg they are about to lose — and stops there.
    // Without this the submit refusal under test could be an incidental 422 on an empty draft
    // rather than the leg-closed guard, and removing that guard would not visibly change anything.
    const gotB = await view(tokenB);
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${tokenB}/quotes/${approvedLeg}`)
      .send(fullValidDraft(approvedLeg, gotB.body))
      .expect(200);

    // A3 (award.service.ts) refuses a send while a forwarder's RFQ window is still open, and ffB's
    // is — by design, they are still allowed to answer. Close it for the two sends, then REOPEN it
    // (the whole window, because the deadline is per-RFQ and shared across ffB's three legs) so the
    // tests below exercise the leg-closed rule and not an incidental Q_DEADLINE.
    const rfqB = await prisma.rfq.findFirstOrThrow({
      where: { queryId: query.id, freightForwarderId: ffB.id },
      select: { id: true, submissionDeadline: true },
    });
    await prisma.rfq.update({
      where: { id: rfqB.id },
      data: { submissionDeadline: new Date(Date.now() - 60_000) },
    });

    // Name ffA's offer through the REAL maker endpoint, reading the quote/variant off the
    // comparison the screen itself reads (Air's single column is `variant: null`).
    const sendFor = async (legId: string) => {
      const cmp = await request(app.getHttpServer())
        .get(`/api/queries/${query.id}/comparison`)
        .set("Cookie", cookieFor(senderId, Role.MANAGER))
        .expect(200);
      const offer = cmp.body.legs
        .find((l: { legId: string }) => l.legId === legId)
        .offers.find(
          (o: { freightForwarderId: string; priced: boolean }) =>
            o.freightForwarderId === ffA.id && o.priced,
        );
      await request(app.getHttpServer())
        .post(`/api/queries/${query.id}/legs/${legId}/send-for-approval`)
        .set("Cookie", cookieFor(senderId, Role.MANAGER))
        .send({ quoteId: offer.quoteId, variant: offer.variant, overrideReason: "e2e fixture" })
        .expect(200);
    };
    await sendFor(approvedLeg);
    await sendFor(pendingLeg);

    // Only ONE of the two is approved — the other stays PENDING_APPROVAL, which D5 says does NOT
    // close the portal.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${approvedLeg}/approve`)
      .set("Cookie", cookieFor(approverId, Role.MANAGER))
      .expect(200);

    await prisma.rfq.update({
      where: { id: rfqB.id },
      data: { submissionDeadline: rfqB.submissionDeadline },
    });

    return {
      queryId: query.id,
      tokenA,
      tokenB,
      ffIds: { a: ffA.id, b: ffB.id },
      legIds: { approved: approvedLeg, pending: pendingLeg, sibling: siblingLeg },
    };
  }

  it("S5.9.5 (D5) — a forwarder cannot submit on a leg approved to someone else, and the leg says why", async () => {
    const { tokenB, ffIds, legIds } = await closedLegFixture();

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${tokenB}`).expect(200);
    const closedLeg = got.body.legs.find((l: { legId: string }) => l.legId === legIds.approved) as {
      closedReason: string;
      version: string;
      status: string;
    };

    expect(closedLeg.closedReason).toMatch(/no longer open for quoting/i);
    // Vocabulary rule D5, on a forwarder-facing string: never "awarded", and never a rival's name.
    expect(closedLeg.closedReason).not.toMatch(/award/i);
    expect(closedLeg.closedReason).not.toContain("FF ");
    // THIS forwarder's own quote is untouched and still open — it is the LEG that closed. That is
    // the whole gap: the pre-existing status guard sees nothing wrong here.
    expect(closedLeg.status).toBe("RFQ_SENT");

    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${tokenB}/quotes/${legIds.approved}/submit`)
      .send({ version: closedLeg.version })
      .expect(409);
    expect(res.body.message).toBe(closedLeg.closedReason);

    // Refused before anything was written: the losing quote is still exactly where it was.
    const ffBQuote = await prisma.quote.findFirstOrThrow({
      where: { legId: legIds.approved, freightForwarderId: ffIds.b },
    });
    expect(ffBQuote.status).toBe("RFQ_SENT");
    expect(ffBQuote.submittedAt).toBeNull();
  });

  it("S5.9.5 (D5) — a leg merely PENDING_APPROVAL stays open, and the forwarder's OTHER leg stays open too", async () => {
    // Positive control on both halves of the rule: neither PENDING_APPROVAL nor a sibling leg
    // closes. Both are deliberate design rulings, not omissions.
    const { tokenB, legIds } = await closedLegFixture();

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${tokenB}`).expect(200);
    const legOf = (legId: string) =>
      got.body.legs.find((l: { legId: string }) => l.legId === legId) as {
        closedReason: string | null;
        version: string;
      };
    expect(legOf(legIds.pending).closedReason).toBeNull();
    expect(legOf(legIds.sibling).closedReason).toBeNull();

    // …and the sibling is genuinely still submittable end to end, not merely un-badged.
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${tokenB}/quotes/${legIds.sibling}`)
      .send(fullValidDraft(legIds.sibling, got.body))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${tokenB}/quotes/${legIds.sibling}/submit`)
      .send({ version: legOf(legIds.sibling).version })
      .expect(201);
  });

  it("S5.9.5 (D5) — a closed leg also refuses a draft save, while the forwarder's open legs still accept one", async () => {
    const { tokenB, legIds } = await closedLegFixture();

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${tokenB}`).expect(200);
    const res = await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${tokenB}/quotes/${legIds.approved}`)
      .send(fullValidDraft(legIds.approved, got.body))
      .expect(409);
    expect(res.body.message).toMatch(/no longer open for quoting/i);

    // The guard is leg-scoped, not RFQ-scoped: the same token keeps saving on the open legs.
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${tokenB}/quotes/${legIds.pending}`)
      .send(fullValidDraft(legIds.pending, got.body))
      .expect(200);
  });

  it("S5.9.5 (D5 + S5.9 D9) — the SELECTED forwarder is told nothing: their own leg is not reported closed", async () => {
    // Approval is silent and reversible, and this DTO field is forwarder-facing — reporting the
    // winner's own leg as closed would tell exactly one reader that a selection had happened.
    // Their submit is refused anyway, by the pre-existing quote-status guard (their quote is
    // APPROVED), so nothing is left open by leaving them out.
    const { tokenA, legIds } = await closedLegFixture();

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${tokenA}`).expect(200);
    const winner = got.body.legs.find((l: { legId: string }) => l.legId === legIds.approved) as {
      closedReason: string | null;
      status: string;
      version: string;
    };
    expect(winner.status).toBe("APPROVED");
    expect(winner.closedReason).toBeNull();

    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${tokenA}/quotes/${legIds.approved}/submit`)
      .send({ version: winner.version })
      .expect(409);
    expect(res.body.message).toBe("This quote has already been submitted or is not open");
  });

  // ── S5.9.5 (D5, review round 1 / IMPORTANT 1): a LOCKED query's winner cannot edit the numbers
  //    their client quotation is priced from ────────────────────────────────────────────────────
  //
  // The leg-closed guard alone does not cover this. `generateClientQuote` refuses unless EVERY leg
  // is APPROVED with a shortlisted winner (A6), so a locked query's every leg HAS a winner — and
  // `closedReasons` deliberately excludes the winner's own leg (S5.9 D9). Their `saveDraft` used to
  // pass `quoteForLeg` (leg membership only) and write `Quote.draftJson` +
  // `Rfq.currency`/`quoteValidityUntil`, all of which are read LIVE after the freeze:
  // `quotation.service.ts`'s `buildInitialDraft` prices the client quotation's cost lines and
  // `validUntil` off the winner's `draftJson` on the FIRST `GET queries/:id/quotation`, which
  // happens after `awardSnapshot` was frozen. The quote-status guard is what closes that.
  //
  // One leg, two forwarders, so BOTH refusal paths are on the same fixture: ffA (the winner,
  // APPROVED → status guard) and ffB (a loser still RFQ_SENT → leg-closed guard).
  async function lockedQueryFixture(): Promise<{
    queryId: string;
    tokenA: string;
    tokenB: string;
    legId: string;
  }> {
    const admin = cookie(Role.ADMINISTRATOR);
    const seq = ++fixtureSeq;
    const senderId = randomUUID();
    const approverId = randomUUID();

    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-LOCKED-${seq}`, incoterms: "FOB" },
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
        legCode: `L-${PREFIX}-LK-${seq}`,
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        warehouseHandlingIncluded: false,
      },
    });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: `PO-${PREFIX}-LK-${seq}`, dimL: 10, dimW: 20, dimH: 30, grossWt: 5 }],
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);

    const mkFf = (suffix: string) =>
      prisma.freightForwarder.create({
        data: {
          freightForwarderCode: `FF-${PREFIX}-${suffix}-${seq}`,
          companyName: `FF ${PREFIX} ${suffix} ${seq}`,
          pic: "P",
          contactNumber: "+1000000000",
          email: `ff-${PREFIX.toLowerCase()}-${suffix.toLowerCase()}-${seq}@e2e.test`,
          availableCountries: ["CN", "AE"],
          modes: ["AIR"],
          handleDg: false,
          defaultCurrency: "USD",
        },
      });
    const ffA = await mkFf("LKA");
    const ffB = await mkFf("LKB");

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ffA.id, ffB.id] })
      .expect(200);
    const dist = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const entryFor = (ffId: string) =>
      dist.body.rfqs.find((r: { freightForwarderId: string }) => r.freightForwarderId === ffId);
    const tokenA = entryFor(ffA.id).accessToken as string;
    const tokenB = entryFor(ffB.id).accessToken as string;

    // ffA prices and submits; ffB never answers.
    const gotA = await request(app.getHttpServer()).get(`/api/ff/rfq/${tokenA}`).expect(200);
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${tokenA}/quotes/${leg.id}`)
      .send(fullValidDraft(leg.id, gotA.body))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${tokenA}/quotes/${leg.id}/submit`)
      .send({ version: gotA.body.legs[0].version })
      .expect(201);

    // A3 needs ffB's window closed before the send; restored afterwards so the refusals under test
    // are the guards and not an incidental deadline effect.
    const rfqB = await prisma.rfq.findFirstOrThrow({
      where: { queryId: query.id, freightForwarderId: ffB.id },
      select: { id: true, submissionDeadline: true },
    });
    await prisma.rfq.update({
      where: { id: rfqB.id },
      data: { submissionDeadline: new Date(Date.now() - 60_000) },
    });

    const cmp = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/comparison`)
      .set("Cookie", cookieFor(senderId, Role.MANAGER))
      .expect(200);
    const offer = cmp.body.legs
      .find((l: { legId: string }) => l.legId === leg.id)
      .offers.find(
        (o: { freightForwarderId: string; priced: boolean }) =>
          o.freightForwarderId === ffA.id && o.priced,
      );
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId, Role.MANAGER))
      .send({ quoteId: offer.quoteId, variant: offer.variant, overrideReason: "e2e fixture" })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", cookieFor(approverId, Role.MANAGER))
      .expect(200);

    // THE LOCK: every leg APPROVED → generate freezes `Query.awardSnapshot` (D6's "locked").
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(approverId, Role.MANAGER))
      .expect(200);
    const locked = await prisma.query.findUniqueOrThrow({
      where: { id: query.id },
      select: { awardSnapshot: true },
    });
    expect(locked.awardSnapshot).not.toBeNull(); // the fixture really is locked

    await prisma.rfq.update({
      where: { id: rfqB.id },
      data: { submissionDeadline: rfqB.submissionDeadline },
    });

    return { queryId: query.id, tokenA, tokenB, legId: leg.id };
  }

  it("S5.9.5 (D5) — on a LOCKED query the winning forwarder cannot save a draft either, while an open leg elsewhere still can", async () => {
    const { tokenA, tokenB, legId } = await lockedQueryFixture();

    const gotA = await request(app.getHttpServer()).get(`/api/ff/rfq/${tokenA}`).expect(200);
    expect(gotA.body.legs[0].status).toBe("APPROVED");
    expect(gotA.body.legs[0].closedReason).toBeNull(); // D9: the winner is still told nothing

    // The winner's own PATCH — the one `closedReasons` deliberately lets through — is refused by
    // the quote-status guard. Without it they could rewrite the very draftJson the client
    // quotation is priced from, after the snapshot was frozen.
    const winnerSave = await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${tokenA}/quotes/${legId}`)
      .send(fullValidDraft(legId, gotA.body))
      .expect(409);
    expect(winnerSave.body.message).toBe("This quote has already been submitted or is not open");

    // The draftJson the client quotation prices from is untouched.
    const winnerQuote = await prisma.quote.findFirstOrThrow({
      where: { legId, status: "APPROVED" },
      select: { draftJson: true },
    });
    expect((winnerQuote.draftJson as { chargedWeightKg: number }).chargedWeightKg).toBe(125);

    // The loser on the same locked leg is refused too — by the OTHER guard, with the other message.
    const gotB = await request(app.getHttpServer()).get(`/api/ff/rfq/${tokenB}`).expect(200);
    const loserSave = await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${tokenB}/quotes/${legId}`)
      .send(fullValidDraft(legId, gotB.body))
      .expect(409);
    expect(loserSave.body.message).toMatch(/no longer open for quoting/i);

    // POSITIVE CONTROL, in the same test: an ordinary RFQ_SENT forwarder on an open, unlocked
    // leg still saves. A guard that refused every save would pass everything above and fail here.
    const open = await distributeFixture();
    const gotOpen = await request(app.getHttpServer()).get(`/api/ff/rfq/${open.token}`).expect(200);
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${open.token}/quotes/${open.legId}`)
      .send(fullValidDraft(open.legId, gotOpen.body))
      .expect(200);
  });
  // ── S5.9.6 (register A6): `draftJson` is the scratchpad, `submittedJson` is the offer ──

  it("S5.9.6 (A6) — submit records submittedJson; a later saveDraft moves draftJson and leaves it alone", async () => {
    const seq = ++fixtureSeq;
    // A real user row: request-requote stamps `actorId` (@db.Uuid) on the AwardDecisionEvent.
    const exec = await prisma.user.create({
      data: {
        name: "FF Portal Exec A6",
        email: `${PREFIX.toLowerCase()}-exec-a6-${seq}@e2e.test`,
        passwordHash: "x",
        role: "EXECUTIVE",
      },
    });
    const { token, legId, queryId } = await distributeFixture(exec.id);

    // --- the forwarder submits a complete offer (every priced line at 10, weight 125) ---
    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const offer = fullValidDraft(legId, got.body);
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(offer)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: got.body.legs[0].version })
      .expect(201);

    const afterSubmit = await prisma.quote.findFirstOrThrow({ where: { legId } });
    expect(afterSubmit.status).toBe("QUOTED");
    // Both columns hold the offer, and hold the SAME object: submit writes them from one value.
    expect(afterSubmit.submittedJson).not.toBeNull();
    expect(afterSubmit.submittedJson).toEqual(afterSubmit.draftJson);
    expect((afterSubmit.submittedJson as unknown as QuoteDraft).chargedWeightKg).toBe(125);

    // --- the exec asks for a re-quote: REQUOTED, and neither column moves (the earlier price
    //     stays visible — the REQUEST_REQUOTE edge has no effect, negotiation.service.ts) ---
    await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/legs/${legId}/quotes/${afterSubmit.id}/request-requote`)
      .set("Cookie", cookieFor(exec.id, Role.EXECUTIVE))
      .send({ comment: "Please sharpen the origin charges." })
      .expect(200);

    const afterRequote = await prisma.quote.findUniqueOrThrow({ where: { id: afterSubmit.id } });
    expect(afterRequote.status).toBe("REQUOTED");
    expect(afterRequote.draftJson).toEqual(afterSubmit.draftJson);
    expect(afterRequote.submittedJson).toEqual(afterSubmit.submittedJson);

    // --- the forwarder HALF-EDITS the reopened portal and saves: one line re-priced to 4200, the
    //     rest blanked, a note on it — then goes silent. This is A6's scenario verbatim. ---
    const halfEdit: QuoteDraft = {
      ...offer,
      notes: "half-edited, never submitted",
      charges: offer.charges.map((c, i) =>
        i === 0 ? { ...c, amount: 4200 } : { ...c, amount: null },
      ),
    };
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(halfEdit)
      .expect(200);

    const afterHalfEdit = await prisma.quote.findUniqueOrThrow({ where: { id: afterSubmit.id } });
    // The scratchpad moved...
    const scratch = afterHalfEdit.draftJson as unknown as QuoteDraft;
    expect(scratch.notes).toBe("half-edited, never submitted");
    expect(scratch.charges[0].amount).toBe(4200);
    expect(scratch.charges.slice(1).every((c) => c.amount === null)).toBe(true);
    // ...and the OFFER did not. This is the whole point of the split: nothing the forwarder types
    // after submitting can turn into an approvable price.
    expect(afterHalfEdit.submittedJson).toEqual(afterSubmit.submittedJson);
    const stillTheOffer = afterHalfEdit.submittedJson as unknown as QuoteDraft;
    expect(stillTheOffer.notes).toBeNull();
    expect(stillTheOffer.charges[0].amount).toBe(offer.charges[0].amount);

    // --- POSITIVE CONTROL, same test: a second SUBMIT moves BOTH columns. A `submittedJson` that
    //     were merely frozen at the first submit would pass every assertion above and fail here. ---
    const revised: QuoteDraft = { ...offer, notes: "revised offer", chargedWeightKg: 200 };
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(revised)
      .expect(200);
    // Fresh GET: request-requote changed the status AND reset the submission deadline, both of
    // which feed the stale-page version hash (S5.9 D10).
    const gotAgain = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    expect(gotAgain.body.legs[0].status).toBe("REQUOTED");
    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: gotAgain.body.legs[0].version })
      .expect(201);

    const afterResubmit = await prisma.quote.findUniqueOrThrow({ where: { id: afterSubmit.id } });
    expect(afterResubmit.status).toBe("QUOTED");
    expect(afterResubmit.submittedJson).toEqual(afterResubmit.draftJson);
    const newOffer = afterResubmit.submittedJson as unknown as QuoteDraft;
    expect(newOffer.notes).toBe("revised offer");
    expect(newOffer.chargedWeightKg).toBe(200);
  });
});
