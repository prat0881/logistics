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

const NAME = "MV Vessels E2E";
const IMO = "9999001";

describe("Vessels (e2e)", () => {
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
      where: { key: "VESSEL" },
      create: { key: "VESSEL", lastNumber: 0 },
      update: {},
    });
    await prisma.vessel.deleteMany({
      where: { OR: [{ name: { startsWith: NAME } }, { imoNumber: IMO }] },
    });
  });

  afterAll(async () => {
    await prisma.vessel.deleteMany({
      where: { OR: [{ name: { startsWith: NAME } }, { imoNumber: IMO }] },
    });
    await app.close();
  });

  it("401s unauthenticated read; 403s Executive create", async () => {
    await request(app.getHttpServer()).get("/api/vessels").expect(401);
    await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ name: NAME, vesselType: "CONTAINER" })
      .expect(403);
  });

  it("Admin creates (mints VS- code); duplicate IMO → 409", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: NAME, vesselType: "CONTAINER", imoNumber: IMO, shippingLine: "Maersk" })
      .expect(201);
    expect(res.body.vesselCode).toMatch(/^VS-\d{4}$/);

    await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: `${NAME} 2`, vesselType: "TANKER", imoNumber: IMO })
      .expect(409);
  });

  it("rejects a bad IMO (400) and searches (200)", async () => {
    await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: NAME, vesselType: "CONTAINER", imoNumber: "12" })
      .expect(400);
    const res = await request(app.getHttpServer())
      .get("/api/vessels?q=Vessels%20E2E")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it("400s a malformed id; clamps a negative page; mints without a pre-seeded sequence", async () => {
    await request(app.getHttpServer())
      .get("/api/vessels/not-a-uuid")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(400);
    await request(app.getHttpServer())
      .get("/api/vessels?page=-1")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    // resilient minting: remove the sequence row, then a create must still succeed with a code.
    // Also free VS-0001 (the code the reset upsert will re-mint) so it can't collide with a
    // vessel an earlier test in this suite already minted it to.
    await prisma.vessel.deleteMany({
      where: { OR: [{ name: { startsWith: NAME } }, { vesselCode: "VS-0001" }] },
    });
    await prisma.codeSequence.deleteMany({ where: { key: "VESSEL" } });
    const res2 = await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: `${NAME} RESILIENT`, vesselType: "CONTAINER" })
      .expect(201);
    expect(res2.body.vesselCode).toMatch(/^VS-\d{4}$/);
  });
});
