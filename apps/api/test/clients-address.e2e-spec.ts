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

const NAME = "Client Address E2E";

describe("Client address + contacts (e2e)", () => {
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
      where: { key: "CLIENT" },
      create: { key: "CLIENT", lastNumber: 0 },
      update: {},
    });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: NAME } } });
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { companyName: { startsWith: NAME } } });
    await app.close();
  });

  it("requires street address and city", async () => {
    await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ companyName: NAME, country: "India" })
      .expect(400);
  });

  it("stores the full address", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({
        companyName: NAME,
        country: "India",
        streetAddress: "12 Marine Drive",
        city: "Mumbai",
        postalCode: "400020",
      })
      .expect(201);
    expect(res.body.city).toBe("Mumbai");
    expect(res.body.postalCode).toBe("400020");
  });

  it("allows only one primary contact per client", async () => {
    const client = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ companyName: `${NAME} primary`, country: "India", streetAddress: "1 A Road", city: "Pune" })
      .expect(201);

    const contact = (name: string) => ({
      name, email: `${name.replace(/\W/g, "")}@example.com`, contactNo: "+919812345678", pocLevel: "PRIMARY",
    });

    await request(app.getHttpServer())
      .post(`/api/clients/${client.body.id}/contacts`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send(contact("First"))
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/clients/${client.body.id}/contacts`)
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send(contact("Second"))
      .expect(409);
  });
});
