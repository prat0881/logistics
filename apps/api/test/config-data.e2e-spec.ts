process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";

describe("Config data (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    await app.init();
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(moduleRef.get(PrismaService));
  });

  afterAll(async () => {
    await app.close();
  });

  it("any role reads density factors (seeded ROAD/AIR/SEA)", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/config/density-factors")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    const sea = res.body.find((d: { mode: string }) => d.mode === "SEA");
    expect(sea.kgPerCbm).toBe(1000);
  });

  it("only Admin may edit a density factor (Manager → 403, Admin → 200)", async () => {
    await request(app.getHttpServer())
      .patch("/api/config/density-factors/AIR")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ kgPerCbm: 200 })
      .expect(403);
    await request(app.getHttpServer())
      .patch("/api/config/density-factors/AIR")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ kgPerCbm: 200 })
      .expect(200);
  });

  it("reads the 9 checklist items in order", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/config/checklist-definition")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body).toHaveLength(9);
    expect(res.body[0].order).toBeLessThanOrEqual(res.body[8].order);
    expect(
      res.body.find((i: { itemKey: string }) => i.itemKey === "msds-received").dgConditional,
    ).toBe(true);
  });
});
