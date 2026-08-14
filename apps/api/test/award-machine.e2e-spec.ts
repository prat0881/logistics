process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LegEvent, LegStatus, QuoteEvent, QuoteStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { StatusService } from "../src/modules/status/status.service";

// Task 3 (S5.3): the Stage-5 award/negotiation edges are CONTRIBUTED onto the existing
// "quote"/"leg" machines by a new `award` module's onModuleInit (mirrors how rfq.module.ts
// contributes the SB6 cascade edges in rfq.module.ts:34-47) — leg.machine.ts / quote.machine.ts
// are never edited. Headless: no controller/HTTP call anywhere in this file — StatusService.fire
// is driven directly, proving each newly-contributed edge is legal (findTransition matches on
// (from, event)) and that `ctx.reason` now persists onto the StatusTransition row.
const PREFIX = "s53-award-";

describe(`${PREFIX}(e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let status: StatusService;
  let ffId: string;

  // Fresh Query (+ Leg [+ Quote]) per case, never reused, so a persisted status change from
  // one assertion can't leak into another — same reasoning as sb6-status-edges.e2e-spec.ts /
  // status-machine.e2e-spec.ts. Statuses are seeded DIRECTLY at the required `from` state
  // (rather than driving the whole pre-existing chain) so each new edge can be fired in
  // isolation; `leg`/`quote` are OWNED column-backed stores (DispatchingStateStore reads the
  // Leg/Quote row's `status` column as fire's "current state"), so this is a faithful seed.
  async function makeQuote(quoteStatus: QuoteStatus, label: string) {
    const query = await prisma.query.create({
      data: { queryCode: `${PREFIX}${label}-${Date.now()}` },
    });
    const leg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L1", mode: "AIR" },
    });
    const quote = await prisma.quote.create({
      data: { queryId: query.id, legId: leg.id, freightForwarderId: ffId, status: quoteStatus },
    });
    return { query, leg, quote };
  }

  async function makeLeg(legStatus: LegStatus, label: string) {
    const query = await prisma.query.create({
      data: { queryCode: `${PREFIX}${label}-${Date.now()}` },
    });
    const leg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L1", mode: "ROAD", status: legStatus },
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
    // Quote.freightForwarderId is onDelete: Restrict, so quotes must be gone before the FF.
    await prisma.quote.deleteMany({ where: { queryId: { in: queryIds } } });
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } },
    });
    await prisma.query.deleteMany({ where: { id: { in: queryIds } } }); // cascades Leg
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    status = moduleRef.get(StatusService);
    await seedReferenceData(prisma); // idempotent; matches the repo's standard e2e harness
    await cleanup(); // in case a prior failed run left rows behind

    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}${Date.now()}`,
        companyName: `Award Machine FF ${Date.now()}`,
        pic: "PIC",
        contactNumber: "+10000000000",
        email: "award-machine-ff@e2e.test",
        availableCountries: ["AE"],
        modes: ["AIR"],
        handleDg: false,
      },
    });
    ffId = ff.id;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe("quote edges", () => {
    it("QUOTED --approve--> APPROVED, and persists ctx.reason on the StatusTransition row", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.QUOTED, "approve");
      const res = await status.fire("quote", quote.id, QuoteEvent.APPROVE, {
        queryId: query.id,
        reason: "picked as winner",
      });
      expect(res.from).toBe(QuoteStatus.QUOTED);
      expect(res.to).toBe(QuoteStatus.APPROVED);
      expect((await prisma.quote.findUnique({ where: { id: quote.id } }))?.status).toBe(
        QuoteStatus.APPROVED,
      );

      const t = await prisma.statusTransition.findFirst({
        where: { entity: "quote", entityId: quote.id, event: QuoteEvent.APPROVE },
      });
      expect(t?.to).toBe("APPROVED");
      expect(t?.reason).toBe("picked as winner");
    });

    it("APPROVED --unapprove--> QUOTED (reopen)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.APPROVED, "unapprove");
      const res = await status.fire("quote", quote.id, QuoteEvent.UNAPPROVE, {
        queryId: query.id,
      });
      expect(res.from).toBe(QuoteStatus.APPROVED);
      expect(res.to).toBe(QuoteStatus.QUOTED);
    });

    it("QUOTED --request_requote--> REQUOTED (reopen)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.QUOTED, "requote-from-quoted");
      const res = await status.fire("quote", quote.id, QuoteEvent.REQUEST_REQUOTE, {
        queryId: query.id,
        reason: "negotiate",
      });
      expect(res.from).toBe(QuoteStatus.QUOTED);
      expect(res.to).toBe(QuoteStatus.REQUOTED);
    });

    it("APPROVED --request_requote--> REQUOTED (reopen)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.APPROVED, "requote-from-approved");
      const res = await status.fire("quote", quote.id, QuoteEvent.REQUEST_REQUOTE, {
        queryId: query.id,
      });
      expect(res.from).toBe(QuoteStatus.APPROVED);
      expect(res.to).toBe(QuoteStatus.REQUOTED);
    });

    it("REQUOTED --submit--> QUOTED (forward; durable-REQUOTED re-submit)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.REQUOTED, "resubmit");
      const res = await status.fire("quote", quote.id, QuoteEvent.SUBMIT, { queryId: query.id });
      expect(res.from).toBe(QuoteStatus.REQUOTED);
      expect(res.to).toBe(QuoteStatus.QUOTED);
    });

    it("REQUOTED --expire--> EXPIRED (forward)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.REQUOTED, "expire");
      const res = await status.fire("quote", quote.id, QuoteEvent.EXPIRE, { queryId: query.id });
      expect(res.from).toBe(QuoteStatus.REQUOTED);
      expect(res.to).toBe(QuoteStatus.EXPIRED);
    });

    it("APPROVED --invalidate--> INVALID (reopen; change-order source)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.APPROVED, "invalidate");
      const res = await status.fire("quote", quote.id, QuoteEvent.INVALIDATE, {
        queryId: query.id,
      });
      expect(res.from).toBe(QuoteStatus.APPROVED);
      expect(res.to).toBe(QuoteStatus.INVALID);
    });

    it("rejects an undefined edge (approve from SELECT)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.SELECT, "illegal");
      await expect(
        status.fire("quote", quote.id, QuoteEvent.APPROVE, { queryId: query.id }),
      ).rejects.toBeDefined();
      expect(
        await prisma.statusTransition.count({ where: { entity: "quote", entityId: quote.id } }),
      ).toBe(0);
      expect((await prisma.quote.findUnique({ where: { id: quote.id } }))?.status).toBe(
        QuoteStatus.SELECT,
      );
    });
  });

  describe("leg edges", () => {
    it("FULLY_QUOTED --approve--> APPROVED (forward); reason defaults to null when omitted", async () => {
      const { query, leg } = await makeLeg(LegStatus.FULLY_QUOTED, "leg-approve");
      const res = await status.fire("leg", leg.id, LegEvent.APPROVE, { queryId: query.id });
      expect(res.from).toBe(LegStatus.FULLY_QUOTED);
      expect(res.to).toBe(LegStatus.APPROVED);
      expect((await prisma.leg.findUnique({ where: { id: leg.id } }))?.status).toBe(
        LegStatus.APPROVED,
      );

      const t = await prisma.statusTransition.findFirst({
        where: { entity: "leg", entityId: leg.id, event: LegEvent.APPROVE },
      });
      expect(t?.reason).toBeNull();
    });

    it("APPROVED --reopen_award--> FULLY_QUOTED (reopen)", async () => {
      const { query, leg } = await makeLeg(LegStatus.APPROVED, "leg-reopen-award");
      const res = await status.fire("leg", leg.id, LegEvent.REOPEN_AWARD, { queryId: query.id });
      expect(res.from).toBe(LegStatus.APPROVED);
      expect(res.to).toBe(LegStatus.FULLY_QUOTED);
    });

    it("APPROVED --reopen--> READY_FOR_RFQ (reopen; change-order source)", async () => {
      const { query, leg } = await makeLeg(LegStatus.APPROVED, "leg-reopen");
      const res = await status.fire("leg", leg.id, LegEvent.REOPEN, { queryId: query.id });
      expect(res.from).toBe(LegStatus.APPROVED);
      expect(res.to).toBe(LegStatus.READY_FOR_RFQ);
    });
  });
});
