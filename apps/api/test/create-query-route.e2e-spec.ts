import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE, LegStatus, QueryStatus, type WeightUnit } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

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
  const cookie = () =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: EXEC_ID, role: Role.EXECUTIVE, tenantId: null })}`;
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

  // A v1 flat CargoItem row with qty:3 represented "3 units of a 1x1x1m box" via a single row's
  // qty multiplier (volumeCbm = dimL*dimW*dimH*qty/1e6). A v2 Package has no qty — a Package IS
  // one physical unit — so the equivalent fixture is 3 separate 100x100x100cm Packages under one
  // Cargo grouping, all assigned to the leg. This reproduces the same totalPackages=3/totalCbm≈3
  // roll-up test-4 asserts on below.
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
    const pu = await prisma.point.create({
      data: {
        queryId: q.id,
        type: "PICKUP",
        name: "PU",
        streetAddress: "1",
        city: "Mumbai",
        postalCode: "400001",
        country: "IN",
        contactName: "A",
        contactPhone: "+911234567",
        contactEmail: "a@x.com",
        timezone: "Asia/Kolkata",
      },
    });
    const de = await prisma.point.create({
      data: {
        queryId: q.id,
        type: "DELIVERY",
        name: "DE",
        streetAddress: "9",
        city: "Pune",
        postalCode: "411001",
        country: "IN",
        contactName: "B",
        contactPhone: "+915555555",
        timezone: "Asia/Kolkata",
      },
    });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: q.id,
      packages: [
        { packageNo: "PO-1", dimL: 100, dimW: 100, dimH: 100, grossWt: 50 },
        { packageNo: "PO-2", dimL: 100, dimW: 100, dimH: 100, grossWt: 50 },
        { packageNo: "PO-3", dimL: 100, dimW: 100, dimH: 100, grossWt: 50 },
      ],
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: q.id,
        legCode: "L1",
        mode: "ROAD",
        originPointId: pu.id,
        destinationPointId: de.id,
        readyDate: READY,
        targetDelivery: TARGET,
      },
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);
    return { queryId: q.id, legId: leg.id };
  }

  it("gates on the full catalogue then rolls up to RFQ_READY, firing each leg", async () => {
    const { queryId, legId } = await validQuery();
    const res = await api()
      .post(`/api/queries/${queryId}/create`)
      .set("Cookie", cookie())
      .expect(201);
    expect(res.body.status).toBe(QueryStatus.RFQ_READY);
    const leg = await prisma.leg.findUnique({ where: { id: legId } });
    expect(leg?.status).toBe(LegStatus.READY_FOR_RFQ);
  });

  it("is idempotent: a second /create on an already-RFQ_READY query returns 201 RFQ_READY, not 500", async () => {
    const { queryId, legId } = await validQuery();
    const first = await api()
      .post(`/api/queries/${queryId}/create`)
      .set("Cookie", cookie())
      .expect(201);
    expect(first.body.status).toBe(QueryStatus.RFQ_READY);

    // Re-submit (double-click / retry / refresh-reclick): every leg is already READY_FOR_RFQ,
    // so this must fire nothing and just re-project RFQ_READY — not 500 on IllegalTransitionError.
    const second = await api()
      .post(`/api/queries/${queryId}/create`)
      .set("Cookie", cookie())
      .expect(201);
    expect(second.body.status).toBe(QueryStatus.RFQ_READY);

    const leg = await prisma.leg.findUnique({ where: { id: legId } });
    expect(leg?.status).toBe(LegStatus.READY_FOR_RFQ);
  });

  it("hard-blocks with 422 findings when the route is broken (no delivery)", async () => {
    const { queryId } = await validQuery();
    // Break it: delete the delivery point → the leg into it is left with a null endpoint
    // (SetNull FK), so the route no longer completes and Create still hard-blocks (422).
    await prisma.point.deleteMany({ where: { queryId, type: "DELIVERY" } });
    const res = await api()
      .post(`/api/queries/${queryId}/create`)
      .set("Cookie", cookie())
      .expect(422);
    expect(res.body.findings.length).toBeGreaterThan(0);
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
    expect(res.body.legs[0].rollup.totalCbm).toBeCloseTo(3); // 3 packages × (1×1×1 m³)
    expect(res.body.legs[0].assignedPackageIds).toHaveLength(3);
  });

  // Build a leg carrying two packages from two DIFFERENT cargo groupings (each with its own
  // entry weightUnit), so the packages' grossWt values are converted to canonical kg by the
  // real PackageService.create (via the owning Cargo's weightUnit) before the leg roll-up sums
  // them — same "mixed entry units still sum correctly" intent as the old flat-cargo version,
  // proven through the real HTTP layer rather than helpers/cargo.ts (which writes already-
  // canonical values and so can't exercise the conversion itself — see helpers/cargo.ts's own
  // header comment).
  async function legWithTwoCargo(
    c1: { grossWt: number; weightUnit: WeightUnit },
    c2: { grossWt: number; weightUnit: WeightUnit },
  ) {
    const q = await prisma.query.create({
      data: {
        queryCode: `${PFX}${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        shipmentDescription: `${PFX}wt-rollup`,
        readyDate: READY,
        targetDelivery: TARGET,
      },
    });
    const pu = await prisma.point.create({
      data: {
        queryId: q.id,
        type: "PICKUP",
        name: "PU",
        streetAddress: "1",
        city: "Mumbai",
        postalCode: "400001",
        country: "IN",
        contactName: "A",
        contactPhone: "+911234567",
        timezone: "Asia/Kolkata",
      },
    });
    const de = await prisma.point.create({
      data: {
        queryId: q.id,
        type: "DELIVERY",
        name: "DE",
        streetAddress: "9",
        city: "Pune",
        postalCode: "411001",
        country: "IN",
        contactName: "B",
        contactPhone: "+915555555",
        timezone: "Asia/Kolkata",
      },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: q.id,
        legCode: "L1",
        mode: "ROAD",
        originPointId: pu.id,
        destinationPointId: de.id,
        readyDate: READY,
        targetDelivery: TARGET,
      },
    });

    const cargo1 = await api()
      .post(`/api/queries/${q.id}/cargo`)
      .set("Cookie", cookie())
      .send({ poReference: "PO1", weightUnit: c1.weightUnit })
      .expect(201);
    const pkg1 = await api()
      .post(`/api/queries/${q.id}/cargo/${cargo1.body.id}/packages`)
      .set("Cookie", cookie())
      .send({
        packageNo: "PO1-P1",
        packageType: "BOX",
        dimL: 1,
        dimW: 1,
        dimH: 1,
        grossWt: c1.grossWt,
      })
      .expect(201);

    const cargo2 = await api()
      .post(`/api/queries/${q.id}/cargo`)
      .set("Cookie", cookie())
      .send({ poReference: "PO2", weightUnit: c2.weightUnit })
      .expect(201);
    const pkg2 = await api()
      .post(`/api/queries/${q.id}/cargo/${cargo2.body.id}/packages`)
      .set("Cookie", cookie())
      .send({
        packageNo: "PO2-P1",
        packageType: "BOX",
        dimL: 1,
        dimW: 1,
        dimH: 1,
        grossWt: c2.grossWt,
      })
      .expect(201);

    await assignPackagesToLeg(prisma, leg.id, [pkg1.body.id, pkg2.body.id]);
    return { queryId: q.id, legId: leg.id };
  }

  it("leg totalGrossWt sums in kg across mixed weight units", async () => {
    // Build a leg carrying a 5 kg row and a 5000 gm row → total 10 kg.
    const { queryId, legId } = await legWithTwoCargo(
      { grossWt: 5, weightUnit: "KG" },
      { grossWt: 5000, weightUnit: "GM" },
    );
    const res = await api().get(`/api/queries/${queryId}`).set("Cookie", cookie()).expect(200);
    const leg = res.body.legs.find((l: { id: string }) => l.id === legId);
    expect(leg.rollup.totalGrossWt).toBeCloseTo(10, 3);
  });
});
