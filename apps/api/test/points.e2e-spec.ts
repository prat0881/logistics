import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
const PFX = "p5-points-";
const EXEC_ID = "11111111-1111-1111-1111-111111111111";

describe("Points (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let queryId: string;
  const cookie = () => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: EXEC_ID, role: Role.EXECUTIVE, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    const q = await prisma.query.create({ data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}q` } });
    queryId = q.id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("creates a pickup point", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/points`)
      .set("Cookie", cookie())
      .send({ type: "PICKUP", name: "Shipper", country: "IN" })
      .expect(201);
    expect(res.body.type).toBe("PICKUP");
    expect(res.body.id).toBeDefined();
  });

  it("rejects a bad IATA code (Zod 400)", async () => {
    await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/points`)
      .set("Cookie", cookie())
      .send({ type: "AIRPORT", iataCode: "toolong" })
      .expect(400);
  });

  it("404s a point create under a missing query", async () => {
    await request(app.getHttpServer())
      .post(`/api/queries/${EXEC_ID}/points`)
      .set("Cookie", cookie())
      .send({ type: "PICKUP" })
      .expect(404);
  });

  it("persists and returns a point timezone", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/points`)
      .set("Cookie", cookie())
      .send({ type: "PICKUP", name: "Shipper", timezone: "Asia/Singapore" })
      .expect(201);
    expect(res.body.timezone).toBe("Asia/Singapore");
  });

  it("rejects an invalid point timezone (Zod 400)", async () => {
    await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/points`)
      .set("Cookie", cookie())
      .send({ type: "PICKUP", timezone: "Bad/Zone" })
      .expect(400);
  });

  it("patches and deletes a point", async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/points`)
      .set("Cookie", cookie())
      .send({ type: "WAREHOUSE", name: "WH" })
      .expect(201);
    const pid = created.body.id;
    await request(app.getHttpServer())
      .patch(`/api/queries/${queryId}/points/${pid}`)
      .set("Cookie", cookie())
      .send({ city: "Mumbai" })
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/api/queries/${queryId}/points/${pid}`)
      .set("Cookie", cookie())
      .expect(204);
  });

  it("409s when deleting a point referenced by a leg (does not null the endpoint)", async () => {
    const pu = await prisma.point.create({ data: { queryId, type: "PICKUP", name: "RefPU" } });
    const de = await prisma.point.create({ data: { queryId, type: "DELIVERY", name: "RefDE" } });
    const leg = await prisma.leg.create({
      data: { queryId, legCode: `${PFX}L1`, originPointId: pu.id, destinationPointId: de.id, mode: "ROAD" },
    });

    await request(app.getHttpServer())
      .delete(`/api/queries/${queryId}/points/${pu.id}`)
      .set("Cookie", cookie())
      .expect(409);

    // The leg still references the point — the SetNull FK was NOT reached.
    const reloaded = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(reloaded?.originPointId).toBe(pu.id);

    // Cleanup this test's leg so it doesn't collide with other specs' legCode scans.
    await prisma.leg.delete({ where: { id: leg.id } });
  });
});
