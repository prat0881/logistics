import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const PFX = "p5-model-";

describe("Point/Leg/LegCargo model (e2e)", () => {
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
    return prisma.query.create({ data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}q` } });
  }

  it("cascades points/legs/legCargo when the query is deleted", async () => {
    const q = await makeQuery();
    const pu = await prisma.point.create({ data: { queryId: q.id, type: "PICKUP", name: "PU" } });
    const de = await prisma.point.create({ data: { queryId: q.id, type: "DELIVERY", name: "DE" } });
    const cargo = await prisma.cargoItem.create({
      data: { queryId: q.id, rowIndex: 1, poReference: "PO", productName: "P", packageType: "Box", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 },
    });
    const leg = await prisma.leg.create({
      data: { queryId: q.id, legCode: "L1", originPointId: pu.id, destinationPointId: de.id, mode: "ROAD" },
    });
    await prisma.legCargo.create({ data: { legId: leg.id, cargoItemId: cargo.id } });

    expect(leg.status).toBe("DRAFT");
    expect(leg.executionStatus).toBe("PENDING");

    await prisma.query.delete({ where: { id: q.id } });
    expect(await prisma.point.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.leg.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.legCargo.count({ where: { legId: leg.id } })).toBe(0);
  });

  it("enforces unique legCode per query and unique (legId, cargoItemId)", async () => {
    const q = await makeQuery();
    await prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "ROAD" } });
    await expect(prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "SEA" } })).rejects.toThrow();

    const cargo = await prisma.cargoItem.create({
      data: { queryId: q.id, rowIndex: 1, poReference: "PO", productName: "P", packageType: "Box", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 },
    });
    const leg = await prisma.leg.create({ data: { queryId: q.id, legCode: "L2", mode: "ROAD" } });
    await prisma.legCargo.create({ data: { legId: leg.id, cargoItemId: cargo.id } });
    await expect(prisma.legCargo.create({ data: { legId: leg.id, cargoItemId: cargo.id } })).rejects.toThrow();
  });

  it("nulls a leg endpoint when its point is deleted (SetNull)", async () => {
    const q = await makeQuery();
    const pu = await prisma.point.create({ data: { queryId: q.id, type: "PICKUP", name: "PU" } });
    const de = await prisma.point.create({ data: { queryId: q.id, type: "DELIVERY", name: "DE" } });
    const leg = await prisma.leg.create({
      data: { queryId: q.id, legCode: "L1", originPointId: pu.id, destinationPointId: de.id, mode: "ROAD" },
    });
    await prisma.point.delete({ where: { id: pu.id } });
    const reloaded = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(reloaded?.originPointId).toBeNull();
  });
});
