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

const CO = "FF E2E Forwarder";
const valid = {
  companyName: CO,
  pic: "Jane Doe",
  contactNumber: "+15551234567",
  email: "ops@ff-e2e.example",
  availableCountries: ["US", "SG"],
  modes: ["AIR", "SEA"],
  handleDg: true,
};

describe("FreightForwarders (e2e)", () => {
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
    await prisma.codeSequence.upsert({
      where: { key: "FREIGHT_FORWARDER" },
      create: { key: "FREIGHT_FORWARDER", lastNumber: 0 },
      update: {},
    });
    await prisma.freightForwarder.deleteMany({ where: { companyName: { startsWith: CO } } });
  });

  afterAll(async () => {
    await prisma.freightForwarder.deleteMany({ where: { companyName: { startsWith: CO } } });
    await app.close();
  });

  it("401s unauthenticated read; 403s an Executive create", async () => {
    await request(app.getHttpServer()).get("/api/freight-forwarders").expect(401);
    await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send(valid)
      .expect(403);
  });

  it("Admin creates (mints FF- code, round-trips arrays); any role reads it", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send(valid)
      .expect(201);
    expect(created.body.freightForwarderCode).toMatch(/^FF-\d{4}$/);
    expect(created.body.modes).toEqual(["AIR", "SEA"]);
    expect(created.body.availableCountries).toEqual(["US", "SG"]);
    const read = await request(app.getHttpServer())
      .get(`/api/freight-forwarders/${created.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(read.body.companyName).toBe(CO);
  });

  it("409s a duplicate companyName", async () => {
    await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ ...valid, email: "dup@ff-e2e.example" })
      .expect(409);
  });

  it("400s an invalid body (bad phone) and searches/paginates", async () => {
    await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ ...valid, companyName: `${CO} 2`, contactNumber: "5551234567" })
      .expect(400);
    const res = await request(app.getHttpServer())
      .get("/api/freight-forwarders?q=FF%20E2E&page=1&pageSize=10")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });
});
