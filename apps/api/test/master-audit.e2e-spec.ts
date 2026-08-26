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

const NAME = "Audit Columns E2E";

// createdById/updatedById are @db.Uuid columns (see prisma/schema.prisma), so the acting
// user id in the signed cookie must be a real UUID here — unlike the `u-${role}` subs used
// by e2e specs that never persist the sub anywhere. cargo.e2e-spec.ts sets the same
// precedent for the same reason (it writes `sub` into the uuid StatusTransition.actorId).
const ADMIN_USER_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const MANAGER_USER_ID = "bbbbbbbb-2222-4222-8222-222222222222";

describe("Master audit columns (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role, userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await prisma.client.deleteMany({
      where: { companyName: { startsWith: NAME } },
    });
  });

  afterAll(async () => {
    await prisma.client.deleteMany({
      where: { companyName: { startsWith: NAME } },
    });
    await app.close();
  });

  it("records the acting user on create and on update", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.ADMINISTRATOR, ADMIN_USER_ID))
      .send({ companyName: NAME, country: "United Arab Emirates" })
      .expect(201);

    const afterCreate = await prisma.client.findUnique({ where: { id: created.body.id } });
    expect(afterCreate?.createdById).toBe(ADMIN_USER_ID);
    expect(afterCreate?.updatedById).toBe(ADMIN_USER_ID);

    await request(app.getHttpServer())
      .patch(`/api/clients/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER, MANAGER_USER_ID))
      .send({ industry: "Chemicals" })
      .expect(200);

    const afterUpdate = await prisma.client.findUnique({ where: { id: created.body.id } });
    expect(afterUpdate?.createdById).toBe(ADMIN_USER_ID); // unchanged by the update
    expect(afterUpdate?.updatedById).toBe(MANAGER_USER_ID);
  });
});
