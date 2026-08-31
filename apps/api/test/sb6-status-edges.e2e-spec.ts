process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { Test, type TestingModule } from "@nestjs/testing";
import { LegEvent, LegStatus, QuoteEvent, QuoteStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { StatusService } from "../src/modules/status/status.service";
import { ffFixture } from "./helpers/freight-forwarder";

// Task 5 (SB6): the change-order cascade (a later task) reopens a distributed leg and
// reactivates invalidated quotes on re-distribute. Neither machine FILE is edited — both
// edges are CONTRIBUTED onto the existing "leg"/"quote" machines in rfq.module.ts's
// onModuleInit (findTransition matches on (from, event), so the pre-existing REOPEN/SEND
// events now carry an extra edge each):
//   leg:   RFQ_SENT | PARTIALLY_QUOTED | FULLY_QUOTED --LegEvent.REOPEN--> READY_FOR_RFQ
//   quote: INVALID                     --QuoteEvent.SEND-->             RFQ_SENT
const PREFIX = "sb6-status-edges-";

describe(`${PREFIX}(e2e)`, () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let status: StatusService;

  // Each case gets its OWN fresh Query+Leg (never reused) so a persisted status change
  // can't leak between cases — same reasoning as status-machine.e2e-spec.ts.
  async function makeLeg(label: string, legStatus?: LegStatus) {
    const query = await prisma.query.create({
      data: { queryCode: `${PREFIX}${label}-${Date.now()}` },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L1",
        mode: "AIR",
        ...(legStatus ? { status: legStatus } : {}),
      },
    });
    return { query, leg };
  }

  async function cleanup(): Promise<void> {
    const queries = await prisma.query.findMany({
      where: { queryCode: { startsWith: PREFIX } },
      select: { id: true },
    });
    const queryIds = queries.map((q) => q.id);
    const legs = await prisma.leg.findMany({
      where: { queryId: { in: queryIds } },
      select: { id: true },
    });
    const legIds = legs.map((l) => l.id);
    const quotes = await prisma.quote.findMany({
      where: { queryId: { in: queryIds } },
      select: { id: true },
    });
    const quoteIds = quotes.map((q) => q.id);

    // StatusTransition has no FK to Leg/Quote (entity/entityId is a free-text log key) —
    // Query's cascade delete won't touch it, so the log rows need an explicit sweep first.
    await prisma.statusTransition.deleteMany({
      where: {
        OR: [
          { entity: "leg", entityId: { in: legIds } },
          { entity: "quote", entityId: { in: quoteIds } },
        ],
      },
    });

    // Cleanup order: quote → FF → query (Quote.freightForwarderId is onDelete: Restrict, so
    // quotes must be gone before their FF; Query cascades Leg/Point/CargoItem/etc.).
    await prisma.quote.deleteMany({ where: { queryId: { in: queryIds } } });
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } },
    });
    await prisma.query.deleteMany({ where: { id: { in: queryIds } } });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    status = moduleRef.get(StatusService);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await moduleRef.close();
  });

  describe("leg reopen", () => {
    it("reopens RFQ_SENT back to READY_FOR_RFQ", async () => {
      const { query, leg } = await makeLeg("reopen-rfq-sent", LegStatus.RFQ_SENT);
      const res = await status.fire("leg", leg.id, LegEvent.REOPEN, { queryId: query.id });
      expect(res.from).toBe(LegStatus.RFQ_SENT);
      expect(res.to).toBe(LegStatus.READY_FOR_RFQ);
      const reloaded = await prisma.leg.findUnique({ where: { id: leg.id } });
      expect(reloaded?.status).toBe(LegStatus.READY_FOR_RFQ);
    });

    it("reopens PARTIALLY_QUOTED back to READY_FOR_RFQ", async () => {
      const { query, leg } = await makeLeg("reopen-partial", LegStatus.PARTIALLY_QUOTED);
      const res = await status.fire("leg", leg.id, LegEvent.REOPEN, { queryId: query.id });
      expect(res.from).toBe(LegStatus.PARTIALLY_QUOTED);
      expect(res.to).toBe(LegStatus.READY_FOR_RFQ);
      const reloaded = await prisma.leg.findUnique({ where: { id: leg.id } });
      expect(reloaded?.status).toBe(LegStatus.READY_FOR_RFQ);
    });

    it("reopens FULLY_QUOTED back to READY_FOR_RFQ", async () => {
      const { query, leg } = await makeLeg("reopen-full", LegStatus.FULLY_QUOTED);
      const res = await status.fire("leg", leg.id, LegEvent.REOPEN, { queryId: query.id });
      expect(res.from).toBe(LegStatus.FULLY_QUOTED);
      expect(res.to).toBe(LegStatus.READY_FOR_RFQ);
      const reloaded = await prisma.leg.findUnique({ where: { id: leg.id } });
      expect(reloaded?.status).toBe(LegStatus.READY_FOR_RFQ);
    });
  });

  describe("quote reactivation", () => {
    it("reactivates an INVALID quote back to RFQ_SENT via SEND", async () => {
      const { query, leg } = await makeLeg("quote-reactivation");
      const ff = await prisma.freightForwarder.create({
        data: ffFixture({
          freightForwarderCode: `FF-${PREFIX}${Date.now()}`,
          companyName: `SB6 Status Edges FF ${Date.now()}`,
          pic: "P",
          contactNumber: "+10000000000",
          email: "sb6-status-edges-ff@e2e.test",
          availableCountries: ["AE"],
          modes: ["AIR"],
          handleDg: false,
        }),
      });
      const quote = await prisma.quote.create({
        data: {
          queryId: query.id,
          legId: leg.id,
          freightForwarderId: ff.id,
          status: QuoteStatus.QUOTED,
        },
      });

      // QUOTED --INVALIDATE--> INVALID (pre-existing "reopen" edge; sets up the fixture).
      const invalidated = await status.fire("quote", quote.id, QuoteEvent.INVALIDATE, {
        queryId: query.id,
      });
      expect(invalidated.from).toBe(QuoteStatus.QUOTED);
      expect(invalidated.to).toBe(QuoteStatus.INVALID);

      // INVALID --SEND--> RFQ_SENT (the new edge under test).
      const reactivated = await status.fire("quote", quote.id, QuoteEvent.SEND, {
        queryId: query.id,
      });
      expect(reactivated.from).toBe(QuoteStatus.INVALID);
      expect(reactivated.to).toBe(QuoteStatus.RFQ_SENT);

      const reloaded = await prisma.quote.findUnique({ where: { id: quote.id } });
      expect(reloaded?.status).toBe(QuoteStatus.RFQ_SENT);
    });
  });
});
