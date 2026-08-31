process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LegEvent, LegStatus, QuoteEvent, QuoteStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { StatusService } from "../src/modules/status/status.service";

// Task 3 (S5.3), rewired by S5.9 Task 2 (§4.4): the Stage-5 award/negotiation edges are
// CONTRIBUTED onto the existing "quote"/"leg" machines by the `award` module's onModuleInit
// (mirrors how rfq.module.ts contributes the SB6 cascade edges in rfq.module.ts:34-47) —
// leg.machine.ts / quote.machine.ts are never edited. Headless: no controller/HTTP call anywhere
// in this file — StatusService.fire is driven directly, proving each newly-contributed edge is
// legal (findTransition matches on (from, event)) and that `ctx.reason` now persists onto the
// StatusTransition row.
//
// S5.9 Task 2 rewrite: PENDING_APPROVAL sits between QUOTED/FULLY_QUOTED and APPROVED now —
// send-for-approval is the ONLY route to approval. `QUOTED --approve--> APPROVED` and
// `FULLY_QUOTED --approve--> APPROVED` are RETIRED (award.module.ts's Step-3 replacement); the
// two regression-guard tests below prove they no longer resolve rather than silently vanishing.
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
        companyAddress: "1 Test Street",
        country: "Test Country",
        city: "Test City",
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
    it("QUOTED --send_for_approval--> PENDING_APPROVAL, and persists ctx.reason on the StatusTransition row", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.QUOTED, "send-for-approval");
      const res = await status.fire("quote", quote.id, QuoteEvent.SEND_FOR_APPROVAL, {
        queryId: query.id,
        reason: "picked as winner",
      });
      expect(res.from).toBe(QuoteStatus.QUOTED);
      expect(res.to).toBe(QuoteStatus.PENDING_APPROVAL);
      expect((await prisma.quote.findUnique({ where: { id: quote.id } }))?.status).toBe(
        QuoteStatus.PENDING_APPROVAL,
      );

      const t = await prisma.statusTransition.findFirst({
        where: { entity: "quote", entityId: quote.id, event: QuoteEvent.SEND_FOR_APPROVAL },
      });
      expect(t?.to).toBe("PENDING_APPROVAL");
      expect(t?.reason).toBe("picked as winner");
    });

    it("PENDING_APPROVAL --approve--> APPROVED (forward)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.PENDING_APPROVAL, "approve");
      const res = await status.fire("quote", quote.id, QuoteEvent.APPROVE, {
        queryId: query.id,
      });
      expect(res.from).toBe(QuoteStatus.PENDING_APPROVAL);
      expect(res.to).toBe(QuoteStatus.APPROVED);
    });

    it("PENDING_APPROVAL --return--> QUOTED (reopen; reject)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.PENDING_APPROVAL, "return");
      const res = await status.fire("quote", quote.id, QuoteEvent.RETURN, {
        queryId: query.id,
      });
      expect(res.from).toBe(QuoteStatus.PENDING_APPROVAL);
      expect(res.to).toBe(QuoteStatus.QUOTED);
    });

    // Regression guard (S5.9 Task 2): the direct QUOTED -> APPROVED edge is RETIRED. Approving a
    // quote that was never sent for approval must no longer resolve — do not re-add this edge.
    it("QUOTED --approve--> is no longer a legal edge (retired by S5.9 Task 2)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.QUOTED, "retired-approve");
      await expect(
        status.fire("quote", quote.id, QuoteEvent.APPROVE, { queryId: query.id }),
      ).rejects.toBeDefined();
      expect((await prisma.quote.findUnique({ where: { id: quote.id } }))?.status).toBe(
        QuoteStatus.QUOTED,
      );
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

    it("PENDING_APPROVAL --request_requote--> REQUOTED (reopen; declared but currently unreachable — a later task's guard blocks it)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.PENDING_APPROVAL, "requote-from-pending");
      const res = await status.fire("quote", quote.id, QuoteEvent.REQUEST_REQUOTE, {
        queryId: query.id,
      });
      expect(res.from).toBe(QuoteStatus.PENDING_APPROVAL);
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

    // S5.9 Task 2 addition (beyond the brief's Step 3 — see change-order.strategy.ts's
    // "invalidating" group): a PENDING_APPROVAL quote is a live commitment mid-review, exactly
    // like an APPROVED one, so a change-order must be able to invalidate it too.
    it("PENDING_APPROVAL --invalidate--> INVALID (reopen; change-order source)", async () => {
      const { query, quote } = await makeQuote(QuoteStatus.PENDING_APPROVAL, "invalidate-pending");
      const res = await status.fire("quote", quote.id, QuoteEvent.INVALIDATE, {
        queryId: query.id,
      });
      expect(res.from).toBe(QuoteStatus.PENDING_APPROVAL);
      expect(res.to).toBe(QuoteStatus.INVALID);
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
    it("FULLY_QUOTED --send_for_approval--> PENDING_APPROVAL (forward); reason defaults to null when omitted", async () => {
      const { query, leg } = await makeLeg(LegStatus.FULLY_QUOTED, "leg-send-for-approval-full");
      const res = await status.fire("leg", leg.id, LegEvent.SEND_FOR_APPROVAL, { queryId: query.id });
      expect(res.from).toBe(LegStatus.FULLY_QUOTED);
      expect(res.to).toBe(LegStatus.PENDING_APPROVAL);
      expect((await prisma.leg.findUnique({ where: { id: leg.id } }))?.status).toBe(
        LegStatus.PENDING_APPROVAL,
      );

      const t = await prisma.statusTransition.findFirst({
        where: { entity: "leg", entityId: leg.id, event: LegEvent.SEND_FOR_APPROVAL },
      });
      expect(t?.reason).toBeNull();
    });

    it("PARTIALLY_QUOTED --send_for_approval--> PENDING_APPROVAL (forward; A3 deadline-passed path)", async () => {
      const { query, leg } = await makeLeg(LegStatus.PARTIALLY_QUOTED, "leg-send-for-approval-partial");
      const res = await status.fire("leg", leg.id, LegEvent.SEND_FOR_APPROVAL, { queryId: query.id });
      expect(res.from).toBe(LegStatus.PARTIALLY_QUOTED);
      expect(res.to).toBe(LegStatus.PENDING_APPROVAL);
    });

    it("PENDING_APPROVAL --approve--> APPROVED (forward)", async () => {
      const { query, leg } = await makeLeg(LegStatus.PENDING_APPROVAL, "leg-approve");
      const res = await status.fire("leg", leg.id, LegEvent.APPROVE, { queryId: query.id });
      expect(res.from).toBe(LegStatus.PENDING_APPROVAL);
      expect(res.to).toBe(LegStatus.APPROVED);
    });

    it("PENDING_APPROVAL --return.full--> FULLY_QUOTED (reopen)", async () => {
      const { query, leg } = await makeLeg(LegStatus.PENDING_APPROVAL, "leg-return-full");
      const res = await status.fire("leg", leg.id, LegEvent.RETURN_FULL, { queryId: query.id });
      expect(res.from).toBe(LegStatus.PENDING_APPROVAL);
      expect(res.to).toBe(LegStatus.FULLY_QUOTED);
    });

    it("PENDING_APPROVAL --return.partial--> PARTIALLY_QUOTED (reopen)", async () => {
      const { query, leg } = await makeLeg(LegStatus.PENDING_APPROVAL, "leg-return-partial");
      const res = await status.fire("leg", leg.id, LegEvent.RETURN_PARTIAL, { queryId: query.id });
      expect(res.from).toBe(LegStatus.PENDING_APPROVAL);
      expect(res.to).toBe(LegStatus.PARTIALLY_QUOTED);
    });

    // Regression guard (S5.9 Task 2): the direct FULLY_QUOTED -> APPROVED edge is RETIRED.
    it("FULLY_QUOTED --approve--> is no longer a legal edge (retired by S5.9 Task 2)", async () => {
      const { query, leg } = await makeLeg(LegStatus.FULLY_QUOTED, "retired-leg-approve");
      await expect(
        status.fire("leg", leg.id, LegEvent.APPROVE, { queryId: query.id }),
      ).rejects.toBeDefined();
      expect((await prisma.leg.findUnique({ where: { id: leg.id } }))?.status).toBe(
        LegStatus.FULLY_QUOTED,
      );
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

    it("PENDING_APPROVAL --reopen--> READY_FOR_RFQ (reopen; change-order source)", async () => {
      const { query, leg } = await makeLeg(LegStatus.PENDING_APPROVAL, "leg-reopen-pending");
      const res = await status.fire("leg", leg.id, LegEvent.REOPEN, { queryId: query.id });
      expect(res.from).toBe(LegStatus.PENDING_APPROVAL);
      expect(res.to).toBe(LegStatus.READY_FOR_RFQ);
    });
  });
});
