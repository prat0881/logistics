process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const PFX = "cpl-model-";
describe("Cargo/Package/Item model (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = m.get(PrismaService);
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("computes volumeCbm = L*W*H/1e6 (no ×qty) and cascades cargo→package→item", async () => {
    const q = await prisma.query.create({
      data: { queryCode: `Z${Date.now()}`.slice(0, 12), shipmentDescription: `${PFX}a` },
    });
    const cargo = await prisma.cargo.create({
      data: { queryId: q.id, rowIndex: 0, poReference: "PO-1", dimUnit: "CM", weightUnit: "KG" },
    });
    const pkg = await prisma.package.create({
      data: {
        queryId: q.id,
        cargoId: cargo.id,
        rowIndex: 0,
        packageNo: "P-1",
        packageType: "PALLET",
        dimL: 120,
        dimW: 100,
        dimH: 140,
        grossWt: 420,
        tags: ["DG"],
      },
    });
    expect(Number(pkg.volumeCbm)).toBeCloseTo(1.68, 6); // 120*100*140/1e6
    await prisma.item.create({
      data: {
        packageId: pkg.id,
        rowIndex: 0,
        product: "Deck paint",
        qty: 8,
        uom: "PC",
        hsCode: "32081090",
      },
    });
    await prisma.query.delete({ where: { id: q.id } });
    expect(await prisma.package.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.item.count({ where: { packageId: pkg.id } })).toBe(0);
  });

  it("enforces packageNo uniqueness per query (V-5)", async () => {
    const q = await prisma.query.create({
      data: { queryCode: `Z${Date.now() + 1}`.slice(0, 12), shipmentDescription: `${PFX}b` },
    });
    const c = await prisma.cargo.create({ data: { queryId: q.id, rowIndex: 0 } });
    await prisma.package.create({
      data: {
        queryId: q.id,
        cargoId: c.id,
        rowIndex: 0,
        packageNo: "DUP",
        packageType: "BOX",
        dimL: 1,
        dimW: 1,
        dimH: 1,
        grossWt: 1,
      },
    });
    await expect(
      prisma.package.create({
        data: {
          queryId: q.id,
          cargoId: c.id,
          rowIndex: 1,
          packageNo: "DUP",
          packageType: "BOX",
          dimL: 1,
          dimW: 1,
          dimH: 1,
          grossWt: 1,
        },
      }),
    ).rejects.toThrow();
  });
});
