process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE, PRIMARY_DUPLICATE_MESSAGE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { clientCreateBody } from "./helpers/client";

const CO = "Clients Composite E2E Co";

describe("Clients composite create/update (e2e)", () => {
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

  it("creates a client and its contacts in one request", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        clientCreateBody({
          companyName: `${CO} A`,
          contacts: [
            {
              name: "Primary P",
              email: "p@x.com",
              contactNo: "+971501234567",
              pocLevel: "PRIMARY",
            },
            {
              name: "Second S",
              email: "s@x.com",
              contactNo: "+971501234568",
              pocLevel: "SECONDARY",
            },
          ],
        }),
      )
      .expect(201);

    const contacts = await prisma.clientContact.findMany({ where: { clientId: res.body.id } });
    expect(contacts).toHaveLength(2);
    expect(contacts.filter((c) => c.pocLevel === "PRIMARY")).toHaveLength(1);
  });

  it("400s a create with no primary contact", async () => {
    await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        clientCreateBody({
          companyName: `${CO} B`,
          contacts: [{ name: "N", email: "n@x.com", contactNo: "+971501234567", pocLevel: "NONE" }],
        }),
      )
      .expect(400);
  });

  // The ordering test. A single PATCH that BOTH demotes the incumbent and promotes another
  // must succeed: applied naively (promote first) it violates ClientContact_one_primary
  // mid-transaction, on a payload that is perfectly valid as a whole.
  it("swaps the primary in one request without tripping the partial unique index", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        clientCreateBody({
          companyName: `${CO} C`,
          contacts: [
            { name: "Old P", email: "old@x.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
            {
              name: "New P",
              email: "new@x.com",
              contactNo: "+971501234568",
              pocLevel: "SECONDARY",
            },
          ],
        }),
      )
      .expect(201);

    const before = await prisma.clientContact.findMany({
      where: { clientId: created.body.id },
      orderBy: { createdAt: "asc" },
    });
    const oldP = before.find((c) => c.name === "Old P")!;
    const newP = before.find((c) => c.name === "New P")!;

    await request(app.getHttpServer())
      .patch(`/api/clients/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({
        contacts: [
          {
            id: oldP.id,
            name: oldP.name,
            email: oldP.email,
            contactNo: oldP.contactNo,
            pocLevel: "SECONDARY",
          },
          {
            id: newP.id,
            name: newP.name,
            email: newP.email,
            contactNo: newP.contactNo,
            pocLevel: "PRIMARY",
          },
        ],
      })
      .expect(200);

    const after = await prisma.clientContact.findMany({ where: { clientId: created.body.id } });
    expect(after.find((c) => c.id === newP.id)?.pocLevel).toBe("PRIMARY");
    expect(after.find((c) => c.id === oldP.id)?.pocLevel).toBe("SECONDARY");
  });

  it("deletes a contact omitted from the array", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        clientCreateBody({
          companyName: `${CO} D`,
          contacts: [
            { name: "Keep", email: "k@x.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
            { name: "Drop", email: "d@x.com", contactNo: "+971501234568", pocLevel: "NONE" },
          ],
        }),
      )
      .expect(201);
    const rows = await prisma.clientContact.findMany({ where: { clientId: created.body.id } });
    const keep = rows.find((c) => c.name === "Keep")!;

    await request(app.getHttpServer())
      .patch(`/api/clients/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({
        contacts: [
          {
            id: keep.id,
            name: keep.name,
            email: keep.email,
            contactNo: keep.contactNo,
            pocLevel: "PRIMARY",
          },
        ],
      })
      .expect(200);

    expect(await prisma.clientContact.count({ where: { clientId: created.body.id } })).toBe(1);
  });

  it("400s two primaries at the schema layer, naming the rule", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(clientCreateBody({ companyName: `${CO} E` }))
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/api/clients/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({
        contacts: [
          { name: "P1", email: "p1@x.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
          { name: "P2", email: "p2@x.com", contactNo: "+971501234568", pocLevel: "PRIMARY" },
        ],
      });
    // clientUpdateSchema.contacts carries .refine(atMostOnePrimary), so this never reaches the
    // service: Zod rejects it first, and 400 is the only possible status. The service's
    // query-before-write 409 is the backstop for a caller that bypasses the schema, and it is
    // covered directly in reconcile-contacts.spec.ts — asserting `[400, 409]` here would be a
    // test with one live branch.
    expect(res.status).toBe(400);
    // ZodValidationPipe puts the flat "Validation failed" in `message` and the real rule
    // messages in `issues`, so assert on the issue the atMostOnePrimary refine raises.
    expect(res.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: PRIMARY_DUPLICATE_MESSAGE })]),
    );
  });

  it("leaves a legacy client with no primary contact saveable", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(clientCreateBody({ companyName: `${CO} F` }))
      .expect(201);
    // Simulate a pre-rule row by clearing its primary directly.
    await prisma.clientContact.updateMany({
      where: { clientId: created.body.id },
      data: { pocLevel: "NONE" },
    });

    await request(app.getHttpServer())
      .patch(`/api/clients/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({ companyName: `${CO} F renamed` })
      .expect(200);
  });
});
