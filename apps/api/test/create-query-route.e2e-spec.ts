import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE, LegStatus, QueryStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
const PFX = "p5-createq-";
const EXEC_ID = "11111111-1111-1111-1111-111111111111";
const READY = "2026-10-01T00:00:00.000Z";
const TARGET = "2026-10-10T00:00:00.000Z";

describe("Create Query route gating (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let clientId: string;
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
    await seedReferenceData(prisma);
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: PFX } } });
    const client = await prisma.client.create({ data: { clientCode: `${PFX}CL`, companyName: `${PFX}Client`, country: "IN" } });
    clientId = client.id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: PFX } } });
    await app.close();
  });

  async function validQuery() {
    const q = await prisma.query.create({
      data: {
        queryCode: `${PFX}${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        shipmentDescription: `${PFX}q`,
        contactName: "A",
        contactEmail: "a@x.com",
        contactPhone: "+911234567",
        incoterms: "FOB",
        readyDate: READY,
        targetDelivery: TARGET,
        clientId,
      },
    });
    const pu = await prisma.point.create({ data: { queryId: q.id, type: "PICKUP", name: "PU", streetAddress: "1", city: "Mumbai", postalCode: "400001", country: "IN", contactName: "A", contactPhone: "+911234567", contactEmail: "a@x.com" } });
    const de = await prisma.point.create({ data: { queryId: q.id, type: "DELIVERY", name: "DE", streetAddress: "9", city: "Pune", postalCode: "411001", country: "IN", contactName: "B", contactPhone: "+915555555" } });
    const cargo = await prisma.cargoItem.create({ data: { queryId: q.id, rowIndex: 1, poReference: "PO", productName: "P", packageType: "Box", qty: 3, dimL: 100, dimW: 100, dimH: 100, grossWt: 50 } });
    const leg = await prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "ROAD", originPointId: pu.id, destinationPointId: de.id, readyDate: READY, targetDelivery: TARGET } });
    await prisma.legCargo.create({ data: { legId: leg.id, cargoItemId: cargo.id } });
    return { queryId: q.id, legId: leg.id };
  }

  it("gates on the full catalogue then rolls up to RFQ_READY, firing each leg", async () => {
    const { queryId, legId } = await validQuery();
    const res = await api().post(`/api/queries/${queryId}/create`).set("Cookie", cookie()).expect(201);
    expect(res.body.status).toBe(QueryStatus.RFQ_READY);
    const leg = await prisma.leg.findUnique({ where: { id: legId } });
    expect(leg?.status).toBe(LegStatus.READY_FOR_RFQ);
  });

  it("hard-blocks with 422 findings when the route is broken (no delivery)", async () => {
    const { queryId } = await validQuery();
    // Break it: delete the delivery point so R5/R2 fail.
    await prisma.point.deleteMany({ where: { queryId, type: "DELIVERY" } });
    const res = await api().post(`/api/queries/${queryId}/create`).set("Cookie", cookie()).expect(422);
    expect(res.body.findings.some((f: { rule: string }) => f.rule === "R5" || f.rule === "R2")).toBe(true);
    const q = await prisma.query.findUnique({ where: { id: queryId }, select: { status: true } });
    expect(q?.status).toBe(QueryStatus.DRAFT);
  });

  it("returns derived freightMode/origin/destination + leg roll-ups on GET", async () => {
    const { queryId } = await validQuery();
    const res = await api().get(`/api/queries/${queryId}`).set("Cookie", cookie()).expect(200);
    expect(res.body.freightMode).toEqual(["ROAD"]);
    expect(res.body.origin[0].city).toBe("Mumbai");
    expect(res.body.destination[0].city).toBe("Pune");
    expect(res.body.legs[0].rollup.totalPackages).toBe(3);
    expect(res.body.legs[0].rollup.totalCbm).toBeCloseTo(3); // (1×1×1 m³)×3
    expect(res.body.legs[0].assignedCargoIds).toHaveLength(1);
  });
});
