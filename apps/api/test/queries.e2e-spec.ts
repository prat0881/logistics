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

const PFX = "p4-queries-";

describe("Queries (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let clientId: string;
  // sub is a UUID: it lands in @db.Uuid columns (assignedUserId). A synthetic non-uuid
  // sub would P2023 on insert.
  const EXEC_ID = "11111111-1111-1111-1111-111111111111";
  const cookie = (role: Role, sub = EXEC_ID) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(prisma); // 9 checklist definitions (CI is unseeded)
    const client = await prisma.client.create({
      data: { clientCode: `${PFX}CL`, companyName: `${PFX}Client`, country: "IN" },
    });
    clientId = client.id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: PFX } } });
    await app.close();
  });

  it("401s an unauthenticated create", async () => {
    await request(app.getHttpServer()).post("/api/queries").send({}).expect(401);
  });

  it("mints a YALYY-NNNN code, seeds the 9 checklist items, assigns the creator, status DRAFT", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE, EXEC_ID))
      .send({ clientId, shipmentDescription: `${PFX}first`, incoterms: "FOB" })
      .expect(201);
    expect(res.body.queryCode).toMatch(/^YAL\d{2}-\d{4}$/);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.assignedUserId).toBe(EXEC_ID);
    const got = await request(app.getHttpServer())
      .get(`/api/queries/${res.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(got.body.checklist).toHaveLength(9);
    expect(got.body.checklist.every((c: { checked: boolean }) => c.checked === false)).toBe(true);
  });

  it("400s an invalid draft (bad email / bad incoterms)", async () => {
    await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ contactEmail: "nope", shipmentDescription: `${PFX}bad` })
      .expect(400);
  });

  it("400s a non-existent clientId (FK guarded, not a 500)", async () => {
    await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ clientId: "00000000-0000-0000-0000-000000000000", shipmentDescription: `${PFX}fk` })
      .expect(400);
  });

  it("400s a non-existent vesselId (FK guarded, not a 500)", async () => {
    await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({
        vesselId: "00000000-0000-0000-0000-000000000000",
        shipmentDescription: `${PFX}fk-vessel`,
      })
      .expect(400);
  });

  it("patches fields through the Free-path mediator and returns the updated query", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ clientId, shipmentDescription: `${PFX}patch` })
      .expect(201);
    const res = await request(app.getHttpServer())
      .patch(`/api/queries/${created.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ priority: "HIGH", incoterms: "CIF", internalNotes: "hello" })
      .expect(200);
    expect(res.body.priority).toBe("HIGH");
    expect(res.body.incoterms).toBe("CIF");
    expect(res.body.internalNotes).toBe("hello");
  });

  it("403s a non-Admin backdating queryDate, but lets an Admin", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ shipmentDescription: `${PFX}backdate` })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/queries/${created.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ queryDate: "2020-01-01T00:00:00.000Z" })
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/api/queries/${created.body.id}`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ queryDate: "2020-01-01T00:00:00.000Z" })
      .expect(200);
  });

  it("404s a PATCH to a missing query", async () => {
    await request(app.getHttpServer())
      .patch(`/api/queries/00000000-0000-0000-0000-000000000000`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ priority: "LOW" })
      .expect(404);
  });

  it("422s Create Query with F1/F6 findings when mandatory fields are missing", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/queries").set("Cookie", cookie(Role.EXECUTIVE))
      .send({ shipmentDescription: `${PFX}incomplete` }).expect(201);
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${created.body.id}/create`).set("Cookie", cookie(Role.EXECUTIVE))
      .expect(422);
    expect(res.body.findings.length).toBeGreaterThan(0);
    expect(res.body.findings.every((f: { severity: string }) => f.severity === "blocking")).toBe(true);
    const still = await prisma.query.findUnique({ where: { id: created.body.id } });
    expect(still!.status).toBe("DRAFT"); // unchanged on block
  });

  it("sets RFQ_READY through the projector when all mandatory fields are present", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/queries").set("Cookie", cookie(Role.EXECUTIVE))
      .send({
        clientId, shipmentDescription: `${PFX}complete`, incoterms: "FOB",
        contactName: "Jo", contactEmail: "jo@acme.test", contactPhone: "+911234567890",
        readyDate: "2026-08-01T00:00:00.000Z", targetDelivery: "2026-08-20T00:00:00.000Z",
      }).expect(201);
    // Plan 5: Create Query also gates on the full route catalogue (R1-R9/T/C), so this query
    // needs a complete Pickup->Delivery route (one cargo row on one leg) to pass — leg dates
    // match the query's readyDate/targetDelivery above (T2: first/last leg dates = query dates).
    const pu = await prisma.point.create({ data: { queryId: created.body.id, type: "PICKUP", name: "PU", streetAddress: "1", city: "Mumbai", postalCode: "400001", country: "IN", contactName: "A", contactPhone: "+911234567", contactEmail: "a@x.com", timezone: "Asia/Kolkata" } });
    const de = await prisma.point.create({ data: { queryId: created.body.id, type: "DELIVERY", name: "DE", streetAddress: "9", city: "Pune", postalCode: "411001", country: "IN", contactName: "B", contactPhone: "+915555555", timezone: "Asia/Kolkata" } });
    const cargo = await prisma.cargoItem.create({ data: { queryId: created.body.id, rowIndex: 1, poReference: "PO", productName: "P", packageType: "Box", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 } });
    const leg = await prisma.leg.create({ data: { queryId: created.body.id, legCode: "L1", mode: "ROAD", originPointId: pu.id, destinationPointId: de.id, readyDate: "2026-08-01T00:00:00.000Z", targetDelivery: "2026-08-20T00:00:00.000Z" } });
    await prisma.legCargo.create({ data: { legId: leg.id, cargoItemId: cargo.id } });

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${created.body.id}/create`).set("Cookie", cookie(Role.EXECUTIVE))
      .expect(201);
    expect(res.body.status).toBe("RFQ_READY");
    const row = await prisma.query.findUnique({ where: { id: created.body.id } });
    expect(row!.status).toBe("RFQ_READY");
    expect(row!.rfqReadyAt).not.toBeNull();
    const firedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(firedLeg!.status).toBe("READY_FOR_RFQ"); // Create Query fires every leg forward (Plan 5)
  });

  it("toggles checklist item checked state", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/queries").set("Cookie", cookie(Role.EXECUTIVE))
      .send({ clientId, shipmentDescription: `${PFX}checklist` }).expect(201);
    const res = await request(app.getHttpServer())
      .patch(`/api/queries/${created.body.id}/checklist`).set("Cookie", cookie(Role.EXECUTIVE))
      .send({ items: [{ itemKey: "weight-confirmed", checked: true }, { itemKey: "packing-list", checked: true }] })
      .expect(200);
    const checked = res.body.checklist.filter((c: { checked: boolean }) => c.checked).map((c: { itemKey: string }) => c.itemKey).sort();
    expect(checked).toEqual(["packing-list", "weight-confirmed"]);
  });

  it("400s an unknown checklist itemKey", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/queries").set("Cookie", cookie(Role.EXECUTIVE))
      .send({ shipmentDescription: `${PFX}checklist2` }).expect(201);
    await request(app.getHttpServer())
      .patch(`/api/queries/${created.body.id}/checklist`).set("Cookie", cookie(Role.EXECUTIVE))
      .send({ items: [{ itemKey: "not-a-real-item", checked: true }] })
      .expect(400);
  });
});
