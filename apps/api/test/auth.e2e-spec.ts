process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { Role, ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PasswordService } from "../src/modules/auth/password.service";

const EMAIL = "auth-e2e@svyft.test";
const PASSWORD = "correct horse battery";

function pick(setCookies: string[], name: string): string {
  const c = setCookies.find((x) => x.startsWith(`${name}=`));
  return c ? c.split(";")[0] : "";
}

describe("Auth (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    const passwords = moduleRef.get(PasswordService);
    await prisma.refreshToken.deleteMany({ where: { user: { email: EMAIL } } });
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await prisma.user.create({
      data: {
        name: "Auth E2E",
        email: EMAIL,
        passwordHash: await passwords.hash(PASSWORD),
        role: Role.EXECUTIVE,
      },
    });
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { user: { email: EMAIL } } });
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  const login = () =>
    request(app.getHttpServer()).post("/api/auth/login").send({ email: EMAIL, password: PASSWORD });

  it("400s a malformed body", async () => {
    await request(app.getHttpServer()).post("/api/auth/login").send({ email: "x" }).expect(400);
  });

  it("401s a wrong password", async () => {
    await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: EMAIL, password: "nope" })
      .expect(401);
  });

  it("logs in, returns the user (no hash), sets two httpOnly cookies", async () => {
    const res = await login().expect(200);
    expect(res.body.user).toMatchObject({ email: EMAIL, role: Role.EXECUTIVE });
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookies = res.get("Set-Cookie") as unknown as string[];
    expect(cookies.some((c) => c.startsWith(`${ACCESS_TOKEN_COOKIE}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${REFRESH_TOKEN_COOKIE}=`))).toBe(true);
    expect(cookies.every((c) => c.toLowerCase().includes("httponly"))).toBe(true);
  });

  it("guards /auth/me: 401 without a cookie, 200 with the access cookie", async () => {
    await request(app.getHttpServer()).get("/api/auth/me").expect(401);
    const cookies = (await login()).get("Set-Cookie") as unknown as string[];
    const me = await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", pick(cookies, ACCESS_TOKEN_COOKIE))
      .expect(200);
    expect(me.body.user.email).toBe(EMAIL);
  });

  it("rotates the refresh token and rejects the rotated-out one", async () => {
    const refresh = pick(
      (await login()).get("Set-Cookie") as unknown as string[],
      REFRESH_TOKEN_COOKIE,
    );
    await request(app.getHttpServer()).post("/api/auth/refresh").set("Cookie", refresh).expect(200);
    await request(app.getHttpServer()).post("/api/auth/refresh").set("Cookie", refresh).expect(401);
  });

  it("logs out, revoking the refresh token", async () => {
    const refresh = pick(
      (await login()).get("Set-Cookie") as unknown as string[],
      REFRESH_TOKEN_COOKIE,
    );
    await request(app.getHttpServer()).post("/api/auth/logout").set("Cookie", refresh).expect(204);
    await request(app.getHttpServer()).post("/api/auth/refresh").set("Cookie", refresh).expect(401);
  });
});
