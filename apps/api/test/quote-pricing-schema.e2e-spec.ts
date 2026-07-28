import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

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
    // Clean children of Quote first (Restrict FKs), then Quote, then parents
    await prisma.transitPlan.deleteMany({ where: { quote: { query: { queryCode: { startsWith: PFX } } } } }).catch(() => {});
    await prisma.warehouseStagingLine.deleteMany({ where: { quote: { query: { queryCode: { startsWith: PFX } } } } }).catch(() => {});
    await prisma.truckingCharge.deleteMany({ where: { quote: { query: { queryCode: { startsWith: PFX } } } } }).catch(() => {});
    await prisma.chargeLine.deleteMany({ where: { quote: { query: { queryCode: { startsWith: PFX } } } } }).catch(() => {});
    await prisma.quoteCargoLine.deleteMany({ where: { quote: { query: { queryCode: { startsWith: PFX } } } } }).catch(() => {});
    await prisma.quote.deleteMany({ where: { query: { queryCode: { startsWith: PFX } } } }).catch(() => {});
    await prisma.legCargo.deleteMany({ where: { leg: { query: { queryCode: { startsWith: PFX } } } } }).catch(() => {});
    await prisma.leg.deleteMany({ where: { query: { queryCode: { startsWith: PFX } } } }).catch(() => {});
    await prisma.cargoItem.deleteMany({ where: { query: { queryCode: { startsWith: PFX } } } }).catch(() => {});
    await prisma.point.deleteMany({ where: { query: { queryCode: { startsWith: PFX } } } }).catch(() => {});
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: PFX } } }).catch(() => {});
    await prisma.query.deleteMany({ where: { queryCode: { startsWith: PFX } } }).catch(() => {});
  }

  it("creates and reads back all five pricing child tables with correct types", async () => {
    const code = `${PFX}${Date.now()}`;
    const ffCode = `${PFX}FF-${Date.now()}`;

    // 1. Create the parent chain: Query → Leg → CargoItem → Point(s) → FreightForwarder → Quote
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

    const cargo = await prisma.cargoItem.create({
      data: {
        queryId: query.id,
        rowIndex: 1,
        poReference: "PO-001",
        productName: "Widget",
        packageType: "Box",
        qty: 2,
        dimL: 100,
        dimW: 80,
        dimH: 60,
        grossWt: 50,
      },
    });

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
        totalChargeableWeightT: 2.500,
        grandTotal: 1500.00,
        dgSurchargeNote: "No DG",
        termsConditions: "NET 30",
      },
    });

    // 2. Insert one row per pricing table
    const qcl = await prisma.quoteCargoLine.create({
      data: {
        quoteId: quote.id,
        cargoItemId: cargo.id,
        freightDensity: 167.000,
        chargeableWeightT: 2.500,
      },
    });

    const cl = await prisma.chargeLine.create({
      data: {
        quoteId: quote.id,
        zone: "ORIGIN",
        label: "Origin handling",
        isPreset: true,
        presetKey: "ORIGIN_HANDLING",
        amount: 200.00,
        sortOrder: 1,
      },
    });

    const tc = await prisma.truckingCharge.create({
      data: {
        quoteId: quote.id,
        legEndpointPointId: originPoint.id,
        truckingType: "DEDICATED",
        basis: "PER_TRUCK",
        amount: 350.00,
        remarks: "Door pickup",
      },
    });

    const wsl = await prisma.warehouseStagingLine.create({
      data: {
        quoteId: quote.id,
        warehousePointId: originPoint.id,
        position: "ORIGIN",
        label: "Origin staging",
        isPreset: false,
        amount: 100.00,
        cargoAcceptanceWindow: "2026-08-01T08:00:00Z",
      },
    });

    const tp = await prisma.transitPlan.create({
      data: {
        quoteId: quote.id,
        carrier: "Emirates SkyCargo",
        flightVoyageNo: "EK9601",
        departureDate: new Date("2026-08-05T10:00:00Z"),
        arrivalDate: new Date("2026-08-06T06:00:00Z"),
        carrierSurcharge: 50.00,
        guaranteedTransitDays: 1,
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
        warehouseStagingLines: true,
        transitPlan: true,
      },
    });

    expect(Number(reloadedQuote.totalChargeableWeightT)).toBeCloseTo(2.5, 3);
    expect(Number(reloadedQuote.grandTotal)).toBeCloseTo(1500, 2);
    expect(reloadedQuote.dgSurchargeNote).toBe("No DG");
    expect(reloadedQuote.termsConditions).toBe("NET 30");

    // QuoteCargoLine
    expect(reloadedQuote.quoteCargoLines).toHaveLength(1);
    expect(Number(reloadedQuote.quoteCargoLines[0].chargeableWeightT)).toBeCloseTo(2.5, 3);
    expect(Number(reloadedQuote.quoteCargoLines[0].freightDensity)).toBeCloseTo(167, 3);
    expect(reloadedQuote.quoteCargoLines[0].cargoItemId).toBe(cargo.id);

    // ChargeLine
    expect(reloadedQuote.chargeLines).toHaveLength(1);
    expect(reloadedQuote.chargeLines[0].zone).toBe("ORIGIN");
    expect(Number(reloadedQuote.chargeLines[0].amount)).toBeCloseTo(200, 2);
    expect(reloadedQuote.chargeLines[0].presetKey).toBe("ORIGIN_HANDLING");

    // TruckingCharge
    expect(reloadedQuote.truckingCharges).toHaveLength(1);
    expect(reloadedQuote.truckingCharges[0].truckingType).toBe("DEDICATED");
    expect(reloadedQuote.truckingCharges[0].basis).toBe("PER_TRUCK");
    expect(reloadedQuote.truckingCharges[0].legEndpointPointId).toBe(originPoint.id);

    // WarehouseStagingLine
    expect(reloadedQuote.warehouseStagingLines).toHaveLength(1);
    expect(reloadedQuote.warehouseStagingLines[0].position).toBe("ORIGIN");
    expect(reloadedQuote.warehouseStagingLines[0].warehousePointId).toBe(originPoint.id);
    expect(reloadedQuote.warehouseStagingLines[0].cargoAcceptanceWindow).toBe("2026-08-01T08:00:00Z");

    // TransitPlan (1:1)
    expect(reloadedQuote.transitPlan).not.toBeNull();
    expect(reloadedQuote.transitPlan!.carrier).toBe("Emirates SkyCargo");
    expect(reloadedQuote.transitPlan!.flightVoyageNo).toBe("EK9601");
    expect(reloadedQuote.transitPlan!.guaranteedTransitDays).toBe(1);
    expect(reloadedQuote.transitPlan!.quoteId).toBe(quote.id);

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

    // Cascade: deleting Quote removes all 5 child rows
    await prisma.quote.delete({ where: { id: quote.id } });
    expect(await prisma.quoteCargoLine.count({ where: { id: qcl.id } })).toBe(0);
    expect(await prisma.chargeLine.count({ where: { id: cl.id } })).toBe(0);
    expect(await prisma.truckingCharge.count({ where: { id: tc.id } })).toBe(0);
    expect(await prisma.warehouseStagingLine.count({ where: { id: wsl.id } })).toBe(0);
    expect(await prisma.transitPlan.count({ where: { id: tp.id } })).toBe(0);
  });
});
