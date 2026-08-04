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

    // Country-vocabulary fixtures (name-vs-code fix)
    await prisma.query.deleteMany({ where: { queryCode: { startsWith: `YAL00-RFQ-ELIG-CTY` } } });
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: `FF-ELIG-CTY-` } } });
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

  it("matches FFs by ISO code when the point country is a free-text NAME ('United Kingdom' → GB)", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const query = await prisma.query.create({ data: { queryCode: `YAL00-RFQ-ELIG-CTY1` } });
    // Endpoint countries entered as NAMES via the point editor's free-text field.
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "United Kingdom" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "Germany" } });
    const cargo = await prisma.cargoItem.create({
      data: { queryId: query.id, rowIndex: 0, poReference: "PO", productName: "W",
              packageType: "BOX", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1, isDangerous: false },
    });
    const leg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L1", mode: "AIR", status: "READY_FOR_RFQ",
              originPointId: origin.id, destinationPointId: dest.id,
              readyDate: new Date(), targetDelivery: new Date(Date.now() + 86400000),
              legCargo: { create: { cargoItemId: cargo.id } } },
    });
    const mk = (code: string, countries: string[]) =>
      prisma.freightForwarder.create({ data: {
        freightForwarderCode: code, companyName: `${code} Co`, pic: "P", contactNumber: "+1000000000",
        email: `${code}@e2e.test`, availableCountries: countries, modes: ["AIR"], status: "ACTIVE", handleDg: false } });
    const match = await mk("FF-ELIG-CTY-MATCH", ["GB", "DE"]);   // covers both endpoints
    const partial = await mk("FF-ELIG-CTY-PARTIAL", ["GB"]);     // missing DE
    const other = await mk("FF-ELIG-CTY-OTHER", ["US", "FR"]);   // serves neither

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/legs/${leg.id}/eligible-ffs`)
      .set("Cookie", admin).expect(200);
    const ids = res.body.map((f: { id: string }) => f.id);
    expect(ids).toContain(match.id);       // name→code resolution lets a GB+DE forwarder match a UK→Germany leg
    expect(ids).not.toContain(partial.id); // covers only GB, not DE
    expect(ids).not.toContain(other.id);   // serves neither endpoint
  });

  it("shows NO ffs when an endpoint has no country — both endpoints must resolve (broaden still shows all)", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const query = await prisma.query.create({ data: { queryCode: `YAL00-RFQ-ELIG-CTY2` } });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "GB" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY" } }); // no country
    const cargo = await prisma.cargoItem.create({
      data: { queryId: query.id, rowIndex: 0, poReference: "PO", productName: "W",
              packageType: "BOX", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1, isDangerous: false },
    });
    const leg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L1", mode: "AIR", status: "READY_FOR_RFQ",
              originPointId: origin.id, destinationPointId: dest.id,
              readyDate: new Date(), targetDelivery: new Date(Date.now() + 86400000),
              legCargo: { create: { cargoItemId: cargo.id } } },
    });
    const gb = await prisma.freightForwarder.create({ data: {
      freightForwarderCode: "FF-ELIG-CTY-GB", companyName: "FF-ELIG-CTY-GB Co", pic: "P", contactNumber: "+1000000000",
      email: "ff-elig-cty-gb@e2e.test", availableCountries: ["GB"], modes: ["AIR"], status: "ACTIVE", handleDg: false } });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/legs/${leg.id}/eligible-ffs`)
      .set("Cookie", admin).expect(200);
    expect(res.body.map((f: { id: string }) => f.id)).not.toContain(gb.id); // incomplete endpoints → show none

    const broad = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/legs/${leg.id}/eligible-ffs?broaden=true`)
      .set("Cookie", admin).expect(200);
    expect(broad.body.map((f: { id: string }) => f.id)).toContain(gb.id); // broaden still shows all active
  });
});
