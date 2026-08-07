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

const PFX = "p4-cargo-";

// Cargo GROUPING CRUD (Task 4, re-modelled Query -> Cargo -> Package -> Item). Package/item/
// MSDS/export coverage is added in Tasks 5/7/9 once those endpoints exist.
describe("Cargo grouping (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let seq = 0;
  // UUID sub — user.userId lands in @db.Uuid columns (Cargo.tenantId is nullable but the
  // ChangeLog actor column is not; keep it a real UUID like every other spec's synthetic user).
  const USER_ID = "22222222-2222-2222-2222-222222222222";
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

  // Mints an isolated query per test so rowIndex/list assertions never see another test's rows.
  async function freshQuery(): Promise<{ queryId: string }> {
    seq += 1;
    const q = await prisma.query.create({
      data: {
        queryCode: `Z4${Date.now()}${seq}`.slice(0, 24),
        shipmentDescription: `${PFX}${seq}`,
      },
    });
    return { queryId: q.id };
  }

  // Thin POST wrapper — reused by Tasks 5/7/9's specs once package/item/export endpoints exist.
  function addCargo(queryId: string, body: Record<string, unknown> = {}) {
    return api().post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie()).send(body);
  }

  it("creates a cargo and returns a zeroed derived header before any packages exist", async () => {
    const { queryId } = await freshQuery();
    const cargo = await api()
      .post(`/api/queries/${queryId}/cargo`)
      .set("Cookie", cookie())
      .send({ poReference: "PO-1", dimUnit: "CM", weightUnit: "KG" })
      .expect(201);
    expect(cargo.body.packageCount).toBe(0);
    expect(Number(cargo.body.grossWeightKg)).toBe(0);
    expect(cargo.body.chargeableWeight).toBeNull(); // H7 blank at Stage 3
    const list = await api()
      .get(`/api/queries/${queryId}/cargo`)
      .set("Cookie", cookie())
      .expect(200);
    expect(list.body.find((x: { id: string }) => x.id === cargo.body.id).poReference).toBe("PO-1");
  });
  // The POPULATED header (Σ gross/volume, packageCount, unioned tags over real packages) is
  // verified in Task 5's package test, once the package-create endpoint + shapePackage exist.

  it("auto-numbers rowIndex across multiple creates and applies dimUnit/weightUnit defaults", async () => {
    const { queryId } = await freshQuery();
    const r1 = await addCargo(queryId, { poReference: "A" }).expect(201);
    const r2 = await addCargo(queryId, { poReference: "B" }).expect(201);
    expect(r2.body.rowIndex).toBe(r1.body.rowIndex + 1);
    expect(r1.body.dimUnit).toBe("CM");
    expect(r1.body.weightUnit).toBe("KG");
    expect(r1.body.label).toBeNull();
    expect(r1.body.packages).toEqual([]);
    expect(r1.body.tags).toEqual([]);
  });

  it("updates a cargo's header fields (mediated, partial) and rejects an unknown dimUnit", async () => {
    const { queryId } = await freshQuery();
    const created = await addCargo(queryId, { poReference: "PO-1" }).expect(201);
    const updated = await api()
      .patch(`/api/queries/${queryId}/cargo/${created.body.id}`)
      .set("Cookie", cookie())
      .send({ label: "Machinery parts" })
      .expect(200);
    expect(updated.body.label).toBe("Machinery parts");
    expect(updated.body.poReference).toBe("PO-1"); // untouched fields survive a partial patch
    await api()
      .patch(`/api/queries/${queryId}/cargo/${created.body.id}`)
      .set("Cookie", cookie())
      .send({ dimUnit: "INCH" })
      .expect(400);
  });

  it("deletes a cargo (mediated @delete)", async () => {
    const { queryId } = await freshQuery();
    const created = await addCargo(queryId, { poReference: "PO-1" }).expect(201);
    await api()
      .delete(`/api/queries/${queryId}/cargo/${created.body.id}`)
      .set("Cookie", cookie())
      .expect(204);
    expect(await prisma.cargo.findUnique({ where: { id: created.body.id } })).toBeNull();
  });

  it("404s a cargo row looked up under a mismatched query", async () => {
    const { queryId } = await freshQuery();
    const created = await addCargo(queryId, { poReference: "PO-1" }).expect(201);
    await api()
      .patch(`/api/queries/00000000-0000-0000-0000-000000000000/cargo/${created.body.id}`)
      .set("Cookie", cookie())
      .send({ label: "X" })
      .expect(404);
  });

  it("404s creating a cargo under a query that does not exist", async () => {
    await addCargo("00000000-0000-0000-0000-000000000000", { poReference: "PO-1" }).expect(404);
  });
});
