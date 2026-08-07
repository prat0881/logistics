process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { formatQueryCode } from "@svyft/shared";

const PFX = "p4-model-";

describe("Query/Cargo model (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.query.deleteMany({ where: { queryCode: { startsWith: "YAL" }, shipmentDescription: { startsWith: PFX } } });
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("mints a YALYY-NNNN code from a row-locked QuerySequence, atomically", async () => {
    const year = new Date().getFullYear();
    await prisma.querySequence.upsert({ where: { year }, create: { year, lastNumber: 0 }, update: {} });
    const before = (await prisma.querySequence.findUnique({ where: { year } }))!.lastNumber;
    const q = await prisma.$transaction(async (tx) => {
      const seq = await tx.querySequence.upsert({
        where: { year },
        create: { year, lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
      });
      return tx.query.create({
        data: { queryCode: formatQueryCode(year, seq.lastNumber), shipmentDescription: `${PFX}mint` },
      });
    });
    expect(q.queryCode).toMatch(/^YAL\d{2}-\d{4}$/);
    expect((await prisma.querySequence.findUnique({ where: { year } }))!.lastNumber).toBe(before + 1);
    expect(q.status).toBe("DRAFT"); // column default, not hand-written
  });

  // volumeCbm moved from the flat CargoItem (dimL*dimW*dimH*qty/1e6) to Package (Package has no
  // qty — a Package IS one physical unit — so the generated expression drops the ×qty factor:
  // dimL*dimW*dimH/1e6). referenceTags -> Package.tags. A Package always needs a parent Cargo
  // grouping row.
  it("computes volumeCbm as a generated column and rejects a direct write to it", async () => {
    const q = await prisma.query.create({ data: { queryCode: `Z-${randomUUID()}`, shipmentDescription: `${PFX}vol` } });
    const cargo = await prisma.cargo.create({ data: { queryId: q.id, rowIndex: 0, poReference: "PO-1" } });
    const p = await prisma.package.create({
      data: {
        queryId: q.id, cargoId: cargo.id, rowIndex: 1, packageNo: "P-1", packageType: "PALLET",
        tags: ["HEAVY", "FRAGILE"], dimL: 120, dimW: 80, dimH: 100, grossWt: 500,
      },
    });
    expect(Number(p.volumeCbm)).toBeCloseTo(0.96, 6); // (120*80*100)/1e6
    expect(p.tags).toEqual(["HEAVY", "FRAGILE"]);
    await expect(
      prisma.$executeRaw`INSERT INTO "Package" (id, "queryId", "cargoId", "rowIndex", "packageNo", "packageType", "dimL", "dimW", "dimH", "grossWt", "volumeCbm") VALUES (gen_random_uuid(), ${q.id}::uuid, ${cargo.id}::uuid, 2, 'P-2', 'BOX', 1, 1, 1, 1, 5.0)`,
    ).rejects.toThrow();
  });

  // Query -> Cargo -> Package is a two-level cascade now (was one flat CargoItem table) —
  // assert BOTH levels are gone, not just the top one, so the whole chain is isolated rather
  // than just re-proving Query -> Cargo.
  it("cascade-deletes cargo + package + checklist + files when the query is deleted", async () => {
    const q = await prisma.query.create({ data: { queryCode: `Z-${randomUUID()}`, shipmentDescription: `${PFX}cascade` } });
    const cargo = await prisma.cargo.create({ data: { queryId: q.id, rowIndex: 0, poReference: "P" } });
    await prisma.package.create({ data: { queryId: q.id, cargoId: cargo.id, rowIndex: 1, packageNo: "P-1", packageType: "BOX", dimL: 1, dimW: 1, dimH: 1, grossWt: 1 } });
    await prisma.queryChecklistItem.create({ data: { queryId: q.id, itemKey: "weight-confirmed" } });
    await prisma.fileAsset.create({ data: { queryId: q.id, kind: "MSDS", filename: "x.pdf", mime: "application/pdf", sizeBytes: 1, storageKey: "k" } });
    await prisma.query.delete({ where: { id: q.id } });
    expect(await prisma.cargo.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.package.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.queryChecklistItem.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.fileAsset.count({ where: { queryId: q.id } })).toBe(0);
  });
});
