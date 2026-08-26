process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { ffFixture } from "./helpers/freight-forwarder";

const NAME = "Warehouse E2E";

const base = {
  name: NAME,
  type: "CLIENT",
  streetAddress: "Plot 12",
  country: "United Arab Emirates",
  city: "Dubai",
  pinCode: "00000",
  capacity: 5000,
  capacityUnit: "CBM",
};

describe("Warehouses (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await prisma.warehouse.deleteMany({ where: { name: { startsWith: NAME } } });
  });

  afterAll(async () => {
    await prisma.warehouse.deleteMany({ where: { name: { startsWith: NAME } } });
    await app.close();
  });

  it("creates a warehouse and derives totalVehicles from the child table", async () => {
    const wh = await request(app.getHttpServer())
      .post("/api/warehouses").set("Cookie", cookie(Role.ADMINISTRATOR)).send(base).expect(201);

    await request(app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/vehicles`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ tonnage: "T_5", quantity: 3 }).expect(201);
    await request(app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/vehicles`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ tonnage: "T_12", quantity: 2 }).expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/warehouses/${wh.body.id}`).set("Cookie", cookie(Role.EXECUTIVE)).expect(200);
    expect(res.body.totalVehicles).toBe(5);
  });

  it("rejects an owned warehouse with no agreement date", async () => {
    await request(app.getHttpServer())
      .post("/api/warehouses").set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, name: `${NAME} owned`, type: "OWNED" }).expect(400);
  });

  it("refuses writes from an executive", async () => {
    await request(app.getHttpServer())
      .post("/api/warehouses").set("Cookie", cookie(Role.EXECUTIVE))
      .send({ ...base, name: `${NAME} rbac` }).expect(403);
  });

  it("lists only unassigned warehouses when asked", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/warehouses?unassigned=true").set("Cookie", cookie(Role.ADMINISTRATOR)).expect(200);
    expect(res.body.items.every((w: { freightForwarderId: null; clientId: null }) =>
      w.freightForwarderId === null && w.clientId === null)).toBe(true);
  });

  it("409s a duplicate warehouse name", async () => {
    const conflict = await request(app.getHttpServer())
      .post("/api/warehouses").set("Cookie", cookie(Role.ADMINISTRATOR))
      .send(base).expect(409);
    expect(conflict.body.message).toBe("A warehouse with that name already exists");
  });

  it("adds a contact, and refuses a second primary with a 409 whose message names the reason", async () => {
    const wh = await prisma.warehouse.findFirst({ where: { name: NAME } });
    const id = wh!.id;
    await request(app.getHttpServer())
      .post(`/api/warehouses/${id}/contacts`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: "First", email: "first@example.com", contactNo: "+10000000001", pocLevel: "PRIMARY" })
      .expect(201);
    const conflict = await request(app.getHttpServer())
      .post(`/api/warehouses/${id}/contacts`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: "Second", email: "second@example.com", contactNo: "+10000000002", pocLevel: "PRIMARY" })
      .expect(409);
    expect(conflict.body.message).toBe("This warehouse already has a primary contact");
    const primaries = await prisma.warehouseContact.findMany({ where: { warehouseId: id, pocLevel: "PRIMARY" } });
    expect(primaries).toHaveLength(1);
    expect(primaries[0].name).toBe("First");
  });

  it("excludes warehouses claimed by a client or by a forwarder from ?unassigned=true", async () => {
    const suffix = randomUUID();
    const client = await prisma.client.create({
      data: {
        clientCode: `CL-FIXTURE-${suffix}`,
        companyName: `Fixture Client ${suffix}`,
        country: "Fixture Country",
        streetAddress: "1 Fixture Way",
        city: "Fixture City",
      },
    });
    const forwarder = await prisma.freightForwarder.create({ data: ffFixture() });
    const clientOwned = await request(app.getHttpServer())
      .post("/api/warehouses").set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, name: `${NAME} client-owned` }).expect(201);
    const ffOwned = await request(app.getHttpServer())
      .post("/api/warehouses").set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, name: `${NAME} ff-owned`, type: "FF" }).expect(201);
    await prisma.warehouse.update({ where: { id: clientOwned.body.id }, data: { clientId: client.id } });
    await prisma.warehouse.update({ where: { id: ffOwned.body.id }, data: { freightForwarderId: forwarder.id } });

    const res = await request(app.getHttpServer())
      .get("/api/warehouses?unassigned=true").set("Cookie", cookie(Role.ADMINISTRATOR)).expect(200);
    const ids = res.body.items.map((w: { id: string }) => w.id);
    expect(ids).not.toContain(clientOwned.body.id);
    expect(ids).not.toContain(ffOwned.body.id);
  });
});
