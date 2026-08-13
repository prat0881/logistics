process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { effectiveTags } from "@svyft/shared";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { createCargoWithPackages, assignPackagesToLeg } from "./cargo";

// Task 19 (Unit 5, FF Portal v2 ripple): self-test for the shared package-grain cargo-builder
// helper (cargo.ts) that Tasks 20-23 will reuse across ~25 legacy Stage-4 e2e spec rewrites. This
// isn't testing product code — it's proving the helper itself writes real, valid Cargo -> Package
// -> Item + LegPackage rows against the real Postgres DB, at canonical cm/kg, with working
// effectiveTags composition and non-colliding auto-minted packageNos.
const PFX = "HLPRCARGO_";

describe(`${PFX}helpers/cargo (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: PFX } },
      select: { id: true },
    });
    for (const q of qs) {
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("creates 1 cargo + 2 packages + 1 item at canonical units, with effectiveTags = own tags ∪ item tags", async () => {
    const query = await prisma.query.create({ data: { queryCode: `${PFX}1`, incoterms: "FOB" } });

    const created = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ tags: ["FRAGILE"], items: [{ qty: 3, uom: "PC", tags: ["DG"] }] }, {}],
    });

    // --- shape: 1 cargo, 2 packages, 1 item ---
    expect(created.cargoId).toEqual(expect.any(String));
    expect(created.packageIds).toHaveLength(2);
    expect(created.itemIds).toHaveLength(1);

    // --- cargo: canonical units default to CM/KG ---
    const cargo = await prisma.cargo.findUniqueOrThrow({ where: { id: created.cargoId } });
    expect(cargo.queryId).toBe(query.id);
    expect(cargo.dimUnit).toBe("CM");
    expect(cargo.weightUnit).toBe("KG");
    expect(cargo.rowIndex).toBe(0);

    const packages = await prisma.package.findMany({
      where: { id: { in: created.packageIds } },
      include: { items: true },
      orderBy: { rowIndex: "asc" },
    });
    expect(packages).toHaveLength(2);
    expect(packages.map((p) => p.rowIndex)).toEqual([0, 1]);
    // auto-minted packageNo unique per package (no @@unique([queryId, packageNo]) collision)
    expect(new Set(packages.map((p) => p.packageNo)).size).toBe(2);

    const [pkg1, pkg2] = packages;

    // --- pkg1: explicit tags + a DG item; canonical dims/weight defaults applied ---
    expect(pkg1!.packageType).toBe("PALLET"); // default
    expect(Number(pkg1!.dimL)).toBe(120); // canonical cm default
    expect(Number(pkg1!.dimW)).toBe(80);
    expect(Number(pkg1!.dimH)).toBe(100);
    expect(Number(pkg1!.grossWt)).toBe(100); // canonical kg default
    expect(pkg1!.netWt).toBeNull();
    expect(pkg1!.tags).toEqual(["FRAGILE"]);
    expect(pkg1!.items).toHaveLength(1);
    expect(pkg1!.items[0]!.rowIndex).toBe(0);
    expect(Number(pkg1!.items[0]!.qty)).toBe(3);
    expect(pkg1!.items[0]!.uom).toBe("PC");
    expect(pkg1!.items[0]!.tags).toEqual(["DG"]);

    // BL-3: effectiveTags = own tags ∪ every item's tags — read the package back off Postgres and
    // run it through the real shared function, not a hand-asserted union.
    expect(effectiveTags(pkg1!)).toEqual(expect.arrayContaining(["FRAGILE", "DG"]));
    expect(effectiveTags(pkg1!)).toHaveLength(2);

    // --- pkg2: fully defaulted, no items, no tags ---
    expect(pkg2!.packageType).toBe("PALLET");
    expect(pkg2!.tags).toEqual([]);
    expect(pkg2!.items).toHaveLength(0);
    expect(effectiveTags(pkg2!)).toEqual([]);

    // --- assignPackagesToLeg: LegPackage row exists for the assigned package only ---
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-HLPRCARGO-1",
        mode: "AIR",
        originPointId: origin.id,
        destinationPointId: dest.id,
      },
    });

    await assignPackagesToLeg(prisma, leg.id, [pkg1!.id]);
    const legPackages = await prisma.legPackage.findMany({ where: { legId: leg.id } });
    expect(legPackages).toHaveLength(1);
    expect(legPackages[0]!.packageId).toBe(pkg1!.id);
  });

  it("mints non-colliding packageNos across two separate calls for the SAME query", async () => {
    const query = await prisma.query.create({ data: { queryCode: `${PFX}2`, incoterms: "FOB" } });

    // Two independent calls (mirrors a spec building cargo in two batches) — if the mint scheme
    // collided (e.g. reset per call, or index-only), the second call's insert would throw a P2002
    // unique-constraint violation on @@unique([queryId, packageNo]) instead of returning cleanly.
    const first = await createCargoWithPackages(prisma, { queryId: query.id, packages: [{}, {}] });
    const second = await createCargoWithPackages(prisma, { queryId: query.id, packages: [{}] });

    const all = await prisma.package.findMany({
      where: { id: { in: [...first.packageIds, ...second.packageIds] } },
    });
    expect(all).toHaveLength(3);
    expect(new Set(all.map((p) => p.packageNo)).size).toBe(3);
  });
});
