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
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

describe("Org timezone (e2e)", () => {
  let app: INestApplication;
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
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(moduleRef.get(PrismaService));
  });
  afterAll(async () => {
    // restore the default so the suite is idempotent
    await request(app.getHttpServer())
      .patch("/api/config/org-timezone")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ timezone: "Asia/Kolkata" });
    await app.close();
  });

  it("any role reads the seeded org default zone", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/config/org-timezone")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body.timezone).toBe("Asia/Kolkata");
  });

  it("only Admin may change it (Manager → 403; Admin → 200 + persisted)", async () => {
    await request(app.getHttpServer())
      .patch("/api/config/org-timezone")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ timezone: "Asia/Singapore" })
      .expect(403);
    await request(app.getHttpServer())
      .patch("/api/config/org-timezone")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ timezone: "Asia/Singapore" })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get("/api/config/org-timezone")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body.timezone).toBe("Asia/Singapore");
  });

  it("rejects an invalid IANA zone (Zod 400)", async () => {
    await request(app.getHttpServer())
      .patch("/api/config/org-timezone")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ timezone: "Nope/Zone" })
      .expect(400);
  });
});
