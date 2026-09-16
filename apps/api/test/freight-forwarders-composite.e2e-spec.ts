process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE, PRIMARY_REQUIRED_MESSAGE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

const FF = "FF Composite E2E Co";

// The HTTP-shaped create body (distinct from `ffFixture` in test/helpers/freight-forwarder.ts,
// which is a Prisma.FreightForwarderCreateInput for direct row creation).
function ffCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    companyName: `${FF} Default`,
    companyAddress: "1 Composite Way",
    city: "Composite City",
    country: "Composite Country",
    pic: "Fixture PIC",
    contactNumber: "+15551234567",
    email: "fixture-pic@ff-composite.example",
    availableCountries: ["AE"],
    modes: ["AIR"],
    handleDg: false,
    ...overrides,
  };
}

describe("FreightForwarders composite create/update (e2e)", () => {
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
    await prisma.codeSequence.upsert({
      where: { key: "FREIGHT_FORWARDER" },
      create: { key: "FREIGHT_FORWARDER", lastNumber: 0 },
      update: {},
    });
    await prisma.freightForwarder.deleteMany({ where: { companyName: { startsWith: FF } } });
  });

  afterAll(async () => {
    await prisma.freightForwarder.deleteMany({ where: { companyName: { startsWith: FF } } });
    await app.close();
  });

  // Backward compatibility AND the regression guard for Finding 1 (task-6 review): a create
  // with no `contacts` key must yield exactly one PRIMARY, seeded from the submitted
  // pic/contactNumber/email — both on the contact row AND on the forwarder row itself, so a
  // seed that got deleted out from under the write (Finding 1's corruption) would show up here
  // as either zero contacts or a forwarder whose pic no longer matches what was submitted.
  it("still seeds the primary from pic/contactNumber/email when contacts is absent", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.MANAGER))
      .send(ffCreateBody({ companyName: `${FF} A` }))
      .expect(201);

    const contacts = await prisma.freightForwarderContact.findMany({
      where: { freightForwarderId: res.body.id },
    });
    expect(contacts).toHaveLength(1);
    expect(contacts[0].pocLevel).toBe("PRIMARY");
    expect(contacts[0].name).toBe("Fixture PIC");

    const ff = await prisma.freightForwarder.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(ff.pic).toBe("Fixture PIC");
    expect(ff.email).toBe("fixture-pic@ff-composite.example");
    expect(ff.contactNumber).toBe("+15551234567");
  });

  // Outcome-based, not implementation-based (task-6 review Finding 2): asserts the state that
  // must hold after a create supplying a PRIMARY — exactly one PRIMARY among exactly the
  // submitted contacts, and it is the submitted one, not the seed. Verified by mutation: with
  // the create()'s seed condition inverted, this exact assertion set still passes (reconcile's
  // delete-before-create step removes the seed regardless, once any contacts are supplied), so
  // this test does NOT re-detect a regression in that specific line — see the task-6 fix report
  // for the mutation-testing trace and which test actually catches that inversion (the one
  // above, whenever `contacts` is entirely absent).
  it("creates the supplied contacts with exactly one primary, and it is the supplied one", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        ffCreateBody({
          companyName: `${FF} B`,
          contacts: [
            { name: "Supplied P", email: "sp@x.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
            { name: "Second", email: "sec@x.com", contactNo: "+971501234568", pocLevel: "SECONDARY" },
          ],
        }),
      )
      .expect(201);

    const contacts = await prisma.freightForwarderContact.findMany({
      where: { freightForwarderId: res.body.id },
    });
    expect(contacts).toHaveLength(2);
    expect(contacts.filter((c) => c.pocLevel === "PRIMARY")).toHaveLength(1);
    expect(contacts.find((c) => c.pocLevel === "PRIMARY")?.name).toBe("Supplied P");
    expect(contacts.map((c) => c.name).sort()).toEqual(["Second", "Supplied P"]);
  });

  // C3/design: `contacts`, when supplied on create, must carry exactly one PRIMARY — a payload
  // with none is rejected before it ever reaches the service (Finding 1's corrupting case).
  it("400s a create whose supplied contacts include no primary", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        ffCreateBody({
          companyName: `${FF} NoPrimary`,
          contacts: [
            { name: "Only Secondary", email: "os@x.com", contactNo: "+971501234567", pocLevel: "SECONDARY" },
          ],
        }),
      );
    expect(res.status).toBe(400);
    // ZodValidationPipe puts the flat "Validation failed" in `message` and the real rule
    // messages in `issues` — assert on the issue the exactlyOnePrimary refine raises.
    expect(res.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: PRIMARY_REQUIRED_MESSAGE })]),
    );
  });

  // C7: the derived columns must track the primary contact, and only via the sync.
  it("syncs pic/contactNumber/email from the primary contact after a composite write", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.MANAGER))
      .send(ffCreateBody({ companyName: `${FF} C` }))
      .expect(201);

    const [existing] = await prisma.freightForwarderContact.findMany({
      where: { freightForwarderId: created.body.id },
    });

    await request(app.getHttpServer())
      .patch(`/api/freight-forwarders/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({
        contacts: [
          {
            id: existing.id,
            name: "Renamed PIC",
            email: "renamed@x.com",
            contactNo: "+971509999999",
            pocLevel: "PRIMARY",
          },
        ],
      })
      .expect(200);

    const ff = await prisma.freightForwarder.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(ff.pic).toBe("Renamed PIC");
    expect(ff.email).toBe("renamed@x.com");
    expect(ff.contactNumber).toBe("+971509999999");
  });
});
