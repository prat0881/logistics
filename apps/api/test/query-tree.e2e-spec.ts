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

const PFX = "u1-qtree-";

// Unit 1 (Task 8 + query-read re-model): re-models queries.service.ts's create+read paths onto
// Query -> Cargo -> Package -> Item, and derives dgIndicator from the DG tag union across
// Package/Item (never auto-cleared). Cargo/Package/Item CRUD themselves are Tasks 4-7 (tested in
// cargo/package/item.e2e-spec.ts) -- this spec only exercises the QUERY read path
// (GET /api/queries/:id) that shapeQuery/syncDgIndicator sit behind. Leg-package assignment
// (Unit 1b) doesn't exist yet, so the leg roll-up here is only ever exercised empty (a bare Leg
// row seeded directly via Prisma, with zero legPackages).
describe("Query tree read + dgIndicator (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let seq = 0;
  // UUID sub — user.userId lands in @db.Uuid columns (Package.tenantId, Item.tenantId, ...).
  const USER_ID = "66666666-6666-6666-6666-666666666666";
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

  // Mints an isolated query per test, bypassing QueriesService (direct Prisma create, same
  // pattern as package.e2e-spec.ts/item.e2e-spec.ts's freshQuery) so a broken create-path
  // doesn't block read-path tests.
  async function freshQuery(): Promise<{ queryId: string }> {
    seq += 1;
    const q = await prisma.query.create({
      data: {
        queryCode: `ZU${Date.now()}${seq}`.slice(0, 24),
        shipmentDescription: `${PFX}${seq}`,
      },
    });
    return { queryId: q.id };
  }

  function addCargo(queryId: string, body: Record<string, unknown> = {}) {
    return api().post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie()).send(body);
  }

  function addPackage(queryId: string, cargoId: string, body: Record<string, unknown>) {
    return api()
      .post(`/api/queries/${queryId}/cargo/${cargoId}/packages`)
      .set("Cookie", cookie())
      .send(body);
  }

  function addItem(
    queryId: string,
    cargoId: string,
    packageId: string,
    body: Record<string, unknown>,
  ) {
    return api()
      .post(`/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items`)
      .set("Cookie", cookie())
      .send(body);
  }

  function getQuery(queryId: string) {
    return api().get(`/api/queries/${queryId}`).set("Cookie", cookie());
  }

  const pkg = (packageNo: string, extra: Record<string, unknown> = {}) => ({
    packageNo,
    packageType: "BOX",
    dimL: 10,
    dimW: 10,
    dimH: 10,
    grossWt: 5,
    ...extra,
  });

  it("derives dgIndicator=true from an item's DG tag (query -> cargo -> package -> item)", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    const p = await addPackage(queryId, cargo.body.id, pkg("P-1")).expect(201);
    await addItem(queryId, cargo.body.id, p.body.id, { product: "Battery", tags: ["DG"] }).expect(
      201,
    );

    const res = await getQuery(queryId).expect(200);
    expect(res.body.dgIndicator).toBe(true);
  });

  it("derives dgIndicator=true from a package's own DG tag", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    await addPackage(queryId, cargo.body.id, pkg("P-1", { tags: ["DG"] })).expect(201);

    const res = await getQuery(queryId).expect(200);
    expect(res.body.dgIndicator).toBe(true);
  });

  it("dgIndicator stays false when no Package or Item carries the DG tag", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    const p = await addPackage(queryId, cargo.body.id, pkg("P-1", { tags: ["FRAGILE"] })).expect(
      201,
    );
    await addItem(queryId, cargo.body.id, p.body.id, { product: "Widget" }).expect(201);

    const res = await getQuery(queryId).expect(200);
    expect(res.body.dgIndicator).toBe(false);
  });

  it("GET returns the shaped cargo tree (CargoDto[]: packageCount, numeric grossWeightKg, nested items)", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    const p1 = await addPackage(queryId, cargo.body.id, pkg("P-1")).expect(201);
    await addPackage(queryId, cargo.body.id, pkg("P-2")).expect(201);
    await addItem(queryId, cargo.body.id, p1.body.id, {
      product: "Widget",
      qty: 2,
      uom: "PC",
    }).expect(201);

    const res = await getQuery(queryId).expect(200);
    expect(Array.isArray(res.body.cargos)).toBe(true);
    const c = res.body.cargos.find((x: { id: string }) => x.id === cargo.body.id);
    expect(c.packageCount).toBe(2);
    expect(Number.isNaN(Number(c.grossWeightKg))).toBe(false);
    expect(Number(c.grossWeightKg)).toBeCloseTo(10, 3); // 5 + 5
    const found1 = c.packages.find((x: { id: string }) => x.id === p1.body.id);
    expect(found1.items).toHaveLength(1);
    expect(found1.items[0].product).toBe("Widget");
  });

  it("leg roll-up is empty and non-crashing when no packages are assigned to the leg", async () => {
    const { queryId } = await freshQuery();
    await prisma.leg.create({ data: { queryId, legCode: "U1-L1" } });

    const res = await getQuery(queryId).expect(200);
    expect(res.body.legs).toHaveLength(1);
    expect(res.body.legs[0].assignedPackageIds).toEqual([]);
    expect(res.body.legs[0].rollup).toEqual({
      totalPackages: 0,
      totalCbm: 0,
      totalGrossWt: 0,
      totalNetWt: 0,
    });
  });

  // Beyond the brief's 5 required tests: a smoke check for createQuery's re-modelled F6 gate
  // (requirement #4 — field findings moved to package grain). Not otherwise exercised by any
  // test above (those only hit GET). Deliberately does NOT satisfy the full F1 catalogue (no
  // client/contact/points) — findings is a flat concatenation of F1+F6+route findings, so an F6
  // entry is asserted to exist among whatever else 422s, without needing the full fixture that
  // create-query-route.e2e-spec.ts's (legacy, untouched) validQuery() builds.
  it("createQuery: a DG-tagged package with no MSDS produces an F6 finding at package grain", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    const p = await addPackage(queryId, cargo.body.id, pkg("P-1", { tags: ["DG"] })).expect(201);

    const res = await api()
      .post(`/api/queries/${queryId}/create`)
      .set("Cookie", cookie())
      .expect(422);
    const f6 = res.body.findings.find(
      (f: { rule: string; scope: { type: string; id: string } }) => f.rule === "F6",
    );
    expect(f6).toBeDefined();
    expect(f6.scope).toEqual({ type: "package", id: p.body.id });
  });
});
