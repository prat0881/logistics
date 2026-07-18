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
import { seedReferenceData } from "../src/seed/reference-seed";

const PFX = "p4-queries-";

describe("Queries (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let clientId: string;
  // sub is a UUID: it lands in @db.Uuid columns (assignedUserId). A synthetic non-uuid
  // sub would P2023 on insert.
  const EXEC_ID = "11111111-1111-1111-1111-111111111111";
  const cookie = (role: Role, sub = EXEC_ID) => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(prisma); // 9 checklist definitions (CI is unseeded)
    const client = await prisma.client.create({ data: { clientCode: `${PFX}CL`, companyName: `${PFX}Client`, country: "IN" } });
    clientId = client.id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: PFX } } });
    await app.close();
  });

  it("401s an unauthenticated create", async () => {
    await request(app.getHttpServer()).post("/api/queries").send({}).expect(401);
  });

  it("mints a YALYY-NNNN code, seeds the 9 checklist items, assigns the creator, status DRAFT", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE, EXEC_ID))
      .send({ clientId, shipmentDescription: `${PFX}first`, incoterms: "FOB" })
      .expect(201);
    expect(res.body.queryCode).toMatch(/^YAL\d{2}-\d{4}$/);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.assignedUserId).toBe(EXEC_ID);
    const got = await request(app.getHttpServer())
      .get(`/api/queries/${res.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(got.body.checklist).toHaveLength(9);
    expect(got.body.checklist.every((c: { checked: boolean }) => c.checked === false)).toBe(true);
  });

  it("400s an invalid draft (bad email / bad incoterms)", async () => {
    await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ contactEmail: "nope", shipmentDescription: `${PFX}bad` })
      .expect(400);
  });

  it("400s a non-existent clientId (FK guarded, not a 500)", async () => {
    await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ clientId: "00000000-0000-0000-0000-000000000000", shipmentDescription: `${PFX}fk` })
      .expect(400);
  });
});
