import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
const PFX = "p7-emails-";
const EXEC_ID = "22222222-2222-2222-2222-222222222222";

// The unchecked checklist item seeded for the test query
const UNCHECKED_ITEM_KEY = "weight-confirmed";
// Label matches reference-seed ChecklistDefinition for "weight-confirmed"
const UNCHECKED_LABEL = "Weight confirmed";

describe("Emails (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let queryId: string;
  let queryCode: string;
  let uncheckedLabel: string;

  const cookie = () =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: EXEC_ID, role: Role.EXECUTIVE, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);

    // Clean up any leftovers from a previous run
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });

    // Create a query with a client contact email
    queryCode = `${PFX}${Date.now()}`;
    const q = await prisma.query.create({
      data: {
        queryCode,
        shipmentDescription: `${PFX}q`,
        contactName: "Test Contact",
        contactEmail: "test@example.com",
      },
    });
    queryId = q.id;

    // Ensure the checklistDefinition for our item key exists (idempotent upsert)
    await prisma.checklistDefinition.upsert({
      where: { itemKey: UNCHECKED_ITEM_KEY },
      create: { itemKey: UNCHECKED_ITEM_KEY, label: UNCHECKED_LABEL, order: 1, dgConditional: false },
      update: {},
    });

    // Seed one unchecked checklist item for the query
    await prisma.queryChecklistItem.upsert({
      where: { queryId_itemKey: { queryId, itemKey: UNCHECKED_ITEM_KEY } },
      create: { queryId, itemKey: UNCHECKED_ITEM_KEY, checked: false },
      update: { checked: false },
    });

    // Retrieve the label as the service will resolve it
    const def = await prisma.checklistDefinition.findUnique({ where: { itemKey: UNCHECKED_ITEM_KEY } });
    uncheckedLabel = def?.label ?? UNCHECKED_LABEL;
  });

  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("composes + logs a follow-up with the missing-items list; nothing sent", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/emails/follow-up`)
      .set("Cookie", cookie())
      .expect(201);
    expect(res.body.template).toBe("FOLLOW_UP");
    expect(res.body.status).toBe("LOGGED");
    expect(res.body.subject).toContain(queryCode);
    expect(res.body.bodyRendered).toMatch(/Missing information/i);
    // The seeded unchecked item's label appears in the rendered body
    expect(res.body.bodyRendered).toContain(uncheckedLabel);
  });

  it("composes an acknowledgement with the 24h timeline", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/emails/acknowledgement`)
      .set("Cookie", cookie())
      .expect(201);
    expect(res.body.template).toBe("ACKNOWLEDGEMENT");
    expect(res.body.bodyRendered).toMatch(/24 hours/);
  });

  it("lists logged emails for the query", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/queries/${queryId}/emails`)
      .set("Cookie", cookie())
      .expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    // newest-first ordering (createdAt desc)
    expect(new Date(res.body[0].createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(res.body[1].createdAt).getTime(),
    );
  });

  it("404s compose for a missing query", async () => {
    await request(app.getHttpServer())
      .post(`/api/queries/${EXEC_ID}/emails/follow-up`)
      .set("Cookie", cookie())
      .expect(404);
  });
});
