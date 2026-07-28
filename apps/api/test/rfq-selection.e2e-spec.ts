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

const PREFIX = "RFQ-SEL";
const CODE = `YAL00-${PREFIX}`;

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  const mkFf = (
    code: string,
    countries: string[] = ["AE"],
    modes: ("AIR" | "SEA" | "ROAD")[] = ["AIR"],
    status: "ACTIVE" | "INACTIVE" = "ACTIVE",
    handleDg = false,
  ) =>
    prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `${code}@e2e.test`,
        availableCountries: countries,
        modes,
        status,
        handleDg,
      },
    });

  const mkActiveFf = (code: string) => mkFf(`FF-${PREFIX}-${code}`, ["AE"], ["AIR"], "ACTIVE");

  const cleanup = async () => {
    const q = await prisma.query.findUnique({ where: { queryCode: CODE }, select: { id: true } });
    if (q) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/cargo/legCargo
    }
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } } });
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

  it("reconciles SELECT quotes and validates FFs", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const query = await prisma.query.create({ data: { queryCode: CODE } });
    const leg = await prisma.leg.create({ data: { queryId: query.id, legCode: "L1", status: "READY_FOR_RFQ" } });
    const ffA = await mkActiveFf("FF-SEL-A");
    const ffB = await mkActiveFf("FF-SEL-B");

    // (a) select two FFs → two SELECT quotes
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ffA.id, ffB.id] })
      .expect(200);
    expect(await prisma.quote.count({ where: { legId: leg.id, status: "SELECT" } })).toBe(2);

    // (b) re-PUT with one id → drops the other SELECT quote
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ffA.id] })
      .expect(200);
    const rows = await prisma.quote.findMany({ where: { legId: leg.id }, select: { freightForwarderId: true } });
    expect(rows.map((r) => r.freightForwarderId)).toEqual([ffA.id]);

    // (c) unknown uuid → 400
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: ["00000000-0000-0000-0000-000000000000"] })
      .expect(400);

    // (d) INACTIVE FF id → 400 (service filters status: "ACTIVE")
    const inactiveFf = await mkFf(`FF-${PREFIX}-INACT`, ["AE"], ["AIR"], "INACTIVE");
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [inactiveFf.id] })
      .expect(400);
  });

  it("preserves RFQ_SENT quotes across selection changes", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    // Re-use the same query/leg (already cleaned after previous test, but query still exists)
    // Find the existing query and leg
    const query = await prisma.query.findUnique({ where: { queryCode: CODE }, select: { id: true } });
    expect(query).not.toBeNull();
    const legs = await prisma.leg.findMany({ where: { queryId: query!.id }, select: { id: true } });
    expect(legs.length).toBeGreaterThan(0);
    const legId = legs[0].id;

    // Make sure ffA still exists from previous test cleanup logic (or use new ones)
    const ffC = await mkActiveFf("FF-SEL-C");
    const ffD = await mkActiveFf("FF-SEL-D");

    // Seed a RFQ_SENT quote directly (simulating a pre-distributed state)
    const sentQuote = await prisma.quote.create({
      data: {
        queryId: query!.id,
        legId,
        freightForwarderId: ffC.id,
        status: "RFQ_SENT",
        tenantId: null,
      },
    });

    // (d) selection change does NOT delete the RFQ_SENT quote
    await request(app.getHttpServer())
      .put(`/api/queries/${query!.id}/legs/${legId}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ffD.id] })
      .expect(200);

    // The RFQ_SENT quote for ffC must still be there
    const sentStillExists = await prisma.quote.findUnique({ where: { id: sentQuote.id } });
    expect(sentStillExists).not.toBeNull();
    expect(sentStillExists!.status).toBe("RFQ_SENT");

    // The new SELECT quote for ffD should also be there
    const selectCount = await prisma.quote.count({ where: { legId, status: "SELECT" } });
    expect(selectCount).toBe(1);
  });
});
