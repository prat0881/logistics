import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const CODE = "CL-TEST-1";
const CO = "Masters Model Test Co";

describe("Masters models (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.client.deleteMany({ where: { companyName: CO } });
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { companyName: CO } });
    await app.close();
  });

  it("creates a client with a cascade-deleting contact and status default ACTIVE", async () => {
    const client = await prisma.client.create({
      data: {
        clientCode: CODE,
        companyName: CO,
        country: "IN",
        streetAddress: "1 Test Road",
        city: "Test City",
        contacts: {
          create: {
            name: "Primary POC",
            email: "primary@example.com",
            contactNo: "+10000000001",
            pocLevel: "PRIMARY",
          },
        },
      },
      include: { contacts: true },
    });
    expect(client.status).toBe("ACTIVE");
    expect(client.contacts).toHaveLength(1);

    await prisma.client.delete({ where: { id: client.id } });
    const orphans = await prisma.clientContact.findMany({ where: { clientId: client.id } });
    expect(orphans).toHaveLength(0); // onDelete: Cascade
  });

  it("enforces unique companyName", async () => {
    await prisma.client.create({
      data: { clientCode: "CL-TEST-2", companyName: CO, country: "IN", streetAddress: "1 Test Road", city: "Test City" },
    });
    await expect(
      prisma.client.create({
        data: { clientCode: "CL-TEST-3", companyName: CO, country: "IN", streetAddress: "1 Test Road", city: "Test City" },
      }),
    ).rejects.toThrow();
  });
});
