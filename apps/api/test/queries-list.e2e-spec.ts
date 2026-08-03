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
import bcrypt from "bcryptjs";

const PFX = "P6LIST-";

describe("GET /queries list (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let clientId: string;
  let authCookie: string;
  let assignedUserId: string;
  let q2Id: string;

  // UUID sub — lands in @db.Uuid assignedUserId column without P2023
  const EXEC_ID = "22222222-2222-2222-2222-222222222222";
  const ASSIGNED_USER_NAME = `${PFX}Bob`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(prisma);

    const client = await prisma.client.create({
      data: { clientCode: `${PFX}CL`, companyName: `${PFX}Client`, country: "IN" },
    });
    clientId = client.id;

    // Create a real User whose name we can assert in assignedUserName
    const assignedUser = await prisma.user.create({
      data: {
        name: ASSIGNED_USER_NAME,
        email: `${PFX}bob@example.com`,
        passwordHash: await bcrypt.hash("test-password", 1),
        role: "EXECUTIVE",
      },
    });
    assignedUserId = assignedUser.id;

    authCookie = `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: EXEC_ID, role: Role.EXECUTIVE, tenantId: null })}`;

    // Q1: priority HIGH, status DRAFT, no legs
    await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", authCookie)
      .send({
        clientId,
        shipmentDescription: `${PFX}q1-high`,
        priority: "HIGH",
      })
      .expect(201);

    // Q2: add a SEA leg (Pickup + Seaport points) → freightMode=[SEA]; contactName "Alice"
    // Also assign to the seeded User so assignedUserName resolution is exercised
    const resQ2 = await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", authCookie)
      .send({
        clientId,
        shipmentDescription: `${PFX}q2-sea`,
        priority: "MEDIUM",
        contactName: "Alice",
        assignedUserId,
      })
      .expect(201);
    q2Id = resQ2.body.id as string;

    // Create PICKUP and SEAPORT points for Q2
    const pu2 = await prisma.point.create({
      data: {
        queryId: q2Id,
        type: "PICKUP",
        name: "Mumbai Warehouse",
        city: "Mumbai",
        country: "IN",
      },
    });
    const sp2 = await prisma.point.create({
      data: {
        queryId: q2Id,
        type: "SEAPORT",
        name: "JNPT",
        city: "Navi Mumbai",
        country: "IN",
      },
    });

    // Create a SEA leg
    await prisma.leg.create({
      data: {
        queryId: q2Id,
        legCode: "L1",
        mode: "SEA",
        originPointId: pu2.id,
        destinationPointId: sp2.id,
      },
    });

    // Q3: priority LOW
    await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", authCookie)
      .send({
        clientId,
        shipmentDescription: `${PFX}q3-low`,
        priority: "LOW",
      })
      .expect(201);
  });

  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: PFX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PFX } } });
    await app.close();
  });

  // Fix 3: scope the pagination test to this suite's prefix so total === 3 (not all DB rows)
  it("lists queries with pagination envelope", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/queries?q=${PFX}&pageSize=2&sort=queryDate:asc`)
      .set("Cookie", authCookie)
      .expect(200);
    expect(res.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items[0]).toHaveProperty("queryCode");
    expect(res.body.items[0]).toHaveProperty("freightMode");
  });

  it("searches across queryCode/contact/description", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/queries?q=Alice")
      .set("Cookie", authCookie)
      .expect(200);
    expect(res.body.items.some((r: { contactName: string | null }) => r.contactName === "Alice")).toBe(true);
  });

  it("S3.2: q matches PICKUP/DELIVERY point country (contains, case-insensitive)", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/queries?q=in&pageSize=100")
      .set("Cookie", authCookie)
      .expect(200);
    expect(res.body.items.some((r: { id: string }) => r.id === q2Id)).toBe(true);
  });

  it("S3.2: the standalone country param is gone (folded into q, so it no longer filters)", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/queries?q=${PFX}&country=ZZ`)
      .set("Cookie", authCookie)
      .expect(200);
    expect(res.body.total).toBe(3);
  });

  it("filters by priority and by derived freightMode", async () => {
    const high = await request(app.getHttpServer())
      .get(`/api/queries?priority=HIGH&q=${PFX}`)
      .set("Cookie", authCookie)
      .expect(200);
    expect(high.body.items.every((r: { priority: string }) => r.priority === "HIGH")).toBe(true);

    const sea = await request(app.getHttpServer())
      .get(`/api/queries?freightMode=SEA&q=${PFX}`)
      .set("Cookie", authCookie)
      .expect(200);
    expect(sea.body.items.every((r: { freightMode: string[] }) => r.freightMode.includes("SEA"))).toBe(true);
  });

  // Fix 2: verify the batched assignedUserName resolution returns the seeded user's name
  it("resolves assignedUserName via batched user.findMany", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/queries?q=${PFX}q2-sea`)
      .set("Cookie", authCookie)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].assignedUserId).toBe(assignedUserId);
    expect(res.body.items[0].assignedUserName).toBe(ASSIGNED_USER_NAME);
  });

  it("401s without auth", () =>
    request(app.getHttpServer()).get("/api/queries").expect(401));
});
