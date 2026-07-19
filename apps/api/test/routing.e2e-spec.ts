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
const PFX = "p5-routing-";
const EXEC_ID = "11111111-1111-1111-1111-111111111111";
const READY = "2026-09-01T00:00:00.000Z";
const TARGET = "2026-09-10T00:00:00.000Z";

describe("Routing validate (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
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
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  // Build a complete, valid single-leg road route Pickup->Delivery for one cargo row.
  async function validQuery() {
    const q = await prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}-${Math.floor(Math.random() * 1e6)}`, shipmentDescription: `${PFX}q`, readyDate: READY, targetDelivery: TARGET },
    });
    const pu = await prisma.point.create({ data: { queryId: q.id, type: "PICKUP", name: "PU", streetAddress: "1", city: "Mumbai", postalCode: "400001", country: "IN", contactName: "A", contactPhone: "+911234567", contactEmail: "a@x.com" } });
    const de = await prisma.point.create({ data: { queryId: q.id, type: "DELIVERY", name: "DE", streetAddress: "9", city: "Pune", postalCode: "411001", country: "IN", contactName: "B", contactPhone: "+915555555" } });
    const cargo = await prisma.cargoItem.create({ data: { queryId: q.id, rowIndex: 1, poReference: "PO", productName: "P", packageType: "Box", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 } });
    const leg = await prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "ROAD", originPointId: pu.id, destinationPointId: de.id, readyDate: READY, targetDelivery: TARGET } });
    await prisma.legCargo.create({ data: { legId: leg.id, cargoItemId: cargo.id } });
    return q.id;
  }

  it("returns no findings for a complete valid route at create phase", async () => {
    const id = await validQuery();
    const res = await api().post(`/api/queries/${id}/validate?phase=create`).set("Cookie", cookie()).expect(200);
    expect(res.body.findings).toEqual([]);
  });

  it("draft-warns but does not create-block a query with no legs", async () => {
    const q = await prisma.query.create({ data: { queryCode: `${PFX}${Date.now()}-empty`, shipmentDescription: `${PFX}q` } });
    const draft = await api().post(`/api/queries/${q.id}/validate?phase=draft`).set("Cookie", cookie()).expect(200);
    expect(draft.body.findings.length).toBeGreaterThan(0);
    expect(draft.body.findings.every((f: { severity: string }) => f.severity === "warning")).toBe(true);
    const create = await api().post(`/api/queries/${q.id}/validate?phase=create`).set("Cookie", cookie()).expect(200);
    expect(create.body.findings.some((f: { rule: string }) => f.rule === "R5")).toBe(true);
    expect(create.body.findings.every((f: { severity: string }) => f.severity === "blocking")).toBe(true);
  });
});
