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
  let fixtureClientId: string | undefined;
  let fixtureForwarderId: string | undefined;

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
    if (fixtureClientId) await prisma.client.deleteMany({ where: { id: fixtureClientId } });
    if (fixtureForwarderId) await prisma.freightForwarder.deleteMany({ where: { id: fixtureForwarderId } });
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
    fixtureClientId = client.id;
    fixtureForwarderId = forwarder.id;
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

  describe("update invariant (row-after-write, not patch-alone)", () => {
    it("rejects clearing agreementValidUntil on an OWNED warehouse via PATCH", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/warehouses").set("Cookie", cookie(Role.ADMINISTRATOR))
        .send({
          ...base,
          name: `${NAME} owned-patch-date`,
          type: "OWNED",
          agreementValidUntil: "2030-01-01T00:00:00.000Z",
          insuranceValidUntil: "2030-01-01T00:00:00.000Z",
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .patch(`/api/warehouses/${created.body.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
        .send({ agreementValidUntil: null });
      expect(res.status).toBe(400);
    });

    it("rejects clearing rateCurrency via PATCH while a handling rate remains set", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/warehouses").set("Cookie", cookie(Role.ADMINISTRATOR))
        .send({
          ...base,
          name: `${NAME} rate-patch-currency`,
          rateCurrency: "AED",
          handlingRate: 100,
          handlingUnit: "PER_PALLET",
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .patch(`/api/warehouses/${created.body.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
        .send({ rateCurrency: null });
      expect(res.status).toBe(400);
    });

    it("still allows an unrelated PATCH on a CLIENT warehouse to succeed", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/warehouses").set("Cookie", cookie(Role.ADMINISTRATOR))
        .send({ ...base, name: `${NAME} client-unrelated-patch`, type: "CLIENT" })
        .expect(201);

      const res = await request(app.getHttpServer())
        .patch(`/api/warehouses/${created.body.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
        .send({ city: "Abu Dhabi" });
      expect(res.status).toBe(200);
      expect(res.body.city).toBe("Abu Dhabi");
    });

    // This is the actual hole the merge-based check closes: neither `warehouseUpdateSchema`
    // (no superRefine) nor a patch-only superRefine could ever catch this, because the patch
    // itself carries no dates to inspect — only the merged row (existing dates + new type) does.
    it("rejects flipping type from CLIENT to OWNED via PATCH when no agreement dates exist yet", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/warehouses").set("Cookie", cookie(Role.ADMINISTRATOR))
        .send({ ...base, name: `${NAME} type-flip`, type: "CLIENT" })
        .expect(201);
      expect(created.body.agreementValidUntil).toBeFalsy();

      const res = await request(app.getHttpServer())
        .patch(`/api/warehouses/${created.body.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
        .send({ type: "OWNED" });
      expect(res.status).toBe(400);
    });
  });
});
