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

  // Backward compatibility: this is exactly the payload every existing FF spec sends.
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
  });

  // The double-insert guard. Without the skip, this payload writes the supplied PRIMARY *and*
  // the seeded one, and FreightForwarderContact_one_primary rejects the whole transaction.
  it("uses the supplied primary and does not also seed one", async () => {
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
