import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { RoutingService } from "../src/modules/routing/routing.service";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
const PFX = "p5-routing-";
const EXEC_ID = "11111111-1111-1111-1111-111111111111";
const READY = "2026-09-01T00:00:00.000Z";
const TARGET = "2026-09-10T00:00:00.000Z";

describe("Routing validate (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let routing: RoutingService;
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
    routing = moduleRef.get(RoutingService);
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  // A query + Pickup->Delivery points + one ROAD leg between them. Callers add their own
  // Cargo/Package/LegPackage rows on top (grain varies per test).
  async function baseQuery() {
    const q = await prisma.query.create({
      data: {
        queryCode: `${PFX}${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        shipmentDescription: `${PFX}q`,
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
    return { queryId: q.id, legId: leg.id };
  }

  it("returns no findings for a complete valid route at create phase", async () => {
    const { queryId, legId } = await baseQuery();
    const cargo = await prisma.cargo.create({ data: { queryId, rowIndex: 0, poReference: "PO" } });
    const pkg = await prisma.package.create({
      data: {
        queryId,
        cargoId: cargo.id,
        rowIndex: 0,
        packageNo: "P-1",
        packageType: "BOX",
        dimL: 100,
        dimW: 50,
        dimH: 40,
        grossWt: 5,
      },
    });
    await prisma.legPackage.create({ data: { legId, packageId: pkg.id } });

    const res = await api()
      .post(`/api/queries/${queryId}/validate?phase=create`)
      .set("Cookie", cookie())
      .expect(200);
    expect(res.body.findings).toEqual([]);
  });

  it("draft-warns but does not create-block a query with no legs", async () => {
    const q = await prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}-empty`, shipmentDescription: `${PFX}q` },
    });
    const draft = await api()
      .post(`/api/queries/${q.id}/validate?phase=draft`)
      .set("Cookie", cookie())
      .expect(200);
    expect(draft.body.findings.length).toBeGreaterThan(0);
    expect(draft.body.findings.every((f: { severity: string }) => f.severity === "warning")).toBe(
      true,
    );
    const create = await api()
      .post(`/api/queries/${q.id}/validate?phase=create`)
      .set("Cookie", cookie())
      .expect(200);
    expect(create.body.findings.some((f: { rule: string }) => f.rule === "R5")).toBe(true);
    expect(create.body.findings.every((f: { severity: string }) => f.severity === "blocking")).toBe(
      true,
    );
  });

  it("flags a DG package with no MSDS at every leg carrying it (R9)", async () => {
    const { queryId, legId } = await baseQuery();
    const cargo = await prisma.cargo.create({
      data: { queryId, rowIndex: 0, poReference: "PO-DG" },
    });
    const pkg = await prisma.package.create({
      data: {
        queryId,
        cargoId: cargo.id,
        rowIndex: 0,
        packageNo: "P-DG",
        packageType: "BOX",
        dimL: 100,
        dimW: 50,
        dimH: 40,
        grossWt: 5,
        tags: ["DG"],
        msdsFileId: null,
      },
    });
    await prisma.legPackage.create({ data: { legId, packageId: pkg.id } });

    const res = await api()
      .post(`/api/queries/${queryId}/validate?phase=create`)
      .set("Cookie", cookie())
      .expect(200);
    expect(
      res.body.findings.some(
        (f: { rule: string; scope: { type: string; id?: string } }) =>
          f.rule === "R9" && f.scope.type === "leg" && f.scope.id === legId,
      ),
    ).toBe(true);
  });

  it("re-derives the package/cargo -> leg fan-out (restores change-order scoping)", async () => {
    const { queryId, legId } = await baseQuery();
    const cargo = await prisma.cargo.create({
      data: { queryId, rowIndex: 0, poReference: "PO-FANOUT" },
    });
    const pkg = await prisma.package.create({
      data: {
        queryId,
        cargoId: cargo.id,
        rowIndex: 0,
        packageNo: "P-FO",
        packageType: "BOX",
        dimL: 100,
        dimW: 50,
        dimH: 40,
        grossWt: 5,
      },
    });
    await prisma.legPackage.create({ data: { legId, packageId: pkg.id } });

    // ImpactClassifier's `case "package"`/`case "cargo"` fan out through exactly these two
    // methods (RoutingService) to reach ScopeResolver.downstreamWork, which only inspects
    // `type==="leg"` scope — an empty/self-scoped result here silently defeats change-order
    // gating for package/cargo Structural changes (see the T4 STOPGAP this unit removes).
    expect(await routing.legsCarryingPackage(pkg.id)).toContain(legId);
    expect(await routing.legsCarryingCargo(cargo.id)).toContain(legId);
  });
});
