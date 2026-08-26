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

  it("rewrites the snapshot columns when the primary contact changes", async () => {
    const ff = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send(base)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/freight-forwarders/${ff.body.id}/contacts`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({
        name: "Priya Nair",
        email: "priya@example.com",
        contactNo: "+971509876543",
        pocLevel: "PRIMARY",
      })
      .expect(201);

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

    await request(app.getHttpServer())
      .post(`/api/freight-forwarders/${ff.body.id}/contacts`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: "First", email: "first@example.com", contactNo: "+971500000001", pocLevel: "PRIMARY" })
      .expect(201);

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
    expect(primaries[0].name).toBe("First");
  });

  it("keeps the last-known snapshot columns (not nulled) once the primary contact is deleted", async () => {
    const ff = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...base, companyName: `${NAME} delete-primary` })
      .expect(201);

    const contact = await request(app.getHttpServer())
      .post(`/api/freight-forwarders/${ff.body.id}/contacts`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: "Only Primary", email: "only@example.com", contactNo: "+971500000003", pocLevel: "PRIMARY" })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/freight-forwarders/${ff.body.id}/contacts/${contact.body.id}`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .expect(204);

    const row = await prisma.freightForwarder.findUnique({ where: { id: ff.body.id } });
    // No primary remains; the columns are NOT NULL with no other source of truth, so they
    // keep their last-known values rather than being nulled or replaced.
    expect(row?.pic).toBe("Only Primary");
    expect(row?.email).toBe("only@example.com");
    expect(row?.contactNumber).toBe("+971500000003");
  });
});
