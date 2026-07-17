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

const CO = "Clients E2E Co";

describe("Clients (e2e)", () => {
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
    // CodeSequence row for CLIENT must exist (seeded in prod; ensure here for the test DB)
    await prisma.codeSequence.upsert({
      where: { key: "CLIENT" },
      create: { key: "CLIENT", lastNumber: 0 },
      update: {},
    });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: CO } } });
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { companyName: { startsWith: CO } } });
    await app.close();
  });

  it("401s an unauthenticated read", async () => {
    await request(app.getHttpServer()).get("/api/clients").expect(401);
  });

  it("403s an Executive trying to create", async () => {
    await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ companyName: `${CO} X`, country: "IN" })
      .expect(403);
  });

  it("lets a Manager create (mints CL- code), and any role read it", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ companyName: CO, country: "IN", industry: "Logistics" })
      .expect(201);
    expect(created.body.clientCode).toMatch(/^CL-\d{4}$/);
    const id = created.body.id;

    const read = await request(app.getHttpServer())
      .get(`/api/clients/${id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(read.body.companyName).toBe(CO);
  });

  it("409s a duplicate companyName", async () => {
    await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ companyName: CO, country: "IN" })
      .expect(409);
  });

  it("adds contacts and keeps a single primary", async () => {
    const c = await prisma.client.findFirst({ where: { companyName: CO } });
    const id = c!.id;
    await request(app.getHttpServer())
      .post(`/api/clients/${id}/contacts`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({ name: "First", isPrimary: true })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/clients/${id}/contacts`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({ name: "Second", isPrimary: true })
      .expect(201);
    const primaries = await prisma.clientContact.findMany({
      where: { clientId: id, isPrimary: true },
    });
    expect(primaries).toHaveLength(1);
    expect(primaries[0].name).toBe("Second");
  });

  it("searches + paginates", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/clients?q=Clients%20E2E&page=1&pageSize=10")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items.some((c: { companyName: string }) => c.companyName === CO)).toBe(true);
  });

  it("400s an invalid body", async () => {
    await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ country: "IN" })
      .expect(400);
  });

  it("400s a malformed id and a bad status filter; clamps a negative page; mints without a pre-seeded sequence", async () => {
    await request(app.getHttpServer())
      .get("/api/clients/not-a-uuid")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(400);
    await request(app.getHttpServer())
      .get("/api/clients?status=xyz")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(400);
    await request(app.getHttpServer())
      .get("/api/clients?page=-1")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    // resilient minting: remove the sequence row, then a create must still succeed with a code.
    // Also free CL-0001 (the code the reset upsert will re-mint) so it can't collide with a
    // client an earlier test in this suite already minted it to.
    await prisma.client.deleteMany({
      where: { OR: [{ companyName: { startsWith: CO } }, { clientCode: "CL-0001" }] },
    });
    await prisma.codeSequence.deleteMany({ where: { key: "CLIENT" } });
    const res = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ companyName: `${CO} RESILIENT`, country: "IN" })
      .expect(201);
    expect(res.body.clientCode).toMatch(/^CL-\d{4}$/);
  });
});
