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
const PFX = "p5-legs-";
const EXEC_ID = "11111111-1111-1111-1111-111111111111";

describe("Legs (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let queryId: string;
  let pickupId: string;
  let deliveryId: string;
  let seaportId: string;
  let cargoId: string;
  const cookie = () => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: EXEC_ID, role: Role.EXECUTIVE, tenantId: null })}`;
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
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    const q = await prisma.query.create({ data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}q` } });
    queryId = q.id;
    pickupId = (await prisma.point.create({ data: { queryId, type: "PICKUP", name: "PU", country: "IN" } })).id;
    deliveryId = (await prisma.point.create({ data: { queryId, type: "DELIVERY", name: "DE", country: "DE" } })).id;
    seaportId = (await prisma.point.create({ data: { queryId, type: "SEAPORT", name: "SP", country: "IN" } })).id;
    cargoId = (await prisma.cargoItem.create({ data: { queryId, rowIndex: 1, poReference: "PO", productName: "P", packageType: "Box", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 } })).id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("mints sequential legCodes L1, L2 and stores LegCargo", async () => {
    const l1 = await api()
      .post(`/api/queries/${queryId}/legs`)
      .set("Cookie", cookie())
      .send({ mode: "ROAD", originPointId: pickupId, destinationPointId: seaportId, assignedCargoIds: [cargoId] })
      .expect(201);
    expect(l1.body.legCode).toBe("L1");
    expect(l1.body.legCargo).toHaveLength(1);

    const l2 = await api()
      .post(`/api/queries/${queryId}/legs`)
      .set("Cookie", cookie())
      .send({ mode: "SEA", originPointId: seaportId, destinationPointId: seaportId })
      .expect(201);
    expect(l2.body.legCode).toBe("L2");
  });

  it("blocks an impossible mode↔endpoint at save (V-M1, 422)", async () => {
    const res = await api()
      .post(`/api/queries/${queryId}/legs`)
      .set("Cookie", cookie())
      .send({ mode: "SEA", originPointId: pickupId, destinationPointId: deliveryId })
      .expect(422);
    expect(res.body.findings[0].rule).toBe("V-M1");
  });

  it("400s an assignedCargoId from another query", async () => {
    await api()
      .post(`/api/queries/${queryId}/legs`)
      .set("Cookie", cookie())
      .send({ mode: "ROAD", assignedCargoIds: [EXEC_ID] })
      .expect(400);
  });

  it("patches cargo assignment and deletes the leg", async () => {
    const leg = await api()
      .post(`/api/queries/${queryId}/legs`)
      .set("Cookie", cookie())
      .send({ mode: "ROAD", originPointId: pickupId, destinationPointId: deliveryId })
      .expect(201);
    const legId = leg.body.id;
    const patched = await api()
      .patch(`/api/queries/${queryId}/legs/${legId}`)
      .set("Cookie", cookie())
      .send({ assignedCargoIds: [cargoId] })
      .expect(200);
    expect(patched.body.legCargo).toHaveLength(1);
    await api().delete(`/api/queries/${queryId}/legs/${legId}`).set("Cookie", cookie()).expect(204);
  });
});
