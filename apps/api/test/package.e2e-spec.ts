process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";

const PFX = "p5-package-";

// Package CRUD (Task 5, re-modelled Query -> Cargo -> Package -> Item). Canonical cm/kg
// storage (dims/weights convert via the parent Cargo's dimUnit/weightUnit), packageNo V-5
// uniqueness (per query, case-insensitive + trimmed), MSDS attach. Item CRUD (Task 7) and
// add-N-copies (Task 6) are out of scope here.
describe("Package CRUD (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let seq = 0;
  // UUID sub — user.userId lands in @db.Uuid columns (Package.tenantId, FileAsset.uploadedById).
  const USER_ID = "44444444-4444-4444-4444-444444444444";
  const cookie = (role: Role = Role.EXECUTIVE) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: USER_ID, role, tenantId: null })}`;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(prisma);
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  // Mints an isolated query per test so rowIndex/list/V-5 assertions never see another test's rows.
  async function freshQuery(): Promise<{ queryId: string }> {
    seq += 1;
    const q = await prisma.query.create({
      data: { queryCode: `Z5${Date.now()}${seq}`.slice(0, 24), shipmentDescription: `${PFX}${seq}` },
    });
    return { queryId: q.id };
  }

  function addCargo(queryId: string, body: Record<string, unknown> = {}) {
    return api().post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie()).send(body);
  }

  // Thin POST wrapper — reused by Tasks 6/7's specs once add-N-copies/item endpoints exist.
  function addPackage(queryId: string, cargoId: string, body: Record<string, unknown>) {
    return api()
      .post(`/api/queries/${queryId}/cargo/${cargoId}/packages`)
      .set("Cookie", cookie())
      .send(body);
  }

  // Item CRUD (Task 7) doesn't exist yet — fixture items for the copy (Task 6) tests below are
  // seeded directly via Prisma rather than through an HTTP endpoint. queryId/cargoId are accepted
  // (not used — Item has no such columns) purely so call sites read symmetrically with addPackage.
  function addItem(_queryId: string, _cargoId: string, packageId: string, body: Record<string, unknown>) {
    return prisma.item.create({ data: { packageId, rowIndex: 1, ...body } });
  }

  // Thin POST wrapper for the Task 6 "add N copies" endpoint.
  function copyPackage(queryId: string, cargoId: string, pid: string, count: number) {
    return api()
      .post(`/api/queries/${queryId}/cargo/${cargoId}/packages/${pid}/copies`)
      .set("Cookie", cookie())
      .send({ count });
  }

  it("stores dims/weights canonically (mm/tonne entry → cm/kg) and computes volumeCbm", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, { dimUnit: "MM", weightUnit: "TONNE" }).expect(201);
    const p = await api()
      .post(`/api/queries/${queryId}/cargo/${cargo.body.id}/packages`)
      .set("Cookie", cookie())
      .send({ packageNo: "P-1", packageType: "CRATE", dimL: 1200, dimW: 1000, dimH: 1400, grossWt: 0.42 })
      .expect(201);
    expect(Number(p.body.dimL)).toBe(120); // 1200 mm → 120 cm
    expect(Number(p.body.grossWt)).toBe(420); // 0.42 t → 420 kg
    expect(Number(p.body.volumeCbm)).toBeCloseTo(1.68, 4);
    expect(p.body.rowIndex).toBe(1);
    expect(p.body.effectiveTags).toEqual([]);
    expect(p.body.items).toEqual([]);
  });

  it("rejects a duplicate packageNo within the query (V-5, case-insensitive/trimmed)", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    await addPackage(queryId, cargo.body.id, {
      packageNo: "P-1",
      packageType: "BOX",
      dimL: 1,
      dimW: 1,
      dimH: 1,
      grossWt: 1,
    }).expect(201);
    await api()
      .post(`/api/queries/${queryId}/cargo/${cargo.body.id}/packages`)
      .set("Cookie", cookie())
      .send({ packageNo: " p-1 ", packageType: "BOX", dimL: 1, dimW: 1, dimH: 1, grossWt: 1 })
      .expect(409);
  });

  it("rolls packages into the cargo's derived header (C7: Σ gross/volume, packageCount)", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, { dimUnit: "CM", weightUnit: "KG" }).expect(201);
    await addPackage(queryId, cargo.body.id, {
      packageNo: "P-1",
      packageType: "PALLET",
      dimL: 120,
      dimW: 100,
      dimH: 140,
      grossWt: 420,
    }).expect(201);
    await addPackage(queryId, cargo.body.id, {
      packageNo: "P-2",
      packageType: "BOX",
      dimL: 100,
      dimW: 50,
      dimH: 40,
      grossWt: 30,
    }).expect(201);
    const list = await api().get(`/api/queries/${queryId}/cargo`).set("Cookie", cookie()).expect(200);
    const c = list.body.find((x: { id: string }) => x.id === cargo.body.id);
    expect(c.packageCount).toBe(2);
    expect(Number(c.grossWeightKg)).toBeCloseTo(450, 3); // 420 + 30
    expect(Number(c.volumeCbm)).toBeCloseTo(1.88, 4); // 1.68 + 0.20
  });

  it("rejects creating a package under a cargo that doesn't belong to the query (bad ref, not P2003)", async () => {
    const { queryId: ownerQuery } = await freshQuery();
    const { queryId: otherQuery } = await freshQuery();
    const cargo = await addCargo(ownerQuery, {}).expect(201);
    await api()
      .post(`/api/queries/${otherQuery}/cargo/${cargo.body.id}/packages`)
      .set("Cookie", cookie())
      .send({ packageNo: "X-1", packageType: "BOX", dimL: 1, dimW: 1, dimH: 1, grossWt: 1 })
      .expect(400);
    await api()
      .post(`/api/queries/${ownerQuery}/cargo/00000000-0000-0000-0000-000000000000/packages`)
      .set("Cookie", cookie())
      .send({ packageNo: "X-2", packageType: "BOX", dimL: 1, dimW: 1, dimH: 1, grossWt: 1 })
      .expect(400);
  });

  it("updates a package (mediated, partial), re-converts dims canonically, and strips `reason`", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, { dimUnit: "MM", weightUnit: "KG" }).expect(201);
    const created = await addPackage(queryId, cargo.body.id, {
      packageNo: "P-1",
      packageType: "BOX",
      dimL: 100,
      dimW: 100,
      dimH: 100,
      grossWt: 10,
    }).expect(201);
    const updated = await api()
      .patch(`/api/queries/${queryId}/cargo/${cargo.body.id}/packages/${created.body.id}`)
      .set("Cookie", cookie())
      .send({ dimL: 200, reason: "remeasured" })
      .expect(200);
    expect(Number(updated.body.dimL)).toBe(20); // 200 mm → 20 cm
    expect(Number(updated.body.dimW)).toBe(10); // untouched field survives a partial patch (100mm → 10cm)
    expect(updated.body.packageNo).toBe("P-1");
  });

  // Carry-forward fix (Task 7 §A1): a partial PATCH bypasses packageUpdateSchema's `.refine()`
  // because the refine only sees the patch, not the stored row — `{grossWt:50}` alone never
  // triggers the "netWt <= grossWt" check. The service must merge patched-or-stored canonical
  // gross/net and validate the merged pair. Before the fix this returns 200 and persists
  // netWt(90) > grossWt(50); confirmed failing first per TDD before implementing.
  it("rejects a partial PATCH that would leave stored netWt above the patched grossWt (V-2 merge-then-validate)", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, { dimUnit: "CM", weightUnit: "KG" }).expect(201);
    const created = await addPackage(queryId, cargo.body.id, {
      packageNo: "P-1",
      packageType: "BOX",
      dimL: 1,
      dimW: 1,
      dimH: 1,
      grossWt: 100,
      netWt: 90,
    }).expect(201);
    await api()
      .patch(`/api/queries/${queryId}/cargo/${cargo.body.id}/packages/${created.body.id}`)
      .set("Cookie", cookie())
      .send({ grossWt: 50 })
      .expect(400);
  });

  it("rejects renaming a package to a packageNo already used elsewhere in the query (V-5 on update)", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    await addPackage(queryId, cargo.body.id, {
      packageNo: "P-1",
      packageType: "BOX",
      dimL: 1,
      dimW: 1,
      dimH: 1,
      grossWt: 1,
    }).expect(201);
    const p2 = await addPackage(queryId, cargo.body.id, {
      packageNo: "P-2",
      packageType: "BOX",
      dimL: 1,
      dimW: 1,
      dimH: 1,
      grossWt: 1,
    }).expect(201);
    await api()
      .patch(`/api/queries/${queryId}/cargo/${cargo.body.id}/packages/${p2.body.id}`)
      .set("Cookie", cookie())
      .send({ packageNo: "p-1" })
      .expect(409);
  });

  it("deletes a package (mediated @delete)", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    const created = await addPackage(queryId, cargo.body.id, {
      packageNo: "P-1",
      packageType: "BOX",
      dimL: 1,
      dimW: 1,
      dimH: 1,
      grossWt: 1,
    }).expect(201);
    await api()
      .delete(`/api/queries/${queryId}/cargo/${cargo.body.id}/packages/${created.body.id}`)
      .set("Cookie", cookie())
      .expect(204);
    expect(await prisma.package.findUnique({ where: { id: created.body.id } })).toBeNull();
  });

  it("uploads an MSDS PDF, links it to the package, and rejects a non-PDF", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    const created = await addPackage(queryId, cargo.body.id, {
      packageNo: "P-1",
      packageType: "DRUM",
      dimL: 1,
      dimW: 1,
      dimH: 1,
      grossWt: 1,
    }).expect(201);
    const pdf = Buffer.from("%PDF-1.4\n%mock\n");
    const up = await api()
      .post(`/api/queries/${queryId}/cargo/${cargo.body.id}/packages/${created.body.id}/msds`)
      .set("Cookie", cookie())
      .attach("file", pdf, "msds.pdf")
      .expect(201);
    expect(up.body.msdsFileId).toBeTruthy();
    const asset = await prisma.fileAsset.findUnique({ where: { id: up.body.msdsFileId } });
    expect(asset?.kind).toBe("MSDS");
    await api()
      .post(`/api/queries/${queryId}/cargo/${cargo.body.id}/packages/${created.body.id}/msds`)
      .set("Cookie", cookie())
      .attach("file", Buffer.from("PNG"), "x.png")
      .expect(400);
  });

  // Task 6: "add N copies" — PackageService.copy, mounted at POST …/packages/:pid/copies.
  describe("copy — add N copies (Task 6)", () => {
    it("clones a package N times with unique packageNos and copied items", async () => {
      const { queryId } = await freshQuery();
      const cargo = await addCargo(queryId, {}).expect(201);
      const p = await addPackage(queryId, cargo.body.id, {
        packageNo: "PLT",
        packageType: "PALLET",
        dimL: 120,
        dimW: 100,
        dimH: 140,
        grossWt: 420,
      }).expect(201);
      await addItem(queryId, cargo.body.id, p.body.id, { product: "Paint", qty: 8, uom: "PC" });

      const res = await copyPackage(queryId, cargo.body.id, p.body.id, 2).expect(201);

      expect(res.body).toHaveLength(2);
      const nos = res.body.map((x: { packageNo: string }) => x.packageNo);
      expect(new Set(nos).size).toBe(2);
      expect(res.body[0].items).toHaveLength(1);
      expect(res.body[0].items[0]).toMatchObject({ product: "Paint", qty: "8", uom: "PC" });
      expect(res.body[1].items).toHaveLength(1);
    });

    it("copies canonical dims/weights/type/tags unchanged onto every clone, with fresh ids", async () => {
      const { queryId } = await freshQuery();
      const cargo = await addCargo(queryId, { dimUnit: "MM", weightUnit: "KG" }).expect(201);
      const p = await addPackage(queryId, cargo.body.id, {
        packageNo: "P-1",
        packageType: "DRUM",
        dimL: 100,
        dimW: 200,
        dimH: 300,
        grossWt: 55,
        netWt: 50,
        tags: ["FRAGILE"],
      }).expect(201);

      const res = await copyPackage(queryId, cargo.body.id, p.body.id, 2).expect(201);
      for (const clone of res.body) {
        expect(clone.id).not.toBe(p.body.id);
        expect(clone.packageType).toBe("DRUM");
        expect(Number(clone.dimL)).toBe(10); // 100mm -> 10cm, same canonical conversion as source
        expect(Number(clone.dimW)).toBe(20);
        expect(Number(clone.dimH)).toBe(30);
        expect(Number(clone.grossWt)).toBe(55);
        expect(Number(clone.netWt)).toBe(50);
        expect(clone.tags).toEqual(["FRAGILE"]);
      }
    });

    it("skips a packageNo already taken (existing '-2') and picks the next free suffix", async () => {
      const { queryId } = await freshQuery();
      const cargo = await addCargo(queryId, {}).expect(201);
      const p = await addPackage(queryId, cargo.body.id, {
        packageNo: "BASE",
        packageType: "BOX",
        dimL: 1,
        dimW: 1,
        dimH: 1,
        grossWt: 1,
      }).expect(201);
      // Pre-occupy "BASE-2" with an unrelated package before copying.
      await addPackage(queryId, cargo.body.id, {
        packageNo: "BASE-2",
        packageType: "BOX",
        dimL: 1,
        dimW: 1,
        dimH: 1,
        grossWt: 1,
      }).expect(201);

      const res = await copyPackage(queryId, cargo.body.id, p.body.id, 2).expect(201);
      const nos = res.body.map((x: { packageNo: string }) => x.packageNo);
      expect(nos).toEqual(["BASE-3", "BASE-4"]);
    });

    it("assigns fresh, incrementing rowIndex to clones within the cargo", async () => {
      const { queryId } = await freshQuery();
      const cargo = await addCargo(queryId, {}).expect(201);
      const p1 = await addPackage(queryId, cargo.body.id, {
        packageNo: "P-1",
        packageType: "BOX",
        dimL: 1,
        dimW: 1,
        dimH: 1,
        grossWt: 1,
      }).expect(201);
      expect(p1.body.rowIndex).toBe(1);

      const res = await copyPackage(queryId, cargo.body.id, p1.body.id, 2).expect(201);
      const rowIndexes = res.body
        .map((x: { rowIndex: number }) => x.rowIndex)
        .sort((a: number, b: number) => a - b);
      expect(rowIndexes).toEqual([2, 3]);
    });

    it("404s copying a package that doesn't belong to the query, or doesn't exist", async () => {
      const { queryId: ownerQuery } = await freshQuery();
      const { queryId: otherQuery } = await freshQuery();
      const cargo = await addCargo(ownerQuery, {}).expect(201);
      const p = await addPackage(ownerQuery, cargo.body.id, {
        packageNo: "P-1",
        packageType: "BOX",
        dimL: 1,
        dimW: 1,
        dimH: 1,
        grossWt: 1,
      }).expect(201);
      await copyPackage(otherQuery, cargo.body.id, p.body.id, 2).expect(404);
      await copyPackage(
        ownerQuery,
        cargo.body.id,
        "00000000-0000-0000-0000-000000000000",
        2,
      ).expect(404);
    });

    it("rejects an out-of-range count (bounds are 2..50)", async () => {
      const { queryId } = await freshQuery();
      const cargo = await addCargo(queryId, {}).expect(201);
      const p = await addPackage(queryId, cargo.body.id, {
        packageNo: "P-1",
        packageType: "BOX",
        dimL: 1,
        dimW: 1,
        dimH: 1,
        grossWt: 1,
      }).expect(201);
      await copyPackage(queryId, cargo.body.id, p.body.id, 1).expect(400);
      await copyPackage(queryId, cargo.body.id, p.body.id, 51).expect(400);
    });

    // Carry-forward fix (Task 7 §B): each clone is its own mediated transaction (no batch
    // atomicity), so a mid-batch throw can leave an unsignaled PREFIX of already-committed
    // clones. Trigger a deterministic mid-batch failure WITHOUT reaching into Prisma's internal
    // interactive-transaction client (mocking `tx.package.create` isn't reliable — `tx` is a
    // distinct object from `prisma.package` created per-transaction, not the same instance a
    // jest.spyOn on the outer `prisma.package` would intercept). Instead: `copy()` calls
    // `prisma.package.findFirst` OUTSIDE any tx, 3 times before it matters here — #1 loads
    // `source`, #2 is clone 0's `nextPackageNo` probe (succeeds → clone 0 fully commits via its
    // own tx), #3 is clone 1's `nextPackageNo` probe. Rejecting on call #3 throws inside
    // `nextPackageNo()` BEFORE clone 1's own `mediator.apply`/`tx.package.create` ever runs — so
    // the only row that could be orphaned is clone 0, which by then already committed.
    it("rolls back already-committed clones when a later clone in the batch fails (Task 7 §B)", async () => {
      const { queryId } = await freshQuery();
      const cargo = await addCargo(queryId, {}).expect(201);
      const p = await addPackage(queryId, cargo.body.id, {
        packageNo: "ROLLBACK",
        packageType: "BOX",
        dimL: 1,
        dimW: 1,
        dimH: 1,
        grossWt: 1,
      }).expect(201);

      type FindFirstFn = typeof prisma.package.findFirst;
      const original: FindFirstFn = prisma.package.findFirst.bind(prisma.package);
      let calls = 0;
      // Cast the whole implementation to FindFirstFn (rather than typing the return of each
      // branch): Prisma's real return type is a fluent `Prisma__PackageClient` thenable (extra
      // chain methods like `.include()`), not a bare Promise, so a plain
      // `Promise.reject(...)`/pass-through return doesn't structurally match it even though both
      // branches are only ever awaited here, never chained.
      const spy = jest.spyOn(prisma.package, "findFirst").mockImplementation(((
        ...args: Parameters<FindFirstFn>
      ) => {
        calls += 1;
        if (calls === 3) return Promise.reject(new Error("simulated DB failure (test)"));
        return original(...args);
      }) as FindFirstFn);

      try {
        await copyPackage(queryId, cargo.body.id, p.body.id, 3).expect(500);
      } finally {
        spy.mockRestore();
      }

      // No orphaned prefix: only the original source package survives under this cargo.
      expect(await prisma.package.count({ where: { cargoId: cargo.body.id } })).toBe(1);
    });
  });
});
