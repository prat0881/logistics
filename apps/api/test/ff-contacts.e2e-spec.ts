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

const NAME = "FF Contacts E2E";

describe("FF Contacts (e2e)", () => {
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
    await prisma.freightForwarder.deleteMany({ where: { companyName: { startsWith: NAME } } });
  });

  afterAll(async () => {
    await prisma.freightForwarder.deleteMany({ where: { companyName: { startsWith: NAME } } });
    await app.close();
  });

  const base = {
    companyName: NAME,
    companyAddress: "Plot 5, Jebel Ali",
    country: "United Arab Emirates",
    city: "Dubai",
    availableCountries: ["AE"],
    modes: ["SEA"],
    pic: "Legacy Contact",
    contactNumber: "+971500000000",
    email: "legacy@example.com",
    // The brief's literal fixture used "NET_30", which is not one of the ten PaymentTerm
    // values defined in the same brief's Step 4 (CREDIT_7/15/30/45/60, ADVANCE_*,
    // AFTER_DELIVERY_100) — an internal inconsistency in the brief. Corrected to CREDIT_30,
    // the enum value for 30-day net credit terms.
    paymentTerms: "CREDIT_30",
  };

  it("auto-seeds a PRIMARY contact matching pic/contactNumber/email on create", async () => {
    const ff = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, companyName: `${NAME} seed` })
      .expect(201);

    // create() seeds the primary contact in the same transaction as the forwarder row, so the
    // "every forwarder has exactly one PRIMARY contact" invariant holds from row 0 — not only
    // for rows the migration backfilled — and update() (which no longer writes these columns
    // itself) always has a contact row for syncPrimaryContactColumns to read from.
    const contacts = await prisma.freightForwarderContact.findMany({
      where: { freightForwarderId: ff.body.id },
    });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      name: base.pic,
      email: base.email,
      contactNo: base.contactNumber,
      pocLevel: "PRIMARY",
    });
  });

  it("rewrites the snapshot columns when the primary contact changes", async () => {
    const ff = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, companyName: `${NAME} rewrite` })
      .expect(201);

    // create() already seeded a PRIMARY contact from pic/contactNumber/email — a forwarder's
    // contact info is now changed by editing that contact, not by adding a second primary
    // (which would 409; see the conflict test below).
    const seeded = await prisma.freightForwarderContact.findFirstOrThrow({
      where: { freightForwarderId: ff.body.id, pocLevel: "PRIMARY" },
    });

    await request(app.getHttpServer())
      .patch(`/api/freight-forwarders/${ff.body.id}/contacts/${seeded.id}`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({
        name: "Priya Nair",
        email: "priya@example.com",
        contactNo: "+971509876543",
      })
      .expect(200);

    const row = await prisma.freightForwarder.findUnique({ where: { id: ff.body.id } });
    expect(row?.pic).toBe("Priya Nair");
    expect(row?.email).toBe("priya@example.com");
    expect(row?.contactNumber).toBe("+971509876543");
  });

  it("rejects a payment term outside the ten allowed values", async () => {
    await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, companyName: `${NAME} terms`, paymentTerms: "whenever" })
      .expect(400);
  });

  it("stores typical lead time as a number", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, companyName: `${NAME} lead`, typicalLeadTime: 14 })
      .expect(201);
    expect(res.body.typicalLeadTime).toBe(14);
  });

  it("409s a second primary contact with the exact conflict message", async () => {
    const ff = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, companyName: `${NAME} conflict` })
      .expect(201);

    // create() already seeded a PRIMARY contact — a second one conflicts immediately, no
    // setup step needed.
    const conflict = await request(app.getHttpServer())
      .post(`/api/freight-forwarders/${ff.body.id}/contacts`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: "Second", email: "second@example.com", contactNo: "+971500000002", pocLevel: "PRIMARY" })
      .expect(409);
    expect(conflict.body.message).toBe("This freight forwarder already has a primary contact");

    const primaries = await prisma.freightForwarderContact.findMany({
      where: { freightForwarderId: ff.body.id, pocLevel: "PRIMARY" },
    });
    expect(primaries).toHaveLength(1);
    expect(primaries[0].name).toBe(base.pic);
  });

  it("keeps the last-known snapshot columns (not nulled) once the only contact is deleted", async () => {
    const ff = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, companyName: `${NAME} delete-primary` })
      .expect(201);

    const seeded = await prisma.freightForwarderContact.findFirstOrThrow({
      where: { freightForwarderId: ff.body.id, pocLevel: "PRIMARY" },
    });

    await request(app.getHttpServer())
      .delete(`/api/freight-forwarders/${ff.body.id}/contacts/${seeded.id}`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .expect(204);

    const row = await prisma.freightForwarder.findUnique({ where: { id: ff.body.id } });
    // No contact remains at all (not even a non-primary fallback candidate), so the columns
    // keep their last-known values rather than being nulled or replaced.
    expect(row?.pic).toBe(base.pic);
    expect(row?.email).toBe(base.email);
    expect(row?.contactNumber).toBe(base.contactNumber);
  });

  it("demoting the primary to NONE still syncs from it as the oldest remaining active contact", async () => {
    const ff = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, companyName: `${NAME} demote` })
      .expect(201);

    const seeded = await prisma.freightForwarderContact.findFirstOrThrow({
      where: { freightForwarderId: ff.body.id, pocLevel: "PRIMARY" },
    });

    // Demote to NONE and change the contact's details in the same write. No other contact
    // exists, so syncPrimaryContactColumns falls back to this one anyway (the oldest
    // remaining ACTIVE contact, not just PRIMARY ones) — proving the fallback actually re-runs
    // on a demote rather than leaving the columns pointed at stale pre-demotion values.
    await request(app.getHttpServer())
      .patch(`/api/freight-forwarders/${ff.body.id}/contacts/${seeded.id}`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({
        pocLevel: "NONE",
        name: "Demoted But Present",
        email: "demoted@example.com",
        contactNo: "+971500000077",
      })
      .expect(200);

    const row = await prisma.freightForwarder.findUnique({ where: { id: ff.body.id } });
    expect(row?.pic).toBe("Demoted But Present");
    expect(row?.email).toBe("demoted@example.com");
    expect(row?.contactNumber).toBe("+971500000077");
  });

  it("adding a SECONDARY contact does not change the snapshot columns", async () => {
    const ff = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, companyName: `${NAME} secondary-noop` })
      .expect(201);

    const before = await prisma.freightForwarder.findUnique({ where: { id: ff.body.id } });

    await request(app.getHttpServer())
      .post(`/api/freight-forwarders/${ff.body.id}/contacts`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: "Sec One", email: "sec@example.com", contactNo: "+971500000055", pocLevel: "SECONDARY" })
      .expect(201);

    const after = await prisma.freightForwarder.findUnique({ where: { id: ff.body.id } });
    expect(after?.pic).toBe(before?.pic);
    expect(after?.email).toBe(before?.email);
    expect(after?.contactNumber).toBe(before?.contactNumber);
  });

  it("PATCHing a forwarder cannot change pic/contactNumber/email (stripped server-side)", async () => {
    const ff = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, companyName: `${NAME} patch-noop` })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/freight-forwarders/${ff.body.id}`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ pic: "Should Not Land", contactNumber: "+971500099999", email: "nope@example.com" })
      .expect(200);

    const row = await prisma.freightForwarder.findUnique({ where: { id: ff.body.id } });
    expect(row?.pic).toBe(base.pic);
    expect(row?.contactNumber).toBe(base.contactNumber);
    expect(row?.email).toBe(base.email);
  });
});
