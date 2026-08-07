import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { createCargoWithPackages } from "./helpers/cargo";

const PFX = "qp-schema-";

describe("Quote pricing schema — smoke (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // mandatory — prevents cron hang
  });

  async function cleanup() {
    // Quote (and its Cascade children: QuoteCargoLine/ChargeLine/TruckingCharge/SeaFreightRate/
    // WarehouseStagingLine/TransitPlan) must be deleted BEFORE Query — QuoteCargoLine.packageId ->
    // Package is onDelete: Restrict, so if Query's cascade reached Package first (deleting it)
    // while a QuoteCargoLine still pointed at it, the delete would fail (mirrors the quote-then-
    // query cleanup order in ff-portal-v2-model.e2e-spec.ts / ff-portal-grain.e2e-spec.ts).
    await prisma.quote
      .deleteMany({ where: { query: { queryCode: { startsWith: PFX } } } })
      .catch(() => {});
    await prisma.query.deleteMany({ where: { queryCode: { startsWith: PFX } } }).catch(() => {}); // cascades points/legs/cargo/packages/items
    await prisma.freightForwarder
      .deleteMany({ where: { freightForwarderCode: { startsWith: PFX } } })
      .catch(() => {});
  }

  it("creates and reads back all six pricing child tables with correct types", async () => {
    const code = `${PFX}${Date.now()}`;
    const ffCode = `${PFX}FF-${Date.now()}`;

    // 1. Create the parent chain: Query → Leg → Cargo→Package → Point(s) → FreightForwarder → Quote
    const query = await prisma.query.create({ data: { queryCode: code } });

    const originPoint = await prisma.point.create({
      data: { queryId: query.id, type: "WAREHOUSE", name: "Origin WH" },
    });

    const destPoint = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", name: "Dest DL" },
    });

    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L1",
        originPointId: originPoint.id,
        destinationPointId: destPoint.id,
        mode: "AIR",
      },
    });

    // Cargo → Package replaces the dropped flat CargoItem model (Unit 2 re-model).
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageType: "BOX", dimL: 100, dimW: 80, dimH: 60, grossWt: 50 }],
    });
    const packageId = packageIds[0]!;

    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: ffCode,
        companyName: `${ffCode} Co`,
        pic: "Agent",
        contactNumber: "+10000000001",
        email: `${ffCode}@e2e.test`,
        availableCountries: ["AE"],
        modes: ["AIR"],
        handleDg: false,
      },
    });

    const quote = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ff.id,
        status: "SELECT",
        totalChargeableWeightT: 2.5, // column kept for now but unused post-Unit-2 (kg lives on QuoteCargoLine) — still a real, writable Decimal(12,3) column
        grandTotal: 1500.0,
        dgSurchargeNote: "No DG",
        termsConditions: "NET 30",
      },
    });

    // 2. Insert one row per pricing table — v2 grain (design §7, Unit 2 re-model): QuoteCargoLine
    // keys off packageId only in v3 (the FF-entered chargeable weight it briefly carried,
    // chargedWeightKg, moved to the leg-level Quote.chargedWeightKg — see design §3.1/D2 — so
    // QuoteCargoLine is back to a pure pointer row); TruckingCharge/SeaFreightRate carry
    // the dual-rate rateVariant (+tonnage/containerSize); ChargeLine/WarehouseStagingLine grew
    // mode-specific calc/attribution columns; SeaFreightRate is a new 6th pricing child table
    // (replaces the retired flat SEA_MAIN_FREIGHT preset). ChargeLine/TransitPlan additionally
    // grew a nullable v3 `rateVariant` (the per-variant charge-matrix column — see below).
    const qcl = await prisma.quoteCargoLine.create({
      data: {
        quoteId: quote.id,
        packageId,
      },
    });

    const cl = await prisma.chargeLine.create({
      data: {
        quoteId: quote.id,
        zone: "ORIGIN",
        label: "Origin handling",
        isPreset: true,
        presetKey: "ORIGIN_HANDLING",
        definitionKey: "AIR_ORIGIN_THC",
        amount: 200.0,
        sortOrder: 1,
        rateVariant: "DEDICATED", // v3: the per-variant matrix column this charge belongs to
      },
    });

    const tc = await prisma.truckingCharge.create({
      data: {
        quoteId: quote.id,
        legEndpointPointId: originPoint.id,
        truckingType: "DEDICATED",
        basis: "PER_TRUCK",
        amount: 350.0,
        remarks: "Door pickup",
        rateVariant: "DEDICATED",
        tonnage: "T_5",
      },
    });

    const sfr = await prisma.seaFreightRate.create({
      data: {
        quoteId: quote.id,
        rateVariant: "FCL",
        containerSize: "FORTY",
        amount: 1800.0,
        remarks: "Main leg",
      },
    });

    const wsl = await prisma.warehouseStagingLine.create({
      data: {
        quoteId: quote.id,
        warehousePointId: originPoint.id,
        position: "ORIGIN",
        label: "Origin staging",
        isPreset: false,
        amount: 100.0,
        cargoAcceptanceWindow: "2026-08-01T08:00:00Z",
        cfsCode: "CFS-001",
        side: "DROP",
      },
    });

    const tp = await prisma.transitPlan.create({
      data: {
        quoteId: quote.id,
        rateVariant: "DEDICATED", // v3: one TransitPlan row per (quoteId, rateVariant) — see below
        carrier: "Emirates SkyCargo",
        flightVoyageNo: "EK9601",
        departureDate: new Date("2026-08-05T10:00:00Z"),
        arrivalDate: new Date("2026-08-06T06:00:00Z"),
        carrierSurcharge: 50.0,
        guaranteedTransitDays: 1,
        airline: "Emirates SkyCargo",
        flightNumber: "EK9601",
      },
    });

    // 3. Read back and assert
    // Quote pricing columns
    const reloadedQuote = await prisma.quote.findUniqueOrThrow({
      where: { id: quote.id },
      include: {
        quoteCargoLines: true,
        chargeLines: true,
        truckingCharges: true,
        seaFreightRates: true,
        warehouseStagingLines: true,
        transitPlans: true, // v3: Quote.transitPlan (1:nullable-1) renamed to transitPlans (1:many)
      },
    });

    expect(Number(reloadedQuote.totalChargeableWeightT)).toBeCloseTo(2.5, 3);
    expect(Number(reloadedQuote.grandTotal)).toBeCloseTo(1500, 2);
    expect(reloadedQuote.dgSurchargeNote).toBe("No DG");
    expect(reloadedQuote.termsConditions).toBe("NET 30");

    // QuoteCargoLine — v3: packageId only (chargedWeightKg moved to the leg-level
    // Quote.chargedWeightKg; the older density-derived columns were already gone pre-v3)
    expect(reloadedQuote.quoteCargoLines).toHaveLength(1);
    expect(reloadedQuote.quoteCargoLines[0].packageId).toBe(packageId);
    expect(reloadedQuote.quoteCargoLines[0]).not.toHaveProperty("chargedWeightKg");
    expect(reloadedQuote.quoteCargoLines[0]).not.toHaveProperty("freightDensity");
    expect(reloadedQuote.quoteCargoLines[0]).not.toHaveProperty("chargeableWeightT");

    // ChargeLine
    expect(reloadedQuote.chargeLines).toHaveLength(1);
    expect(reloadedQuote.chargeLines[0].zone).toBe("ORIGIN");
    expect(Number(reloadedQuote.chargeLines[0].amount)).toBeCloseTo(200, 2);
    expect(reloadedQuote.chargeLines[0].presetKey).toBe("ORIGIN_HANDLING");
    expect(reloadedQuote.chargeLines[0].definitionKey).toBe("AIR_ORIGIN_THC");
    expect(reloadedQuote.chargeLines[0].rateVariant).toBe("DEDICATED"); // v3

    // TruckingCharge — v2 dual-rate: rateVariant + tonnage
    expect(reloadedQuote.truckingCharges).toHaveLength(1);
    expect(reloadedQuote.truckingCharges[0].truckingType).toBe("DEDICATED");
    expect(reloadedQuote.truckingCharges[0].basis).toBe("PER_TRUCK");
    expect(reloadedQuote.truckingCharges[0].legEndpointPointId).toBe(originPoint.id);
    expect(reloadedQuote.truckingCharges[0].rateVariant).toBe("DEDICATED");
    expect(reloadedQuote.truckingCharges[0].tonnage).toBe("T_5");

    // SeaFreightRate — new v2 pricing child table
    expect(reloadedQuote.seaFreightRates).toHaveLength(1);
    expect(reloadedQuote.seaFreightRates[0].rateVariant).toBe("FCL");
    expect(reloadedQuote.seaFreightRates[0].containerSize).toBe("FORTY");
    expect(Number(reloadedQuote.seaFreightRates[0].amount)).toBeCloseTo(1800, 2);

    // WarehouseStagingLine — v2 gained cfsCode/side
    expect(reloadedQuote.warehouseStagingLines).toHaveLength(1);
    expect(reloadedQuote.warehouseStagingLines[0].position).toBe("ORIGIN");
    expect(reloadedQuote.warehouseStagingLines[0].warehousePointId).toBe(originPoint.id);
    expect(reloadedQuote.warehouseStagingLines[0].cargoAcceptanceWindow).toBe(
      "2026-08-01T08:00:00Z",
    );
    expect(reloadedQuote.warehouseStagingLines[0].cfsCode).toBe("CFS-001");
    expect(reloadedQuote.warehouseStagingLines[0].side).toBe("DROP");

    // TransitPlan — v3: Quote.transitPlans is now 1:many (one row per priced rate variant), keyed
    // by the composite (quoteId, rateVariant) unique index instead of one-row-per-quote; this
    // fixture creates exactly one (DEDICATED) row. Pre-existing columns (carrier/flightVoyageNo/
    // guaranteedTransitDays/mode-specific airline/flightNumber) kept as-is.
    expect(reloadedQuote.transitPlans).toHaveLength(1);
    const transitPlan = reloadedQuote.transitPlans[0];
    expect(transitPlan.rateVariant).toBe("DEDICATED"); // v3
    expect(transitPlan.carrier).toBe("Emirates SkyCargo");
    expect(transitPlan.flightVoyageNo).toBe("EK9601");
    expect(transitPlan.guaranteedTransitDays).toBe(1);
    expect(transitPlan.quoteId).toBe(quote.id);
    expect(transitPlan.airline).toBe("Emirates SkyCargo");
    expect(transitPlan.flightNumber).toBe("EK9601");

    // Point back-relations
    const reloadedOriginPoint = await prisma.point.findUniqueOrThrow({
      where: { id: originPoint.id },
      include: { truckingCharges: true, warehouseStagingLines: true },
    });
    expect(reloadedOriginPoint.truckingCharges).toHaveLength(1);
    expect(reloadedOriginPoint.warehouseStagingLines).toHaveLength(1);

    // Verify IDs are consistent with created rows
    expect(reloadedOriginPoint.truckingCharges[0].id).toBe(tc.id);
    expect(reloadedOriginPoint.warehouseStagingLines[0].id).toBe(wsl.id);

    // Verify Restrict FK: cannot delete Point while TruckingCharge references it
    await expect(prisma.point.delete({ where: { id: originPoint.id } })).rejects.toThrow();

    // Verify Restrict FK (new in v2): cannot delete Package while QuoteCargoLine references it —
    // QuoteCargoLine.packageId -> Package is onDelete: Restrict, the same protective shape as the
    // TruckingCharge/WarehouseStagingLine -> Point Restrict FKs verified above.
    await expect(prisma.package.delete({ where: { id: packageId } })).rejects.toThrow();

    // Cascade: deleting Quote removes all 6 child rows
    await prisma.quote.delete({ where: { id: quote.id } });
    expect(await prisma.quoteCargoLine.count({ where: { id: qcl.id } })).toBe(0);
    expect(await prisma.chargeLine.count({ where: { id: cl.id } })).toBe(0);
    expect(await prisma.truckingCharge.count({ where: { id: tc.id } })).toBe(0);
    expect(await prisma.seaFreightRate.count({ where: { id: sfr.id } })).toBe(0);
    expect(await prisma.warehouseStagingLine.count({ where: { id: wsl.id } })).toBe(0);
    expect(await prisma.transitPlan.count({ where: { id: tp.id } })).toBe(0);
  });
});
