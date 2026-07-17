import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";

describe("seedReferenceData", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = m.get(PrismaService);
  });
  afterAll(async () => await app.close());

  it("is idempotent (3 factors, 9 items, 2 code sequences) and preserves edits", async () => {
    await seedReferenceData(prisma);
    await prisma.freightDensityFactor.update({ where: { mode: "AIR" }, data: { kgPerCbm: 999 } });
    await seedReferenceData(prisma); // second run
    expect(await prisma.freightDensityFactor.count()).toBe(3);
    expect(await prisma.checklistDefinition.count()).toBe(9);
    expect(
      (await prisma.freightDensityFactor.findUnique({ where: { mode: "AIR" } }))!.kgPerCbm,
    ).toBe(999); // not overwritten
    expect(await prisma.codeSequence.findUnique({ where: { key: "CLIENT" } })).not.toBeNull();
  });
});
