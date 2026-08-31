process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ffFixture } from "./helpers/freight-forwarder";

// Task 2 (FF Portal v3, per-variant quoting): additive+destructive Prisma migration.
// Quote grows a leg-level `chargedWeightKg` + `notes` (chargeable weight used to live on
// QuoteCargoLine, per package; v3 captures one informational value per leg instead).
// QuoteCargoLine's `chargedWeightKg` is dropped. ChargeLine grows a nullable `rateVariant`
// (the per-variant charge-matrix column a line belongs to: null = Air's single implicit
// column or a non-variant line; DEDICATED/GROUPAGE/FCL/LCL for Road/Sea). TransitPlan grows
// the same nullable `rateVariant` and its uniqueness widens from one-row-per-quote to
// one-row-per-(quoteId, rateVariant), since Guaranteed Transit Time is now captured per
// variant instead of once per leg. This spec round-trips real rows through the real Prisma
// client against the real (local) Postgres to prove the migration applied cleanly --
// pre-migration, the generated Prisma client doesn't know these fields/shapes, so every
// `data:` block below fails to typecheck and (transpiled with isolatedModules) rejects at
// runtime with `PrismaClientValidationError: Unknown argument`.
const PFX = "V3MODEL_";

describe("FF Portal v3 schema (e2e)", () => {
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
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
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
        mode: "ROAD",
        status: "DRAFT",
        originPointId: origin.id,
        destinationPointId: dest.id,
      },
    });
    const ff = await prisma.freightForwarder.create({
      data: ffFixture({
        freightForwarderCode: `${PFX}FF-${n}`,
        companyName: `${PFX}FF Co ${n}`,
        pic: "P. Tester",
        contactNumber: "+10000000000",
        email: `${PFX.toLowerCase()}ff${n}@e2e.test`,
      }),
    });
    const quote = await prisma.quote.create({
      data: { queryId: query.id, legId: leg.id, freightForwarderId: ff.id },
    });
    return { query, origin, dest, pkg, leg, ff, quote };
  };

  // Quote (and its Cascade children: QuoteCargoLine/ChargeLine/TransitPlan/...) must be deleted
  // BEFORE Query. QuoteCargoLine.packageId -> Package is onDelete: Restrict, so if Query's
  // cascade reached Package first (deleting it) while a QuoteCargoLine still pointed at it, the
  // delete would fail -- mirrors ff-portal-v2-model.e2e-spec.ts. FreightForwarder is deleted
  // last because Quote.freightForwarderId -> FreightForwarder is also Restrict.
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
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: PFX } },
    });
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
    await app.close(); // MANDATORY -- otherwise jest hangs on the schedule cron
  });

  it("stores a leg-level Quote.chargedWeightKg + Quote.notes; QuoteCargoLine no longer carries chargedWeightKg", async () => {
    const { pkg, quote } = await makeFixture();

    const updated = await prisma.quote.update({
      where: { id: quote.id },
      data: { chargedWeightKg: "482.750", notes: "Handle with care -- fragile glassware" },
    });
    expect(Number(updated.chargedWeightKg)).toBe(482.75);
    expect(updated.notes).toBe("Handle with care -- fragile glassware");

    const line = await prisma.quoteCargoLine.create({
      data: { quoteId: quote.id, packageId: pkg.id },
    });
    expect(line).not.toHaveProperty("chargedWeightKg");
  });

  it("stores per-variant ChargeLine rows (rateVariant null = Air's single implicit column / a non-variant line; DEDICATED/GROUPAGE/FCL/LCL = Road/Sea matrix columns)", async () => {
    const { quote } = await makeFixture();

    const shared = await prisma.chargeLine.create({
      data: { quoteId: quote.id, label: "Fuel surcharge", amount: "50" }, // rateVariant omitted -> null
    });
    expect(shared.rateVariant).toBeNull();

    const variants = ["DEDICATED", "GROUPAGE", "FCL", "LCL"] as const;
    for (const rateVariant of variants) {
      const line = await prisma.chargeLine.create({
        data: { quoteId: quote.id, label: "Origin handling", amount: "100", rateVariant },
      });
      expect(line.rateVariant).toBe(rateVariant);
    }

    const rows = await prisma.chargeLine.findMany({
      where: { quoteId: quote.id },
      select: { rateVariant: true },
    });
    expect(rows).toHaveLength(5);
    expect(rows).toEqual(
      expect.arrayContaining([
        { rateVariant: null },
        { rateVariant: "DEDICATED" },
        { rateVariant: "GROUPAGE" },
        { rateVariant: "FCL" },
        { rateVariant: "LCL" },
      ]),
    );
  });

  it("stores one TransitPlan row per (quoteId, rateVariant) and enforces the composite uniqueness (v2 allowed only one row per quote, full stop)", async () => {
    const { quote } = await makeFixture();

    const dedicated = await prisma.transitPlan.create({
      data: { quoteId: quote.id, rateVariant: "DEDICATED", guaranteedTransitDays: 5 },
    });
    const groupage = await prisma.transitPlan.create({
      data: { quoteId: quote.id, rateVariant: "GROUPAGE", guaranteedTransitDays: 9 },
    });
    expect(dedicated.rateVariant).toBe("DEDICATED");
    expect(dedicated.guaranteedTransitDays).toBe(5);
    expect(groupage.rateVariant).toBe("GROUPAGE");
    expect(groupage.guaranteedTransitDays).toBe(9);

    // Quote -> TransitPlan is now a list relation (was a nullable 1:1 pre-v3): both rows resolve.
    const withPlans = await prisma.quote.findUniqueOrThrow({
      where: { id: quote.id },
      include: { transitPlans: true },
    });
    expect(withPlans.transitPlans.map((t) => t.rateVariant).sort()).toEqual([
      "DEDICATED",
      "GROUPAGE",
    ]);

    // The composite (quoteId, rateVariant) unique index rejects a second DEDICATED row for the
    // same quote -- proves the old one-row-per-quote uniqueness was replaced, not just widened
    // permissively (i.e. it's still "one row per variant", not "any number of rows").
    await expect(
      prisma.transitPlan.create({
        data: { quoteId: quote.id, rateVariant: "DEDICATED", guaranteedTransitDays: 6 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("reflects the v3 migration in the database catalog: new/dropped columns and the composite TransitPlan index replacing the old singular one", async () => {
    const enumColumns = await prisma.$queryRaw<
      { table_name: string; column_name: string; udt_name: string; is_nullable: string }[]
    >`
      SELECT table_name, column_name, udt_name, is_nullable
      FROM information_schema.columns
      WHERE (table_name = 'ChargeLine' AND column_name = 'rateVariant')
         OR (table_name = 'TransitPlan' AND column_name = 'rateVariant')
      ORDER BY table_name
    `;
    expect(enumColumns).toEqual([
      { table_name: "ChargeLine", column_name: "rateVariant", udt_name: "ChargeRateVariant", is_nullable: "YES" },
      { table_name: "TransitPlan", column_name: "rateVariant", udt_name: "ChargeRateVariant", is_nullable: "YES" },
    ]);

    const quoteColumns = await prisma.$queryRaw<
      {
        column_name: string;
        data_type: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
        is_nullable: string;
      }[]
    >`
      SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'Quote' AND column_name IN ('chargedWeightKg', 'notes')
      ORDER BY column_name
    `;
    expect(quoteColumns).toEqual([
      {
        column_name: "chargedWeightKg",
        data_type: "numeric",
        numeric_precision: 12,
        numeric_scale: 3,
        is_nullable: "YES",
      },
      { column_name: "notes", data_type: "text", numeric_precision: null, numeric_scale: null, is_nullable: "YES" },
    ]);

    const droppedColumn = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'QuoteCargoLine' AND column_name = 'chargedWeightKg'
    `;
    expect(droppedColumn).toEqual([]);

    const newIndex = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'TransitPlan' AND indexname = 'TransitPlan_quoteId_rateVariant_key'
    `;
    expect(newIndex).toEqual([
      {
        indexdef:
          'CREATE UNIQUE INDEX "TransitPlan_quoteId_rateVariant_key" ON public."TransitPlan" USING btree ("quoteId", "rateVariant")',
      },
    ]);

    const oldIndex = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'TransitPlan' AND indexname = 'TransitPlan_quoteId_key'
    `;
    expect(oldIndex).toEqual([]); // the old one-row-per-quote unique index is gone, not just shadowed
  });
});
