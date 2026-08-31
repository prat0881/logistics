process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

const NOTE = "FX E2E";

describe("FxRates (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  // A real UUID `sub`: create() writes the actor onto FxRate.createdById (String? @db.Uuid),
  // so a non-UUID sub like "u-MANAGER" would fail P2023 (see charge-config-lock.e2e-spec.ts
  // for the same rationale). GET never writes, but sharing one real-UUID helper is simplest.
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: randomUUID(), role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await prisma.fxRate.deleteMany({ where: { note: { startsWith: NOTE } } });
  });
  afterAll(async () => {
    await prisma.fxRate.deleteMany({ where: { note: { startsWith: NOTE } } });
    await app.close();
  });

  it("Manager can create a rate (201) and it appears in the list", async () => {
    const create = await request(app.getHttpServer())
      .post("/api/fx-rates")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ currency: "INR", unitsPerUsd: 83.2, note: `${NOTE} inr` });
    expect(create.status).toBe(201);
    expect(create.body.currency).toBe("INR");
    const list = await request(app.getHttpServer())
      .get("/api/fx-rates")
      .set("Cookie", cookie(Role.EXECUTIVE));
    expect(list.status).toBe(200);
    expect(list.body.some((r: { note: string }) => r.note === `${NOTE} inr`)).toBe(true);
  });

  it("Executive cannot create a rate (403)", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/fx-rates")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ currency: "EUR", unitsPerUsd: 0.92, note: `${NOTE} eur` });
    expect(res.status).toBe(403);
  });

  it("rejects USD and non-positive rates (400)", async () => {
    for (const body of [
      { currency: "USD", unitsPerUsd: 1 },
      { currency: "INR", unitsPerUsd: -1 },
    ]) {
      const res = await request(app.getHttpServer())
        .post("/api/fx-rates")
        .set("Cookie", cookie(Role.MANAGER))
        .send(body);
      expect(res.status).toBe(400);
    }
  });
});
