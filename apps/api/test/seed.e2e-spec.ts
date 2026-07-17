import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Role } from "@prisma/client";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { runSeed } from "../src/seed/seed-core";

const EMAIL = "seed-e2e-admin@svyft.test";
const users = [
  { name: "Seed Admin", email: EMAIL, password: "seed-pass", role: Role.ADMINISTRATOR },
];

describe("runSeed", () => {
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

  it("creates a missing user with the right role and a hashed password", async () => {
    await runSeed(prisma, users);
    const u = await prisma.user.findUnique({ where: { email: EMAIL } });
    expect(u?.role).toBe(Role.ADMINISTRATOR);
    expect(u?.passwordHash).not.toBe("seed-pass");
  });

  it("is idempotent: never overwrites an existing password, never duplicates", async () => {
    await prisma.user.update({ where: { email: EMAIL }, data: { passwordHash: "SENTINEL" } });
    await runSeed(prisma, users);
    const u = await prisma.user.findUnique({ where: { email: EMAIL } });
    expect(u?.passwordHash).toBe("SENTINEL");
    expect(await prisma.user.count({ where: { email: EMAIL } })).toBe(1);
  });
});
