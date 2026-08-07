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

const PREFIX = "FF-PORTAL";
const CODE = `YAL00-${PREFIX}`;

describe("GET /ff/rfq/:token (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

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
   *   single implicit column); the HEAVY_WEIGHT_CALC line (AIR_MAIN_HEAVY_WEIGHT) priced via its 3
   *   calc inputs instead (satisfies Q_PRICED)
   * - trucking/seaRates/warehouse: empty (no trucking/warehouse endpoints in fixture; mode AIR
   *   never gates on Q_RATE)
   * - transit: departure + arrival + guaranteedTransitDaysByVariant.AIR set (satisfies Q_TRANSIT)
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
              pieceWeightKg: 180,
              airlineLimitKg: 100,
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
        departureDate: "2026-08-12T00:00:00.000Z",
        arrivalDate: "2026-08-14T00:00:00.000Z",
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

    // POST submit → should fail with Q_DEADLINE (deadline passed)
    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
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
      .expect(201);

    // Second submit → 409 (already submitted)
    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
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
    // only ($10 x 5 = $50) — LCL is left completely untouched (no rate, no charges), proving it
    // stays a legitimate blank column rather than needing to be filled too.
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
          rateVariant: "FCL",
        }),
      ),
      trucking: [],
      seaRates: [
        { rateVariant: "FCL", containerSize: "FORTY", amount: 1800, remarks: "FCL priced" },
        { rateVariant: "LCL", containerSize: null, amount: null },
      ],
      warehouse: [],
      transit: {
        departureDate: "2026-09-01T00:00:00.000Z",
        arrivalDate: "2026-09-10T00:00:00.000Z",
        // only FCL is a priced variant (LCL is untouched) — Q_TRANSIT only requires FCL's slot.
        guaranteedTransitDaysByVariant: { FCL: 9 },
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

    // Quote.grandTotal = the engine's MAX variant grand total: FCL = 1800 (rate) + $50 (its own
    // charges) + $0 warehouse = 1850; LCL (untouched) = 0 (rate) + 0 (no charges) + $0 = 0.
    // max(1850, 0) = 1850.
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: submitRes.body.quoteId } });
    expect(Number(quote.grandTotal)).toBe(1850);
  });
});
