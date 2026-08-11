process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE, type FfPortalRfqDto, type QuoteDraft } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

// Task 3 (FF Portal v3, per-variant quoting — design doc §5): ff-portal.service.ts's
// resolveScope now seeds a starter QuoteDraft (the per-variant charge matrix + blank leg
// chargedWeightKg/notes/transit-days) instead of `null` when a leg has no saved draft yet, and
// submit() materializes the v3 shape: Quote.chargedWeightKg/notes (leg-level, replacing the
// dropped per-QuoteCargoLine chargedWeightKg), ChargeLine.rateVariant (one row per PRICED
// (definitionKey, rateVariant) cell — an untouched variant's cells are dropped, mirroring the
// existing trucking/seaRates unpriced-row filters), and one TransitPlan row per PRICED variant
// (rateVariant column set from variantsForMode; Air's days come off the draft's AIR_VARIANT_KEY
// map slot but its own TransitPlan row keeps rateVariant: null). This spec drives the real HTTP
// path end to end for a ROAD leg (Dedicated/Groupage columns) — ff-selection -> distribute ->
// GET (seed) -> PATCH (both variants) -> POST submit — against a real Cargo->Package +
// LegPackage fixture, then the two new submit-gate paths: Q_TRANSIT when a priced variant's
// transit-days is missing, and Q_WEIGHT when the leg-level chargedWeightKg is missing.
const PFX = "FFV3_";

describe(`${PFX}ff-portal-v3 (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = () =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: "33333333-3333-3333-3333-333333333333", role: Role.ADMINISTRATOR, tenantId: null })}`;
  const api = () => request(app.getHttpServer());

  // Self-clean comms rows too (ScheduledEvent/MessageLog key off entityId as a plain string, not
  // a Prisma relation) — mirrors ff-portal-grain.e2e-spec.ts / ff-portal.e2e-spec.ts.
  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: PFX } },
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
      // order matters: quotes/rfqs reference the FF (Restrict) and the query (Cascade)
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items/chargeSelections
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
    await seedReferenceData(prisma); // chargeLineDefinition catalogue feeds seededCharges
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  let fixtureSeq = 0;
  /**
   * Query -> origin/dest Points -> Cargo->Package (LegPackage-assigned) -> ROAD Leg
   * (READY_FOR_RFQ) -> select the seeded ROAD_STD_TAIL_LIFT STANDARD/PLAIN line (so the leg's
   * chargeConfigSnapshot freezes >=1 active charge-config line, per the brief) -> FF(modes:
   * [ROAD]) -> PUT ff-selection -> POST distribute. Returns the raw accessToken + ids.
   *
   * `originOverride` lets a caller reshape the origin Point (e.g. type: "AIRPORT" +
   * iataCode) without duplicating the rest of this fixture — the leg's `mode` stays ROAD
   * regardless, since this fixture creates Points/Legs directly via Prisma (bypassing
   * LegsService's checkModeEndpoints pre-write check, same as the existing SEA fixture below
   * already does with PICKUP/DELIVERY endpoints on a SEA leg).
   */
  async function distributeRoadFixture(originOverride?: {
    type?: "PICKUP" | "AIRPORT";
    iataCode?: string;
  }): Promise<{
    token: string;
    legId: string;
    queryId: string;
  }> {
    const admin = cookie();
    const seq = ++fixtureSeq;
    const query = await prisma.query.create({
      data: { queryCode: `${PFX}${seq}`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN", ...originOverride },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `L-${PFX}${seq}`,
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    // F1 (leg completeness) gates on >=1 assigned package via LegPackage.
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: `PK-${PFX}${seq}`, dimL: 100, dimW: 50, dimH: 40, grossWt: 120 }],
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);

    // Road has no CORE PLAIN/HEAVY_WEIGHT_CALC lines (only TRUCKING, which prices via the
    // trucking[] array, not charges[]/seededCharges) — select a STANDARD PLAIN line so this
    // fixture has >=1 active charge-config line to matrix-seed and materialize per variant.
    const tailLift = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "ROAD_STD_TAIL_LIFT" },
    });
    await prisma.legChargeLineSelection.create({
      data: { legId: leg.id, definitionId: tailLift.id },
    });

    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PFX}${seq}`,
        companyName: `FF ${PFX}${seq} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PFX.toLowerCase()}${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        status: "ACTIVE",
        defaultCurrency: "USD",
      },
    });
    await api()
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    const distRes = await api()
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    return { token: distRes.body.rfqs[0].accessToken as string, legId: leg.id, queryId: query.id };
  }

  /**
   * SEA counterpart of distributeRoadFixture — a SEA leg (FCL/LCL columns). SEA has CORE PLAIN
   * lines (SEA_ORIGIN_* — SEA_MAIN_FREIGHT is retired/isActive:false since sea freight is the
   * structured seaRates dual-rate), so no explicit chargeSelection is needed to freeze >=1 active
   * line. Query -> points -> Cargo->Package (LegPackage) -> SEA Leg -> FF(modes:[SEA]) -> PUT
   * ff-selection -> POST distribute.
   */
  async function distributeSeaFixture(): Promise<{ token: string; legId: string }> {
    const admin = cookie();
    const seq = ++fixtureSeq;
    const query = await prisma.query.create({
      data: { queryCode: `${PFX}${seq}`, incoterms: "FOB" },
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
        legCode: `L-${PFX}${seq}`,
        mode: "SEA",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: `PK-${PFX}${seq}`, dimL: 100, dimW: 50, dimH: 40, grossWt: 120 }],
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);
    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PFX}${seq}`,
        companyName: `FF ${PFX}${seq} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PFX.toLowerCase()}${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["SEA"],
        status: "ACTIVE",
        defaultCurrency: "USD",
      },
    });
    await api()
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    const distRes = await api()
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    return { token: distRes.body.rfqs[0].accessToken as string, legId: leg.id };
  }

  /**
   * A fresh ROAD leg with warehouse handling ON and a WAREHOUSE-type origin endpoint (so
   * resolveScope's classifyWarehousePositions gives it a warehousePosition). No chargeSelection —
   * ROAD has no CORE PLAIN lines, so snap.lines is empty and the priced variant is made priced via
   * trucking alone, keeping this fixture focused on the warehouse seed. Returns raw token + ids.
   */
  async function distributeWarehouseFixture(): Promise<{ token: string; legId: string }> {
    const admin = cookie();
    const seq = ++fixtureSeq;
    const query = await prisma.query.create({
      data: { queryCode: `${PFX}${seq}`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "WAREHOUSE", country: "CN" }, // WAREHOUSE → gets a position
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `L-${PFX}${seq}`,
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        warehouseHandlingIncluded: true, // → chargeConfigSnapshot.warehouseIncluded → seeds warehouse rows
      },
    });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: `PK-${PFX}${seq}`, dimL: 100, dimW: 50, dimH: 40, grossWt: 120 }],
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);
    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PFX}${seq}`,
        companyName: `FF ${PFX}${seq} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PFX.toLowerCase()}${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        status: "ACTIVE",
        defaultCurrency: "USD",
      },
    });
    await api()
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    const distRes = await api()
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    return { token: distRes.body.rfqs[0].accessToken as string, legId: leg.id };
  }

  // ── finding #1: the SERVER seed (resolveScope's seedQuoteDraft) must seed the mode's freight-
  // rate rows (Road → trucking, Sea → seaRates), not []. The pre-fix server seed returned
  // trucking:[]/seaRates:[], and since resolveScope now ALWAYS returns the server seed for a fresh
  // leg (draftFromDto spreads it verbatim), every Road/Sea freight cell rendered disabled — the FF
  // could not enter the freight rate at all. These drive the REAL HTTP seed path (the existing
  // Road happy-path submitted with trucking:[], so it never exercised this). ──
  it("Road: resolveScope seeds both trucking rows (freight editable); a priced trucking rate round-trips through submit (finding #1)", async () => {
    const { token, legId } = await distributeRoadFixture();
    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const draft = (got.body as FfPortalRfqDto).legs[0].draft as QuoteDraft;

    // the seed now carries BOTH trucking variants (was [] pre-fix), keyed off the leg's first
    // endpoint, unpriced.
    expect(draft.trucking).toHaveLength(2);
    expect(draft.trucking.map((t) => t.rateVariant).sort()).toEqual(["DEDICATED", "GROUPAGE"]);
    expect(draft.trucking.every((t) => t.amount === null && t.basis === "PER_TRUCK")).toBe(true);
    expect(draft.trucking.every((t) => t.legEndpointPointId.length > 0)).toBe(true); // real endpoint, not ""

    const priced: QuoteDraft = {
      ...draft,
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 500,
      // price DEDICATED only: its trucking rate + its one seeded charge cell.
      charges: draft.charges.map((c) => (c.rateVariant === "DEDICATED" ? { ...c, amount: 100 } : c)),
      trucking: draft.trucking.map((t) =>
        t.rateVariant === "DEDICATED" ? { ...t, amount: 4200, tonnage: "T_5" } : t,
      ),
      transit: { ...draft.transit!, guaranteedTransitDaysByVariant: { DEDICATED: 4 } },
    };
    await api().patch(`/api/ff/rfq/${token}/quotes/${legId}`).send(priced).expect(200);
    const submitRes = await api().post(`/api/ff/rfq/${token}/quotes/${legId}/submit`).expect(201);
    const quoteId = submitRes.body.quoteId as string;

    const trucking = await prisma.truckingCharge.findMany({ where: { quoteId } });
    expect(trucking).toHaveLength(1); // only the priced DEDICATED row materializes
    expect(trucking[0].rateVariant).toBe("DEDICATED");
    expect(Number(trucking[0].amount)).toBe(4200);
    expect(trucking[0].basis).toBe("PER_TRUCK");
  });

  it("Sea: resolveScope seeds both seaRates rows (freight editable); a priced sea rate round-trips through submit (finding #1)", async () => {
    const { token, legId } = await distributeSeaFixture();
    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const draft = (got.body as FfPortalRfqDto).legs[0].draft as QuoteDraft;

    expect(draft.seaRates).toHaveLength(2);
    expect(draft.seaRates.map((r) => r.rateVariant).sort()).toEqual(["FCL", "LCL"]);
    expect(draft.seaRates.every((r) => r.amount === null && r.containerSize === null)).toBe(true);

    const priced: QuoteDraft = {
      ...draft,
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 800,
      // price FCL: every seeded CORE charge cell for FCL + the sea freight rate itself.
      charges: draft.charges.map((c) => (c.rateVariant === "FCL" ? { ...c, amount: 100 } : c)),
      seaRates: draft.seaRates.map((r) =>
        r.rateVariant === "FCL" ? { ...r, amount: 9000, containerSize: "FORTY" } : r,
      ),
      transit: { ...draft.transit!, guaranteedTransitDaysByVariant: { FCL: 18 } },
    };
    await api().patch(`/api/ff/rfq/${token}/quotes/${legId}`).send(priced).expect(200);
    const submitRes = await api().post(`/api/ff/rfq/${token}/quotes/${legId}/submit`).expect(201);
    const quoteId = submitRes.body.quoteId as string;

    const seaRates = await prisma.seaFreightRate.findMany({ where: { quoteId } });
    expect(seaRates).toHaveLength(1); // only the priced FCL row materializes
    expect(seaRates[0].rateVariant).toBe("FCL");
    expect(Number(seaRates[0].amount)).toBe(9000);
    expect(seaRates[0].containerSize).toBe("FORTY");
  });

  it("Sea: submit-gate blocks a priced FCL variant with no sea-freight rate, then passes once it's set (finding #3b)", async () => {
    const { token, legId } = await distributeSeaFixture();
    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const draft = (got.body as FfPortalRfqDto).legs[0].draft as QuoteDraft;

    // FCL "priced" via its charge cells only — seaRates[FCL].amount left null.
    const base: QuoteDraft = {
      ...draft,
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 800,
      charges: draft.charges.map((c) => (c.rateVariant === "FCL" ? { ...c, amount: 100 } : c)),
      transit: { ...draft.transit!, guaranteedTransitDaysByVariant: { FCL: 18 } },
    };
    await api().patch(`/api/ff/rfq/${token}/quotes/${legId}`).send(base).expect(200);
    const blocked = await api().post(`/api/ff/rfq/${token}/quotes/${legId}/submit`).expect(422);
    const seaFreightFinding = (
      blocked.body.findings as { rule: string; message: string; scope: { type: string } }[]
    ).find((f) => f.message.includes("Sea Freight"));
    expect(seaFreightFinding).toBeDefined();
    expect(seaFreightFinding?.rule).toBe("Q_PRICED");
    expect(seaFreightFinding?.scope.type).toBe("leg"); // findingNav → Charges section
    expect((await prisma.quote.findFirst({ where: { legId } }))?.status).toBe("RFQ_SENT");

    // set the sea freight rate → passes.
    const fixed: QuoteDraft = {
      ...base,
      seaRates: draft.seaRates.map((r) =>
        r.rateVariant === "FCL" ? { ...r, amount: 9000, containerSize: "FORTY" } : r,
      ),
    };
    await api().patch(`/api/ff/rfq/${token}/quotes/${legId}`).send(fixed).expect(200);
    const ok = await api().post(`/api/ff/rfq/${token}/quotes/${legId}/submit`).expect(201);
    expect(ok.body.status).toBe("QUOTED");
  });

  it("Warehouse: resolveScope seeds the warehouse row for a fresh warehouse-included leg; a priced amount round-trips + folds into grandTotal (finding #1 sibling)", async () => {
    const { token, legId } = await distributeWarehouseFixture();
    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const draft = (got.body as FfPortalRfqDto).legs[0].draft as QuoteDraft;

    // the seed now carries the warehouse row (was [] pre-fix → WarehouseStaging rendered nothing,
    // so the FF could not price warehousing at all).
    expect(draft.warehouse).toHaveLength(1);
    expect(draft.warehouse[0]).toMatchObject({
      position: "ORIGIN",
      label: "Origin warehouse",
      amount: null,
    });
    const whPointId = draft.warehouse[0].warehousePointId;
    expect(whPointId.length).toBeGreaterThan(0);

    const priced: QuoteDraft = {
      ...draft,
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 500,
      // DEDICATED priced via trucking (no CORE charge lines on ROAD); warehouse priced at 300.
      trucking: draft.trucking.map((t) =>
        t.rateVariant === "DEDICATED" ? { ...t, amount: 4200, tonnage: "T_5" } : t,
      ),
      warehouse: draft.warehouse.map((w) => ({ ...w, amount: 300 })),
      transit: { ...draft.transit!, guaranteedTransitDaysByVariant: { DEDICATED: 4 } },
    };
    await api().patch(`/api/ff/rfq/${token}/quotes/${legId}`).send(priced).expect(200);
    const submitRes = await api().post(`/api/ff/rfq/${token}/quotes/${legId}/submit`).expect(201);
    const quoteId = submitRes.body.quoteId as string;

    const whLines = await prisma.warehouseStagingLine.findMany({ where: { quoteId } });
    expect(whLines).toHaveLength(1);
    expect(whLines[0].warehousePointId).toBe(whPointId);
    expect(whLines[0].position).toBe("ORIGIN");
    expect(Number(whLines[0].amount)).toBe(300);

    // Warehousing is shared across variants (design D4) → folds into every column's grand total.
    // DEDICATED = trucking 4200 + warehouse 300 = 4500; persisted grandTotal = max variant column.
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
    expect(Number(quote.grandTotal)).toBe(4500);
  });

  it("resolveScope seeds the per-variant charge matrix (DEDICATED + GROUPAGE cells, amount null) instead of a null draft", async () => {
    const { token } = await distributeRoadFixture();

    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const legDto = (got.body as FfPortalRfqDto).legs[0];

    expect(legDto.draft).not.toBeNull();
    const draft = legDto.draft as QuoteDraft;
    expect(draft.chargedWeightKg).toBeNull();
    expect(draft.notes).toBeNull();
    expect(draft.transit?.guaranteedTransitDaysByVariant).toEqual({});

    const tailLiftCells = draft.charges.filter((c) => c.definitionKey === "ROAD_STD_TAIL_LIFT");
    expect(tailLiftCells).toHaveLength(2); // ROAD -> variantsForMode = [DEDICATED, GROUPAGE]
    expect(tailLiftCells.map((c) => c.rateVariant).sort()).toEqual(["DEDICATED", "GROUPAGE"]);
    expect(tailLiftCells.every((c) => c.amount === null)).toBe(true);
  });

  // Task 3 (ff-scoped route-diagram rework): resolveScope's endpoint map must expose the
  // point's non-sensitive location code (IATA/UN-LOCODE/ICAO/terminal — never a street address
  // or contact field) so the FF-portal route diagram can show "code + name" like the executive
  // RouteDiagram does. Live-resolved off the current Point row (not the frozen manifestSnapshot),
  // so this works for an already-distributed RFQ with no re-freeze/migration.
  it("resolveScope exposes the origin point's IATA code as endpoints[0].code (Task 3)", async () => {
    const { token } = await distributeRoadFixture({ type: "AIRPORT", iataCode: "PVG" });

    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const legDto = (got.body as FfPortalRfqDto).legs[0];

    expect(legDto.endpoints[0].code).toBe("PVG");
  });

  it("submit: prices both variants' charges + per-variant transit-days + leg weight + notes -> per-variant ChargeLine/TransitPlan rows, one Quote.chargedWeightKg/notes, grandTotal = max variant column, no QuoteCargoLine.chargedWeightKg", async () => {
    const { token, legId } = await distributeRoadFixture();
    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const legDto = (got.body as FfPortalRfqDto).legs[0];

    const draft: QuoteDraft = {
      legId,
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 482.75,
      notes: "Handle with care -- fragile glassware",
      cargo: legDto.manifest.cargo.map((c) => ({
        packageId: c.packageId,
        grossWtKg: Number(c.grossWt),
        cbm: Number(c.volumeCbm ?? 0),
      })),
      // one seeded line (ROAD_STD_TAIL_LIFT) x both variant columns, priced differently so
      // grandTotal's max() is unambiguous.
      charges: legDto.seededCharges.flatMap((c) => [
        {
          zone: c.zone,
          definitionKey: c.definitionKey,
          presetKey: c.presetKey,
          label: c.label,
          amount: 100,
          rateVariant: "DEDICATED" as const,
        },
        {
          zone: c.zone,
          definitionKey: c.definitionKey,
          presetKey: c.presetKey,
          label: c.label,
          amount: 150,
          rateVariant: "GROUPAGE" as const,
        },
      ]),
      trucking: [],
      seaRates: [],
      warehouse: [],
      transit: {
        departureDate: "2026-08-12T00:00:00.000Z",
        arrivalDate: "2026-08-14T00:00:00.000Z",
        guaranteedTransitDaysByVariant: { DEDICATED: 3, GROUPAGE: 5 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };

    await api().patch(`/api/ff/rfq/${token}/quotes/${legId}`).send(draft).expect(200);
    const submitRes = await api().post(`/api/ff/rfq/${token}/quotes/${legId}/submit`).expect(201);
    expect(submitRes.body.status).toBe("QUOTED");
    const quoteId = submitRes.body.quoteId as string;

    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
    expect(Number(quote.chargedWeightKg)).toBe(482.75);
    expect(quote.notes).toBe("Handle with care -- fragile glassware");
    // grandTotal = max(variant totals): DEDICATED = 100 (no trucking/warehouse), GROUPAGE = 150
    // -> max(100, 150) = 150.
    expect(Number(quote.grandTotal)).toBe(150);

    const chargeLines = await prisma.chargeLine.findMany({ where: { quoteId } });
    expect(chargeLines).toHaveLength(2);
    expect(chargeLines.map((c) => c.rateVariant).sort()).toEqual(["DEDICATED", "GROUPAGE"]);
    const dedicated = chargeLines.find((c) => c.rateVariant === "DEDICATED")!;
    const groupage = chargeLines.find((c) => c.rateVariant === "GROUPAGE")!;
    expect(Number(dedicated.amount)).toBe(100);
    expect(Number(groupage.amount)).toBe(150);
    expect(dedicated.definitionKey).toBe("ROAD_STD_TAIL_LIFT");
    expect(groupage.definitionKey).toBe("ROAD_STD_TAIL_LIFT");

    const transitPlans = await prisma.transitPlan.findMany({ where: { quoteId } });
    expect(transitPlans).toHaveLength(2);
    expect(transitPlans.map((t) => t.rateVariant).sort()).toEqual(["DEDICATED", "GROUPAGE"]);
    expect(transitPlans.find((t) => t.rateVariant === "DEDICATED")?.guaranteedTransitDays).toBe(3);
    expect(transitPlans.find((t) => t.rateVariant === "GROUPAGE")?.guaranteedTransitDays).toBe(5);

    // v3 dropped QuoteCargoLine.chargedWeightKg entirely (moved to Quote.chargedWeightKg above).
    const cargoLines = await prisma.quoteCargoLine.findMany({ where: { quoteId } });
    expect(cargoLines.length).toBeGreaterThan(0);
    expect(cargoLines[0]).not.toHaveProperty("chargedWeightKg");
  });

  // design §6 finding #8 (FF-portal preview showed empty charges post-submission): submit()
  // used to null Quote.draftJson, so resolveScope's GET fell back to seedQuoteDraft's blank
  // matrix for a QUOTED leg — indistinguishable from a leg nobody had opened. Proves the fix
  // end-to-end over real HTTP: distribute -> PATCH (price both variants + weight + notes) ->
  // POST submit -> a FRESH GET (a new request, not reading anything cached from the PATCH/submit
  // responses) must return leg.draft carrying those exact submitted figures, not nulls.
  it("GET after submit: leg.draft carries the SUBMITTED per-variant charges + chargedWeightKg + notes, not a blank reseed (finding #8)", async () => {
    const { token, legId } = await distributeRoadFixture();
    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const legDto = (got.body as FfPortalRfqDto).legs[0];

    const draft: QuoteDraft = {
      legId,
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 482.75,
      notes: "Handle with care -- fragile glassware",
      cargo: legDto.manifest.cargo.map((c) => ({
        packageId: c.packageId,
        grossWtKg: Number(c.grossWt),
        cbm: Number(c.volumeCbm ?? 0),
      })),
      charges: legDto.seededCharges.flatMap((c) => [
        {
          zone: c.zone,
          definitionKey: c.definitionKey,
          presetKey: c.presetKey,
          label: c.label,
          amount: 100,
          rateVariant: "DEDICATED" as const,
        },
        {
          zone: c.zone,
          definitionKey: c.definitionKey,
          presetKey: c.presetKey,
          label: c.label,
          amount: 150,
          rateVariant: "GROUPAGE" as const,
        },
      ]),
      trucking: [],
      seaRates: [],
      warehouse: [],
      transit: {
        departureDate: "2026-08-12T00:00:00.000Z",
        arrivalDate: "2026-08-14T00:00:00.000Z",
        guaranteedTransitDaysByVariant: { DEDICATED: 3, GROUPAGE: 5 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };

    await api().patch(`/api/ff/rfq/${token}/quotes/${legId}`).send(draft).expect(200);
    const submitRes = await api().post(`/api/ff/rfq/${token}/quotes/${legId}/submit`).expect(201);
    expect(submitRes.body.status).toBe("QUOTED");

    // The end-to-end proof: a brand-new GET, exactly what the portal's Preview/print/
    // AlreadySubmittedSummary all read from.
    const after = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const afterLeg = (after.body as FfPortalRfqDto).legs[0];
    expect(afterLeg.status).toBe("QUOTED");
    expect(afterLeg.draft).not.toBeNull();
    const afterDraft = afterLeg.draft as QuoteDraft;

    expect(afterDraft.chargedWeightKg).toBe(482.75);
    expect(afterDraft.notes).toBe("Handle with care -- fragile glassware");

    const tailLiftCells = afterDraft.charges.filter(
      (c) => c.definitionKey === "ROAD_STD_TAIL_LIFT",
    );
    expect(tailLiftCells).toHaveLength(2);
    const dedicated = tailLiftCells.find((c) => c.rateVariant === "DEDICATED");
    const groupage = tailLiftCells.find((c) => c.rateVariant === "GROUPAGE");
    expect(dedicated?.amount).toBe(100);
    expect(groupage?.amount).toBe(150);

    expect(afterDraft.transit?.guaranteedTransitDaysByVariant).toEqual({
      DEDICATED: 3,
      GROUPAGE: 5,
    });
  });

  it("submit: a priced variant (DEDICATED) missing its transit-days -> 422 Q_TRANSIT, Quote stays RFQ_SENT", async () => {
    const { token, legId } = await distributeRoadFixture();
    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const legDto = (got.body as FfPortalRfqDto).legs[0];

    const draft: QuoteDraft = {
      legId,
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 200,
      notes: null,
      cargo: legDto.manifest.cargo.map((c) => ({
        packageId: c.packageId,
        grossWtKg: Number(c.grossWt),
        cbm: Number(c.volumeCbm ?? 0),
      })),
      // only DEDICATED is priced -> only DEDICATED is a "priced variant"; its transit-days is
      // left out of the (otherwise valid, non-empty) map.
      charges: legDto.seededCharges.map((c) => ({
        zone: c.zone,
        definitionKey: c.definitionKey,
        presetKey: c.presetKey,
        label: c.label,
        amount: 100,
        rateVariant: "DEDICATED" as const,
      })),
      trucking: [],
      seaRates: [],
      warehouse: [],
      transit: {
        departureDate: null,
        arrivalDate: null,
        guaranteedTransitDaysByVariant: {}, // <-- the gap under test
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };

    await api().patch(`/api/ff/rfq/${token}/quotes/${legId}`).send(draft).expect(200);
    const res = await api().post(`/api/ff/rfq/${token}/quotes/${legId}/submit`).expect(422);
    expect(res.body.findings.map((f: { rule: string }) => f.rule)).toEqual(
      expect.arrayContaining(["Q_TRANSIT"]),
    );

    const quote = await prisma.quote.findFirst({ where: { legId } });
    expect(quote?.status).toBe("RFQ_SENT");
    expect(await prisma.transitPlan.count({ where: { quote: { legId } } })).toBe(0);
  });

  it("submit: missing the leg-level chargedWeightKg -> 422 Q_WEIGHT (field-scoped, not per-cargo), Quote stays RFQ_SENT", async () => {
    const { token, legId } = await distributeRoadFixture();
    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const legDto = (got.body as FfPortalRfqDto).legs[0];

    const draft: QuoteDraft = {
      legId,
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: null, // <-- the gap under test
      notes: null,
      cargo: legDto.manifest.cargo.map((c) => ({
        packageId: c.packageId,
        grossWtKg: Number(c.grossWt),
        cbm: Number(c.volumeCbm ?? 0),
      })),
      charges: legDto.seededCharges.map((c) => ({
        zone: c.zone,
        definitionKey: c.definitionKey,
        presetKey: c.presetKey,
        label: c.label,
        amount: 100,
        rateVariant: "DEDICATED" as const,
      })),
      trucking: [],
      seaRates: [],
      warehouse: [],
      transit: {
        departureDate: null,
        arrivalDate: null,
        guaranteedTransitDaysByVariant: { DEDICATED: 3 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };

    await api().patch(`/api/ff/rfq/${token}/quotes/${legId}`).send(draft).expect(200);
    const res = await api().post(`/api/ff/rfq/${token}/quotes/${legId}/submit`).expect(422);
    expect(res.body.findings.map((f: { rule: string }) => f.rule)).toEqual(
      expect.arrayContaining(["Q_WEIGHT"]),
    );
    const weightFinding = (
      res.body.findings as { rule: string; scope: { type: string; id?: string } }[]
    ).find((f) => f.rule === "Q_WEIGHT");
    // v3: Q_WEIGHT is a single leg-level field finding (was `{type:"cargo", id: packageId}` per
    // package pre-v3).
    expect(weightFinding?.scope).toEqual({ type: "field", id: "chargedWeightKg" });

    const quote = await prisma.quote.findFirst({ where: { legId } });
    expect(quote?.status).toBe("RFQ_SENT");
  });
});
