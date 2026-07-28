process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { Test, type TestingModule } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { StatusService } from "../src/modules/status/status.service";
import { QuoteEvent } from "@svyft/shared";

describe("Quote machine (e2e)", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let status: StatusService;
  let quoteId: string;
  let queryId: string;
  let legId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    status = moduleRef.get(StatusService);

    // Self-contained fixtures — no dependency on ambient DB rows.
    const query = await prisma.query.create({ data: { queryCode: "YAL00-QMACHTEST" } });
    queryId = query.id;
    const leg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L-QMACH", status: "READY_FOR_RFQ" },
    });
    legId = leg.id;
    const quote = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: query.id /* any uuid — soft ref for fixture */,
        status: "SELECT",
      },
    });
    quoteId = quote.id;
  });

  afterAll(async () => {
    // FK-safe order: quote → leg → query; ignore missing rows.
    await prisma.quote.deleteMany({ where: { id: quoteId } }).catch(() => {});
    await prisma.leg.deleteMany({ where: { id: legId } }).catch(() => {});
    await prisma.query.deleteMany({ where: { id: queryId } }).catch(() => {});
    await moduleRef.close();
  });

  it("drives SELECT → RFQ_SENT → QUOTED via fire, persisting the column", async () => {
    await status.fire("quote", quoteId, QuoteEvent.SEND, {});
    expect((await prisma.quote.findUnique({ where: { id: quoteId } }))!.status).toBe("RFQ_SENT");
    await status.fire("quote", quoteId, QuoteEvent.SUBMIT, {});
    expect((await prisma.quote.findUnique({ where: { id: quoteId } }))!.status).toBe("QUOTED");
  });

  it("rejects an illegal transition", async () => {
    await expect(status.fire("quote", quoteId, QuoteEvent.SEND, {})).rejects.toBeDefined();
  });
});
