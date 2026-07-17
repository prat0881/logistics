process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { Controller, Get, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import cookieParser from "cookie-parser";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AuthModule } from "../src/modules/auth/auth.module";
import { Public } from "../src/modules/auth/decorators/public.decorator";
import { Roles } from "../src/modules/auth/decorators/roles.decorator";
import { CurrentUser } from "../src/modules/auth/decorators/current-user.decorator";
import type { RequestUser } from "../src/modules/auth/types";

@Controller("t")
class TestController {
  @Public()
  @Get("public")
  pub() {
    return { ok: true };
  }

  @Get("me")
  me(@CurrentUser() user: RequestUser) {
    return user;
  }

  @Roles(Role.ADMINISTRATOR)
  @Get("admin")
  admin() {
    return { ok: "admin" };
  }
}

describe("RBAC guards (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;

  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: "u1", role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule],
      controllers: [TestController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  it("allows a @Public route with no cookie", async () => {
    await request(app.getHttpServer()).get("/api/t/public").expect(200, { ok: true });
  });

  it("401s an authenticated route with no cookie", async () => {
    await request(app.getHttpServer()).get("/api/t/me").expect(401);
  });

  it("populates req.user from the access cookie", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/t/me")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body).toEqual({ userId: "u1", role: Role.EXECUTIVE, tenantId: null });
  });

  it("403s a @Roles(ADMINISTRATOR) route for an executive", async () => {
    await request(app.getHttpServer())
      .get("/api/t/admin")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(403);
  });

  it("allows a @Roles(ADMINISTRATOR) route for an administrator", async () => {
    await request(app.getHttpServer())
      .get("/api/t/admin")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .expect(200, { ok: "admin" });
  });
});
