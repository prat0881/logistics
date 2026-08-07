import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const PFX = "p5-model-";

describe("Point/Leg/LegPackage model (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  async function makeQuery() {
    return prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}q` },
    });
  }

  // A Package always needs a parent Cargo grouping row — built directly via Prisma (not
  // helpers/cargo.ts) to match this file's low-level, one-model-fact-per-test style, same as the
  // already-migrated legs.e2e-spec.ts/routing.e2e-spec.ts.
  async function makePackage(queryId: string) {
    const cargo = await prisma.cargo.create({ data: { queryId, rowIndex: 0, poReference: "PO" } });
    return prisma.package.create({
      data: {
        queryId,
        cargoId: cargo.id,
        rowIndex: 1,
        packageNo: "P-1",
        packageType: "BOX",
        dimL: 1,
        dimW: 1,
        dimH: 1,
        grossWt: 1,
      },
    });
  }

  it("cascades points/legs/legPackage when the query is deleted", async () => {
    const q = await makeQuery();
    const pu = await prisma.point.create({ data: { queryId: q.id, type: "PICKUP", name: "PU" } });
    const de = await prisma.point.create({ data: { queryId: q.id, type: "DELIVERY", name: "DE" } });
    const pkg = await makePackage(q.id);
    const leg = await prisma.leg.create({
      data: {
        queryId: q.id,
        legCode: "L1",
        originPointId: pu.id,
        destinationPointId: de.id,
        mode: "ROAD",
      },
    });
    await prisma.legPackage.create({ data: { legId: leg.id, packageId: pkg.id } });

    expect(leg.status).toBe("DRAFT");
    expect(leg.executionStatus).toBe("PENDING");

    await prisma.query.delete({ where: { id: q.id } });
    expect(await prisma.point.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.leg.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.legPackage.count({ where: { legId: leg.id } })).toBe(0);
  });

  it("enforces unique legCode per query and unique (legId, packageId)", async () => {
    const q = await makeQuery();
    await prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "ROAD" } });
    await expect(
      prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "SEA" } }),
    ).rejects.toThrow();

    const pkg = await makePackage(q.id);
    const leg = await prisma.leg.create({ data: { queryId: q.id, legCode: "L2", mode: "ROAD" } });
    await prisma.legPackage.create({ data: { legId: leg.id, packageId: pkg.id } });
    await expect(
      prisma.legPackage.create({ data: { legId: leg.id, packageId: pkg.id } }),
    ).rejects.toThrow();
  });

  it("nulls a leg endpoint when its point is deleted (SetNull)", async () => {
    const q = await makeQuery();
    const pu = await prisma.point.create({ data: { queryId: q.id, type: "PICKUP", name: "PU" } });
    const de = await prisma.point.create({ data: { queryId: q.id, type: "DELIVERY", name: "DE" } });
    const leg = await prisma.leg.create({
      data: {
        queryId: q.id,
        legCode: "L1",
        originPointId: pu.id,
        destinationPointId: de.id,
        mode: "ROAD",
      },
    });
    await prisma.point.delete({ where: { id: pu.id } });
    const reloaded = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(reloaded?.originPointId).toBeNull();
  });
});
