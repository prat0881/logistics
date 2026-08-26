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

describe("Warehouse linking (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  async function createFf(companyName: string) {
    const res = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({
        companyName,
        companyAddress: "Plot 5, Jebel Ali",
        country: "United Arab Emirates",
        city: "Dubai",
        availableCountries: ["AE"],
        modes: ["SEA"],
        pic: "Linking Contact",
        contactNumber: "+971500000000",
        email: `${companyName.replace(/\W/g, "").toLowerCase()}@example.com`,
      })
      .expect(201);
    return res.body as { id: string };
  }

  async function createClient(companyName: string) {
    const res = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({
        companyName,
        country: "United Arab Emirates",
        streetAddress: "Plot 5, Jebel Ali",
        city: "Dubai",
      })
      .expect(201);
    return res.body as { id: string };
  }

  async function createWarehouse(name: string) {
    const res = await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({
        name,
        type: "FF",
        streetAddress: "Plot 12",
        country: "United Arab Emirates",
        city: "Dubai",
        pinCode: "00000",
        capacity: 5000,
        capacityUnit: "CBM",
      })
      .expect(201);
    return res.body as { id: string };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await prisma.warehouse.deleteMany({ where: { name: { startsWith: "Linking" } } });
    await prisma.freightForwarder.deleteMany({ where: { companyName: { startsWith: "Linking" } } });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: "Linking" } } });
  });

  afterAll(async () => {
    await prisma.warehouse.deleteMany({ where: { name: { startsWith: "Linking" } } });
    await prisma.freightForwarder.deleteMany({ where: { companyName: { startsWith: "Linking" } } });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: "Linking" } } });
    await app.close();
  });

  it("assigns and unassigns warehouses in one call", async () => {
    const ff = await createFf("Linking E2E");
    const a = await createWarehouse("Linking WH A");
    const b = await createWarehouse("Linking WH B");

    await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [a.id, b.id] }).expect(200);

    expect((await prisma.warehouse.findUnique({ where: { id: a.id } }))?.freightForwarderId).toBe(ff.id);

    await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [a.id] }).expect(200);

    expect((await prisma.warehouse.findUnique({ where: { id: b.id } }))?.freightForwarderId).toBeNull();
  });

  it("keeps whLocation in step with the assignment, for the RFQ payload", async () => {
    const ff = await createFf("Linking E2E WhLocation");
    const wh = await createWarehouse("Linking WH Named");

    await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [wh.id] }).expect(200);
    expect((await prisma.freightForwarder.findUnique({ where: { id: ff.id } }))?.whLocation)
      .toBe("Linking WH Named");

    await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [] }).expect(200);
    expect((await prisma.freightForwarder.findUnique({ where: { id: ff.id } }))?.whLocation).toBeNull();
  });

  it("refuses a warehouse already owned by another forwarder", async () => {
    const first = await createFf("Linking E2E One");
    const second = await createFf("Linking E2E Two");
    const wh = await createWarehouse("Linking WH Contested");

    await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${first.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [wh.id] }).expect(200);

    const res = await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${second.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [wh.id] }).expect(409);
    expect(res.body.message).toMatch(/already assigned/i);
  });

  it("re-assigning the same warehouse to its current forwarder is not a conflict", async () => {
    const ff = await createFf("Linking E2E Idempotent");
    const wh = await createWarehouse("Linking WH Idempotent");

    await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [wh.id] }).expect(200);

    await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [wh.id] }).expect(200);

    expect((await prisma.warehouse.findUnique({ where: { id: wh.id } }))?.freightForwarderId).toBe(ff.id);
  });

  it("refuses a warehouse already owned by a client", async () => {
    const client = await createClient("Linking E2E Client Owner");
    const ff = await createFf("Linking E2E Client Conflict FF");
    const wh = await createWarehouse("Linking WH Client Owned");

    await request(app.getHttpServer())
      .put(`/api/clients/${client.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [wh.id] }).expect(200);

    const res = await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [wh.id] }).expect(409);
    expect(res.body.message).toMatch(/already assigned/i);
  });

  it("client warehouse assignment: assigns, unassigns, and refuses a forwarder-owned warehouse", async () => {
    const client = await createClient("Linking E2E Client");
    const ff = await createFf("Linking E2E Client's FF Rival");
    const a = await createWarehouse("Linking WH Client A");
    const contested = await createWarehouse("Linking WH Client Contested");

    await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [contested.id] }).expect(200);

    await request(app.getHttpServer())
      .put(`/api/clients/${client.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [a.id] }).expect(200);
    expect((await prisma.warehouse.findUnique({ where: { id: a.id } }))?.clientId).toBe(client.id);

    const res = await request(app.getHttpServer())
      .put(`/api/clients/${client.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [a.id, contested.id] }).expect(409);
    expect(res.body.message).toMatch(/already assigned/i);
    // The failed call touched nothing: `a` is still assigned to this client.
    expect((await prisma.warehouse.findUnique({ where: { id: a.id } }))?.clientId).toBe(client.id);

    await request(app.getHttpServer())
      .put(`/api/clients/${client.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [] }).expect(200);
    expect((await prisma.warehouse.findUnique({ where: { id: a.id } }))?.clientId).toBeNull();
  });

  it("lists currently assigned warehouses for a forwarder and a client", async () => {
    const ff = await createFf("Linking E2E List FF");
    const wh = await createWarehouse("Linking WH List");
    await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [wh.id] }).expect(200);

    const res = await request(app.getHttpServer())
      .get(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .expect(200);
    expect(res.body.map((w: { id: string }) => w.id)).toEqual([wh.id]);
  });
});
