import { Test, type TestingModule } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { RfqNumberService } from "../src/modules/rfq/rfq-number.service";

describe("RfqNumberService (e2e)", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let svc: RfqNumberService;
  let queryId: string;
  let queryCode: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    svc = moduleRef.get(RfqNumberService);
    const q = await prisma.query.create({ data: { queryCode: "YAL00-RFQNUMTEST" } });
    queryId = q.id; queryCode = q.queryCode;
    await prisma.rfqSequence.deleteMany({ where: { queryId } });
  });
  afterAll(async () => {
    await prisma.rfqSequence.deleteMany({ where: { queryId } });
    try { await prisma.query.delete({ where: { id: queryId } }); } catch { /* already deleted */ }
    await moduleRef.close();
  });

  it("mints RFQ001, RFQ002 per query", async () => {
    const a = await prisma.$transaction((tx) => svc.next(queryId, tx));
    const b = await prisma.$transaction((tx) => svc.next(queryId, tx));
    expect(a).toBe(`${queryCode}-RFQ001`);
    expect(b).toBe(`${queryCode}-RFQ002`);
  });
});
