import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const EMAIL = "user-model-e2e@svyft.test";

describe("User model (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.user.deleteMany({ where: { email: EMAIL } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  it("creates a user with a role and defaults isActive to true", async () => {
    const user = await prisma.user.create({
      data: { name: "Model Test", email: EMAIL, passwordHash: "x", role: "MANAGER" },
    });
    expect(user.id).toMatch(/[0-9a-f-]{36}/);
    expect(user.role).toBe("MANAGER");
    expect(user.isActive).toBe(true);
  });

  it("enforces a unique email", async () => {
    await expect(
      prisma.user.create({
        data: { name: "Dup", email: EMAIL, passwordHash: "x", role: "EXECUTIVE" },
      }),
    ).rejects.toThrow();
  });
});
