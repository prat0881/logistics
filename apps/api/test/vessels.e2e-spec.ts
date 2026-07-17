process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

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
});
