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

const PREFIX = "RFQ-ELIG";
const CODE = `YAL00-${PREFIX}`;
const DG_PREFIX = "RFQ-ELIG-DG";
const DG_CODE = `YAL00-${DG_PREFIX}`;

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  const cleanup = async () => {
    // Clean the standard eligibility fixtures (CODE)
    const q = await prisma.query.findUnique({ where: { queryCode: CODE }, select: { id: true } });
    if (q) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/cargo/legCargo
    }
    // FF codes in this test are FF-ELIG-A/B/C/D (brief verbatim)
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { in: ["FF-ELIG-A", "FF-ELIG-B", "FF-ELIG-C", "FF-ELIG-D"] } },
    });

    // Clean the DG fixtures (DG_CODE)
    const dq = await prisma.query.findUnique({ where: { queryCode: DG_CODE }, select: { id: true } });
    if (dq) {
      await prisma.quote.deleteMany({ where: { queryId: dq.id } });
      await prisma.rfq.deleteMany({ where: { queryId: dq.id } });
      await prisma.query.delete({ where: { id: dq.id } }); // cascades
    }
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: `FF-${DG_PREFIX}-` } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("filters eligible FFs by country + mode; broaden drops country/mode", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    // --- fixtures (self-contained) ---
    const query = await prisma.query.create({ data: { queryCode: CODE } });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });
    const cargo = await prisma.cargoItem.create({
      data: { queryId: query.id, rowIndex: 0, poReference: "PO1", productName: "Widget",
              packageType: "BOX", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1, isDangerous: false },
    });
    const leg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L1", mode: "AIR", status: "READY_FOR_RFQ",
              originPointId: origin.id, destinationPointId: dest.id,
              readyDate: new Date(), targetDelivery: new Date(Date.now() + 86400000),
              legCargo: { create: { cargoItemId: cargo.id } } },
    });
    const mkFf = (code: string, countries: string[], modes: ("AIR"|"SEA"|"ROAD")[], status: "ACTIVE"|"INACTIVE", handleDg = false) =>
      prisma.freightForwarder.create({ data: {
        freightForwarderCode: code, companyName: `${code} Co`, pic: "P", contactNumber: "+1000000000",
        email: `${code}@e2e.test`, availableCountries: countries, modes, status, handleDg } });
    const a = await mkFf("FF-ELIG-A", ["CN", "AE"], ["AIR"], "ACTIVE");
    const b = await mkFf("FF-ELIG-B", ["CN", "AE"], ["SEA"], "ACTIVE");
    const c = await mkFf("FF-ELIG-C", ["CN"], ["AIR"], "ACTIVE");
    const d = await mkFf("FF-ELIG-D", ["CN", "AE"], ["AIR"], "INACTIVE");
    const mine = [a.id, b.id, c.id, d.id];

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/legs/${leg.id}/eligible-ffs`)
      .set("Cookie", admin).expect(200);
    const ids = res.body.map((f: { id: string }) => f.id);
    expect(ids).toContain(a.id);
    // scope to this spec's own fixtures: only A should be eligible (B=wrong mode, C=missing AE, D=INACTIVE)
    const mineReturned = ids.filter((id: string) => mine.includes(id));
    expect(mineReturned).toEqual([a.id]);

    const broad = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/legs/${leg.id}/eligible-ffs?broaden=true`)
      .set("Cookie", admin).expect(200);
    const broadIds = broad.body.map((f: { id: string }) => f.id);
    // A, B, C are all ACTIVE (D is INACTIVE — excluded)
    const mineBroad = broadIds.filter((id: string) => mine.includes(id));
    expect(mineBroad).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    expect(mineBroad).not.toContain(d.id);
  });

  it("DG cargo restricts to handleDg=true FFs even with broaden=true", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    // --- DG fixtures (separate query/leg/FFs with DG prefix) ---
    const query = await prisma.query.create({ data: { queryCode: DG_CODE } });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "SG" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "DE" } });
    const dgCargo = await prisma.cargoItem.create({
      data: { queryId: query.id, rowIndex: 0, poReference: "PO-DG", productName: "Hazmat",
              packageType: "BOX", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1, isDangerous: true },
    });
    const leg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L-DG", mode: "AIR", status: "READY_FOR_RFQ",
              originPointId: origin.id, destinationPointId: dest.id,
              readyDate: new Date(), targetDelivery: new Date(Date.now() + 86400000),
              legCargo: { create: { cargoItemId: dgCargo.id } } },
    });

    // FF-DG-Y: handleDg=true, ACTIVE → eligible even without SG/DE country match (broaden)
    const y = await prisma.freightForwarder.create({ data: {
      freightForwarderCode: "FF-RFQ-ELIG-DG-Y", companyName: "FF-RFQ-ELIG-DG-Y Co",
      pic: "P", contactNumber: "+1000000000", email: "ff-dg-y@e2e.test",
      availableCountries: ["US"], modes: ["SEA"], status: "ACTIVE", handleDg: true } });
    // FF-DG-N: handleDg=false, ACTIVE → excluded because DG
    const dgN = await prisma.freightForwarder.create({ data: {
      freightForwarderCode: "FF-RFQ-ELIG-DG-N", companyName: "FF-RFQ-ELIG-DG-N Co",
      pic: "P", contactNumber: "+1000000000", email: "ff-dg-n@e2e.test",
      availableCountries: ["SG", "DE"], modes: ["AIR"], status: "ACTIVE", handleDg: false } });

    // broaden=true but DG restriction STILL applies
    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/legs/${leg.id}/eligible-ffs?broaden=true`)
      .set("Cookie", admin).expect(200);
    const ids = res.body.map((f: { id: string }) => f.id);
    expect(ids).toContain(y.id);     // handleDg=true is included
    // handleDg=false must be excluded even with broaden
    expect(ids).not.toContain(dgN.id);
    // verify by checking no non-DG FF is returned
    const allHandleDg = res.body.every((f: { handleDg: boolean }) => f.handleDg === true);
    expect(allHandleDg).toBe(true);
  });
});
