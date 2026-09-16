process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { ConflictException, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { clientCreateBody } from "./helpers/client";
import { warehouseCreateBody } from "./helpers/warehouse";
import { mapOwnershipRace } from "../src/common/ownership-race";

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
      .send(
        clientCreateBody({
          companyName,
          country: "United Arab Emirates",
          streetAddress: "Plot 5, Jebel Ali",
          city: "Dubai",
        }),
      )
      .expect(201);
    return res.body as { id: string };
  }

  async function createWarehouse(name: string) {
    const res = await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send(
        warehouseCreateBody({
          name,
          type: "FF",
          streetAddress: "Plot 12",
          country: "United Arab Emirates",
          city: "Dubai",
          pinCode: "00000",
          capacity: 5000,
          capacityUnit: "CBM",
        }),
      )
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

  it("PATCHing a forwarder cannot clobber whLocation with a stale value (stripped server-side, same as pic/contactNumber/email)", async () => {
    // Reproduces the exact regression: setWarehouses is whLocation's sole writer after create,
    // same relationship syncPrimaryContactColumns has to pic/contactNumber/email. Without
    // stripping it, a form whose cached record predates a picker save (e.g. it fetched before
    // the picker's own invalidation landed) would PATCH whLocation: "" on an unrelated field
    // edit and silently blank out what the picker had just correctly set — which rfq.service.ts
    // then snapshots into every subsequent RFQ payload sent to the forwarder.
    const ff = await createFf("Linking E2E WhLocation Patch Guard");
    const wh = await createWarehouse("Linking WH Patch Guard");

    await request(app.getHttpServer())
      .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ warehouseIds: [wh.id] }).expect(200);
    expect((await prisma.freightForwarder.findUnique({ where: { id: ff.id } }))?.whLocation)
      .toBe("Linking WH Patch Guard");

    await request(app.getHttpServer())
      .patch(`/api/freight-forwarders/${ff.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ whLocation: "", typicalLeadTime: 3 }).expect(200);

    const after = await prisma.freightForwarder.findUnique({ where: { id: ff.id } });
    expect(after?.whLocation).toBe("Linking WH Patch Guard");
    // The rest of the PATCH still landed — only whLocation is stripped, not the whole request.
    expect(after?.typicalLeadTime).toBe(3);
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
    // Pins the actual warehouse's name into the message — a generic "already assigned to
    // another record" with no name would pass the regex above too.
    expect(res.body.message).toContain("Linking WH Contested");
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
    expect(res.body.message).toContain("Linking WH Client Owned");
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
    expect(res.body.message).toContain("Linking WH Client Contested");
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

  it("the database itself refuses a warehouse owned by both a forwarder and a client, even bypassing the application-level check", async () => {
    // The app-level contested check in setWarehouses is not the actual guarantee — this proves
    // the `Warehouse_single_owner` CHECK constraint (migration
    // 20260826100000_warehouse_single_owner_check) is what makes "never both" real, by writing
    // straight through Prisma and around the service entirely.
    const ff = await createFf("Linking E2E DB Constraint FF");
    const client = await createClient("Linking E2E DB Constraint Client");
    const wh = await createWarehouse("Linking WH DB Constraint");

    await prisma.warehouse.update({ where: { id: wh.id }, data: { freightForwarderId: ff.id } });
    await expect(
      prisma.warehouse.update({ where: { id: wh.id }, data: { clientId: client.id } }),
    ).rejects.toThrow(/Warehouse_single_owner/);

    // The rejected write left the row exactly as it was — owned by the forwarder only.
    const after = await prisma.warehouse.findUnique({ where: { id: wh.id } });
    expect(after?.freightForwarderId).toBe(ff.id);
    expect(after?.clientId).toBeNull();
  });

  it("mapOwnershipRace maps a genuine CHECK-constraint violation to a clean 409, not a raw 500", async () => {
    // HTTP-level concurrency (the next test) cannot reliably force the exact interleaving that
    // makes the CHECK constraint itself the thing that rejects the write, rather than the
    // ordinary in-transaction contested check catching it first — timing-dependent, observed to
    // go either way locally. This test instead captures a REAL PrismaClientUnknownRequestError
    // by reproducing the DB-level violation directly (same technique as the previous test), then
    // feeds that actual error into mapOwnershipRace — proving the mapping function itself does
    // the right thing with the exact error shape Postgres really produces, deterministically.
    const ff = await createFf("Linking E2E Mapping FF");
    const client = await createClient("Linking E2E Mapping Client");
    const wh = await createWarehouse("Linking WH Mapping");
    await prisma.warehouse.update({ where: { id: wh.id }, data: { freightForwarderId: ff.id } });

    let caught: unknown;
    try {
      await prisma.warehouse.update({ where: { id: wh.id }, data: { clientId: client.id } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();

    const mapped = mapOwnershipRace(caught);
    expect(mapped).toBeInstanceOf(ConflictException);
    expect((mapped as ConflictException).message).toMatch(/assigned to another record/i);

    // Sanity check on the negative case: an unrelated error must pass through unchanged, so a
    // real bug elsewhere in setWarehouses doesn't get relabelled as an ownership conflict.
    const unrelated = new Error("some other failure");
    expect(mapOwnershipRace(unrelated)).toBe(unrelated);
  });

  it("a genuine concurrent race between a forwarder PUT and a client PUT on the same free warehouse never leaves it owned by both, and never surfaces as a raw 500", async () => {
    const ff = await createFf("Linking E2E Race FF");
    const client = await createClient("Linking E2E Race Client");
    const wh = await createWarehouse("Linking WH Race");

    // Fired together (no await between them) so both requests are genuinely in flight at once —
    // this is what the application-level contested check alone cannot defend against under Read
    // Committed: both can read the other owner column as still null before either commits.
    const [ffRes, clientRes] = await Promise.all([
      request(app.getHttpServer())
        .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
        .send({ warehouseIds: [wh.id] }),
      request(app.getHttpServer())
        .put(`/api/clients/${client.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
        .send({ warehouseIds: [wh.id] }),
    ]);

    // Exactly one side wins outright (200); the other is refused as a conflict (409) rather than
    // corrupting the row or surfacing as an unhandled 500. Which of the two 409 sources actually
    // fires — the ordinary in-transaction contested check, or the DB CHECK constraint mapped by
    // mapOwnershipRace — depends on how tightly the two requests interleave at the DB, which
    // this test does not control; the CHECK-constraint path specifically is exercised
    // deterministically by the next test instead.
    const statuses = [ffRes.status, clientRes.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const after = await prisma.warehouse.findUnique({ where: { id: wh.id } });
    const ownedByBoth = after?.freightForwarderId != null && after?.clientId != null;
    const ownedByNeither = after?.freightForwarderId == null && after?.clientId == null;
    expect(ownedByBoth).toBe(false);
    expect(ownedByNeither).toBe(false);
  });
});
