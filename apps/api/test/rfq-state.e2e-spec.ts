process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { createHash } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

const CODE = "E2E-RFQSTATE-Q1";
const FF_CODES = ["FF-STATE-A", "FF-STATE-B"];

describe("GET /queries/:id/rfq-state (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

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
    await app.close(); // ⚠ mandatory — prevents the cron hang
  });

  async function cleanup() {
    await prisma.quote.deleteMany({ where: { query: { queryCode: CODE } } }).catch(() => {});
    await prisma.rfq.deleteMany({ where: { query: { queryCode: CODE } } }).catch(() => {});
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { in: FF_CODES } } }).catch(() => {});
    await prisma.leg.deleteMany({ where: { query: { queryCode: CODE } } }).catch(() => {});
    await prisma.query.deleteMany({ where: { queryCode: CODE } }).catch(() => {});
  }

  const mkFf = (code: string) =>
    prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+10000000000",
        email: `${code}@e2e.test`,
        availableCountries: ["AE"],
        modes: ["AIR"],
        handleDg: false,
        paymentTerms: "NET 30",
        typicalLeadTime: "2d",
      },
    });

  it("returns quotes, rfqs, and the referenced FFs", async () => {
    const query = await prisma.query.create({ data: { queryCode: CODE } });
    const leg = await prisma.leg.create({ data: { queryId: query.id, legCode: "L1", status: "RFQ_SENT" } });
    const ffA = await mkFf("FF-STATE-A");
    const ffB = await mkFf("FF-STATE-B");
    await prisma.quote.create({ data: { queryId: query.id, legId: leg.id, freightForwarderId: ffA.id, status: "SELECT" } });
    const rfq = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: ffB.id,
        rfqNumber: "YAL26-0001-RFQ001",
        accessTokenHash: createHash("sha256").update("x").digest("hex"),
        submissionDeadline: new Date(Date.now() + 86400000),
        incoterms: "FOB",
      },
    });
    await prisma.quote.create({ data: { queryId: query.id, legId: leg.id, freightForwarderId: ffB.id, rfqId: rfq.id, status: "RFQ_SENT" } });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/rfq-state`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);

    expect(res.body.quotes).toHaveLength(2);
    expect(res.body.rfqs).toHaveLength(1);
    expect(res.body.rfqs[0]).toMatchObject({ rfqNumber: "YAL26-0001-RFQ001", incoterms: "FOB" });
    expect(res.body.rfqs[0].accessTokenHash).toBeUndefined(); // secret never leaks
    const ffIds = res.body.freightForwarders.map((f: { id: string }) => f.id).sort();
    expect(ffIds).toEqual([ffA.id, ffB.id].sort());
    const sent = res.body.quotes.find((q: { status: string }) => q.status === "RFQ_SENT");
    expect(sent.rfqId).toBe(rfq.id);
  });

  it("401s an unauthenticated request", async () => {
    await request(app.getHttpServer())
      .get(`/api/queries/00000000-0000-0000-0000-000000000000/rfq-state`)
      .expect(401);
  });

  it("404s for an unknown query", async () => {
    await request(app.getHttpServer())
      .get(`/api/queries/00000000-0000-0000-0000-000000000000/rfq-state`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(404);
  });
});
