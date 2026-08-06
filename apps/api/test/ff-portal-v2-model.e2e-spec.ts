process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

// Unit 2 / Task 4 (FF Portal v2): additive Prisma migration. QuoteCargoLine's density-derived
// freightDensity/chargeableWeightT columns are replaced by a single FF-entered chargedWeightKg;
// TruckingCharge and the new SeaFreightRate model carry a dual-rate shape (rateVariant +
// tonnage/containerSize); ChargeLine/WarehouseStagingLine/TransitPlan grow mode-specific calc
// columns; and ChargeLineInputType gains a HEAVY_WEIGHT_CALC label. This spec round-trips real
// rows through the real Prisma client against the real (local) Postgres to prove the migration
// applied cleanly — pre-migration, the generated Prisma client doesn't know these fields/models/
// labels, so every `data:` block below fails to typecheck and (transpiled with isolatedModules)
// rejects at runtime with `PrismaClientValidationError: Unknown argument`.
const PFX = "V2MODEL_";

describe("FF Portal v2 schema (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let counter = 0;

  // One query -> origin/dest points -> cargo -> package -> leg -> freight forwarder -> quote
  // fixture per call, all namespaced under PFX so cleanup can find them by prefix.
  const makeFixture = async () => {
    const n = ++counter;
    const query = await prisma.query.create({
      data: { queryCode: `${PFX}${n}`, shipmentDescription: `${PFX}fixture-${n}` },
    });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });
    const cargo = await prisma.cargo.create({ data: { queryId: query.id, rowIndex: 0 } });
    const pkg = await prisma.package.create({
      data: {
        queryId: query.id,
        cargoId: cargo.id,
        rowIndex: 0,
        packageNo: `${PFX}PK-${n}`,
        packageType: "BOX",
        dimL: 100,
        dimW: 50,
        dimH: 40,
        grossWt: 120,
      },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `${PFX}L-${n}`,
        mode: "SEA",
        status: "DRAFT",
        originPointId: origin.id,
        destinationPointId: dest.id,
      },
    });
    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `${PFX}FF-${n}`,
        companyName: `${PFX}FF Co ${n}`,
        pic: "P. Tester",
        contactNumber: "+10000000000",
        email: `${PFX.toLowerCase()}ff${n}@e2e.test`,
      },
    });
    const quote = await prisma.quote.create({
      data: { queryId: query.id, legId: leg.id, freightForwarderId: ff.id },
    });
    return { query, origin, dest, pkg, leg, ff, quote };
  };

  // Quote (and its Cascade children: QuoteCargoLine/ChargeLine/TruckingCharge/SeaFreightRate/
  // WarehouseStagingLine/TransitPlan) must be deleted BEFORE Query. QuoteCargoLine.packageId ->
  // Package is onDelete: Restrict, so if Query's cascade reached Package first (deleting it)
  // while a QuoteCargoLine still pointed at it, the delete would fail — mirrors the quote-then-
  // query cleanup order in ff-portal-grain.e2e-spec.ts. FreightForwarder is deleted last because
  // Quote.freightForwarderId -> FreightForwarder is also Restrict.
  const cleanup = async () => {
    const queries = await prisma.query.findMany({
      where: { queryCode: { startsWith: PFX } },
      select: { id: true },
    });
    const queryIds = queries.map((q) => q.id);
    if (queryIds.length) {
      await prisma.quote.deleteMany({ where: { queryId: { in: queryIds } } });
    }
    for (const id of queryIds) {
      await prisma.query.delete({ where: { id } }); // cascades points/legs/cargo/packages
    }
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: PFX } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await cleanup(); // in case a prior crashed run left rows behind
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("stores chargedWeightKg, a dual-rate trucking row, and a SeaFreightRate", async () => {
    const { pkg, quote, origin } = await makeFixture();

    await prisma.quoteCargoLine.create({
      data: { quoteId: quote.id, packageId: pkg.id, chargedWeightKg: "123.5" },
    });
    await prisma.truckingCharge.create({
      data: {
        quoteId: quote.id,
        legEndpointPointId: origin.id,
        truckingType: "DEDICATED",
        basis: "PER_TRUCK",
        amount: "500",
        rateVariant: "DEDICATED",
        tonnage: "TRAILER_30_40T",
      },
    });
    const sea = await prisma.seaFreightRate.create({
      data: { quoteId: quote.id, rateVariant: "FCL", containerSize: "FORTY", amount: "1800" },
    });

    const line = await prisma.quoteCargoLine.findFirstOrThrow({ where: { quoteId: quote.id } });
    expect(line).not.toHaveProperty("freightDensity");
    expect(line).not.toHaveProperty("chargeableWeightT");
    expect(Number(line.chargedWeightKg)).toBe(123.5);

    const trucking = await prisma.truckingCharge.findFirstOrThrow({ where: { quoteId: quote.id } });
    expect(trucking.rateVariant).toBe("DEDICATED");
    expect(trucking.tonnage).toBe("TRAILER_30_40T");

    expect(sea.rateVariant).toBe("FCL");
    expect(sea.containerSize).toBe("FORTY");
    expect(Number(sea.amount)).toBe(1800);

    // Quote -> SeaFreightRate[] back-relation resolves.
    const quoteWithRates = await prisma.quote.findUniqueOrThrow({
      where: { id: quote.id },
      include: { seaFreightRates: true },
    });
    expect(quoteWithRates.seaFreightRates).toHaveLength(1);
    expect(quoteWithRates.seaFreightRates[0]?.id).toBe(sea.id);
  });

  it("stores ChargeLine calc inputs + B/L type, WarehouseStagingLine cfsCode/side, and TransitPlan mode-specific columns", async () => {
    const { quote, origin } = await makeFixture();

    const charge = await prisma.chargeLine.create({
      data: {
        quoteId: quote.id,
        label: "Heavy weight surcharge",
        amount: "250",
        pieceWeightKg: "180.5",
        airlineLimitKg: "150",
        ratePerExcessKg: "2.75",
        billOfLadingType: "TELEX",
      },
    });
    expect(Number(charge.pieceWeightKg)).toBe(180.5);
    expect(Number(charge.airlineLimitKg)).toBe(150);
    expect(Number(charge.ratePerExcessKg)).toBe(2.75);
    expect(charge.billOfLadingType).toBe("TELEX");

    const warehouse = await prisma.warehouseStagingLine.create({
      data: {
        quoteId: quote.id,
        warehousePointId: origin.id,
        position: "ORIGIN",
        label: "CFS staging",
        amount: "75",
        cfsCode: "CFS-001",
        side: "DROP",
      },
    });
    expect(warehouse.cfsCode).toBe("CFS-001");
    expect(warehouse.side).toBe("DROP");

    const transit = await prisma.transitPlan.create({
      data: {
        quoteId: quote.id,
        departureDate: new Date("2026-09-01T00:00:00Z"),
        arrivalDate: new Date("2026-09-05T00:00:00Z"),
        plannedPickupDate: new Date("2026-08-30T00:00:00Z"),
        airline: "Emirates SkyCargo",
        flightNumber: "EK9821",
        plannedDeparture: new Date("2026-09-01T10:00:00Z"),
        plannedArrival: new Date("2026-09-01T18:00:00Z"),
        shippingLine: "Maersk",
        vesselVoyage: "MAERSK ESSEX / 123W",
        etd: new Date("2026-09-01T12:00:00Z"),
        eta: new Date("2026-09-05T08:00:00Z"),
      },
    });
    expect(transit.plannedPickupDate?.toISOString()).toBe("2026-08-30T00:00:00.000Z");
    expect(transit.airline).toBe("Emirates SkyCargo");
    expect(transit.flightNumber).toBe("EK9821");
    expect(transit.plannedDeparture?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(transit.plannedArrival?.toISOString()).toBe("2026-09-01T18:00:00.000Z");
    expect(transit.shippingLine).toBe("Maersk");
    expect(transit.vesselVoyage).toBe("MAERSK ESSEX / 123W");
    expect(transit.etd?.toISOString()).toBe("2026-09-01T12:00:00.000Z");
    expect(transit.eta?.toISOString()).toBe("2026-09-05T08:00:00.000Z");
  });

  it("adds HEAVY_WEIGHT_CALC to the ChargeLineInputType enum at the database level", async () => {
    // Queries the Postgres enum catalog directly (rather than via ChargeLineDefinition, whose 49
    // seeded rows this suite must not touch) to prove `ALTER TYPE ... ADD VALUE` actually landed.
    const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
      FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.typname = 'ChargeLineInputType'
      ORDER BY e.enumsortorder
    `;
    expect(rows.map((r) => r.enumlabel)).toEqual(
      expect.arrayContaining(["PLAIN", "TRUCKING", "WAREHOUSE_STAGING", "HEAVY_WEIGHT_CALC"]),
    );
  });
});
