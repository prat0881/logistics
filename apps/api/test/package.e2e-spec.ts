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
});
