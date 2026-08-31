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

const NAME = "MV Required E2E";
const IMO = "9999201";

describe("Vessels required fields (e2e)", () => {
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

  it("rejects a vessel with no IMO number", async () => {
    await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: NAME, shippingLine: "Maersk", vesselType: "Container Vessel" })
      .expect(400);
  });

  it("rejects a vessel with no shipping line", async () => {
    await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: NAME, imoNumber: IMO, vesselType: "Container Vessel" })
      .expect(400);
  });

  it("accepts any vessel type string, not just the old enum values", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: NAME, imoNumber: IMO, shippingLine: "Maersk", vesselType: "Heavy Lift Vessel" })
      .expect(201);
    expect(res.body.vesselType).toBe("Heavy Lift Vessel");
  });
});
