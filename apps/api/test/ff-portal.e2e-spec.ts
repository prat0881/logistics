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

const PREFIX = "FF-PORTAL";
const CODE = `YAL00-${PREFIX}`;

describe("GET /ff/rfq/:token (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    for (const q of qs) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/cargo/legCargo
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } },
    });
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
    await seedReferenceData(prisma);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  /**
   * Build a minimal distribute fixture and return the raw accessToken + the leg id.
   * Creates Query → origin/destination Points → CargoItem → Leg(AIR, READY_FOR_RFQ)
   * → FreightForwarder → PUT ff-selection → POST distribute.
   * The distribute response carries rfqs[0].accessToken.
   */
  async function distributeFixture(): Promise<{ token: string; legId: string }> {
    const admin = cookie(Role.ADMINISTRATOR);

    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-FIXTURE`, incoterms: "FOB" },
    });

    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });

    const cargo = await prisma.cargoItem.create({
      data: {
        queryId: query.id,
        rowIndex: 0,
        poReference: `PO-${PREFIX}-1`,
        productName: "Widget",
        packageType: "BOX",
        qty: 2,
        dimL: 10,
        dimW: 20,
        dimH: 30,
        grossWt: 5,
        isDangerous: false,
      },
    });

    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `L-${PREFIX}-1`,
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legCargo: { create: { cargoItemId: cargo.id } },
      },
    });

    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-A`,
        companyName: `FF ${PREFIX} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PREFIX.toLowerCase()}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["AIR"],
        handleDg: false,
        defaultCurrency: "USD",
      },
    });

    // Select FF to mint the SELECT quote
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    // Distribute → mints the RFQ + returns accessToken
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    const entry = res.body.rfqs[0];
    expect(entry.accessToken).toBeDefined();
    return { token: entry.accessToken as string, legId: leg.id };
  }

  it("GET resolves the scoped RFQ with seeded presets + density (no auth cookie)", async () => {
    const { token, legId } = await distributeFixture();

    const res = await request(app.getHttpServer())
      .get(`/api/ff/rfq/${token}`)
      .expect(200); // NO cookie

    expect(res.body.rfqNumber).toMatch(/-RFQ/);
    expect(res.body.currency).toBe("USD"); // Rfq.currency ?? FF.defaultCurrency
    expect(res.body.legs).toHaveLength(1);

    const leg = res.body.legs[0];
    expect(leg.legId).toBe(legId);
    expect(leg.manifest.cargo.length).toBeGreaterThan(0); // from the frozen snapshot
    expect(leg.seededCharges.map((c: { presetKey: string }) => c.presetKey)).toContain(
      "AIR_MAIN_FREIGHT",
    ); // Air presets
    const air = (await prisma.freightDensityFactor.findUnique({ where: { mode: "AIR" } }))!.kgPerCbm;
    expect(leg.seededDensity).toHaveLength(1);
    expect(leg.seededDensity[0].freightDensity).toBe(Number(air)); // Air density (seeded from FreightDensityFactor)
    expect(leg.draft).toBeNull();
  });

  it("rejects a bad token with 401", async () => {
    await request(app.getHttpServer()).get("/api/ff/rfq/deadbeef").expect(401);
  });
});
