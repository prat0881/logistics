process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { Test, type TestingModule } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { StatusService } from "../src/modules/status/status.service";
import { QuoteEvent } from "@svyft/shared";

// Two FFs on one READY_FOR_RFQ leg. Sending RFQ moves the leg to RFQ_SENT; the first
// submitted quote → PARTIALLY_QUOTED; the second → FULLY_QUOTED; the query rolls up.
describe("Leg rollup from quotes (e2e)", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let status: StatusService;
  let legId: string;
  let queryId: string;
  let qa: string;
  let qb: string;
  let ffA: string;
  let ffB: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    status = moduleRef.get(StatusService);
    const query = await prisma.query.create({ data: { queryCode: "YAL00-ROLLUPTEST" } });
    queryId = query.id;
    const leg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L-ROLLUP", mode: "AIR", status: "READY_FOR_RFQ" },
    });
    legId = leg.id;
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { in: ["FF-E2E-ROLLUP-A", "FF-E2E-ROLLUP-B"] } },
    });
    const mkFf = (code: string, name: string) =>
      prisma.freightForwarder.create({
        data: {
          freightForwarderCode: code,
          companyName: name,
          pic: "PIC",
          contactNumber: "+10000000000",
          email: `${code}@e2e.test`,
          availableCountries: ["AE"],
          modes: ["AIR"],
          handleDg: false,
        },
      });
    ffA = (await mkFf("FF-E2E-ROLLUP-A", "Rollup FF A E2E")).id;
    ffB = (await mkFf("FF-E2E-ROLLUP-B", "Rollup FF B E2E")).id;
    const mk = (ff: string) =>
      prisma.quote.create({ data: { queryId, legId, freightForwarderId: ff, status: "RFQ_SENT" } });
    qa = (await mk(ffA)).id;
    qb = (await mk(ffB)).id;
    // move the leg to RFQ_SENT explicitly
    await status.fire("leg", legId, "rfq.send", { queryId });
  });

  afterAll(async () => {
    await prisma.quote.deleteMany({ where: { legId } }).catch(() => {});
    await prisma.freightForwarder.deleteMany({ where: { id: { in: [ffA, ffB] } } }).catch(() => {});
    await prisma.leg.deleteMany({ where: { id: legId } }).catch(() => {});
    await prisma.query.deleteMany({ where: { id: queryId } }).catch(() => {});
    await moduleRef.close();
  });

  it("first quote → PARTIALLY_QUOTED, all resolved → FULLY_QUOTED", async () => {
    await status.fire("quote", qa, QuoteEvent.SUBMIT, { queryId });
    expect((await prisma.leg.findUnique({ where: { id: legId } }))!.status).toBe("PARTIALLY_QUOTED");
    await status.fire("quote", qb, QuoteEvent.SUBMIT, { queryId });
    const leg = await prisma.leg.findUnique({ where: { id: legId } });
    expect(leg!.status).toBe("FULLY_QUOTED");
    expect((await prisma.query.findUnique({ where: { id: queryId } }))!.status).toBe("QUOTED");
  });
});
