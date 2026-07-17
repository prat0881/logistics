import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { CodeSequenceService } from "../src/common/code-sequence.service";

const KEY = "TEST_SEQ";

describe("CodeSequenceService (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seq: CodeSequenceService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    seq = moduleRef.get(CodeSequenceService);
    await prisma.codeSequence.upsert({
      where: { key: KEY },
      create: { key: KEY, lastNumber: 0 },
      update: { lastNumber: 0 },
    });
  });

  afterAll(async () => {
    await prisma.codeSequence.deleteMany({ where: { key: KEY } });
    await app.close();
  });

  it("mints sequential zero-padded codes", async () => {
    expect(await seq.next(KEY, "TS")).toBe("TS-0001");
    expect(await seq.next(KEY, "TS")).toBe("TS-0002");
  });

  it("mints unique codes under concurrency (atomic increment)", async () => {
    const codes = await Promise.all(Array.from({ length: 10 }, () => seq.next(KEY, "TS")));
    expect(new Set(codes).size).toBe(10);
  });
});
