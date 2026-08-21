process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LegStatus, QuoteEvent, QuoteStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { StatusService } from "../src/modules/status/status.service";

// S5.4 Task 1 (S5.3-surfaced fix): LegQuoteProjector's resolved set (originally a local RESOLVED
// array, now @svyft/shared's LEG_ROLLUP_RESOLVED as of S5.9 Task 1) originally counted only
// [QUOTED, EXPIRED, CLOSED] as "resolved" for the leg rollup. The award module (S5.3) contributes
// `quote approve` onto the quote machine; once later tasks start firing it, an approved quote
// didn't count as resolved, so a leg carrying a mix of APPROVED + still-QUOTED quotes could fail
// to reach/hold FULLY_QUOTED. Fix: add APPROVED (and, S5.9, PENDING_APPROVAL) to the resolved set;
// leave REQUOTED out (a re-quote in flight is genuinely not resolved).
//
// S5.9 Task 2: `QUOTED --approve--> APPROVED` is retired — send-for-approval (QUOTED ->
// PENDING_APPROVAL) is now the only route to APPROVED. The first test below fires both edges in
// sequence to reach the same end state this file was written to guard.
//
// Headless: no controller/HTTP call anywhere in this file — StatusService.fire is driven directly
// (mirrors award-machine.e2e-spec.ts / leg-quote-rollup.e2e-spec.ts). No JWT/actor needed since
// FireContext.actorId is optional and nothing here goes over HTTP.
const PREFIX = "s54-legrollup-";

describe(`${PREFIX}(e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let status: StatusService;
  let ffIds: string[]; // Quote has a unique (legId, freightForwarderId) constraint — one FF per quote

  async function makeLegWithQuotes(
    legStatus: LegStatus,
    quoteStatuses: QuoteStatus[],
    label: string,
  ): Promise<{ queryId: string; legId: string; quoteIds: string[] }> {
    const query = await prisma.query.create({
      data: { queryCode: `${PREFIX}${label}-${Date.now()}` },
    });
    const leg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L1", mode: "AIR", status: legStatus },
    });
    const quoteIds: string[] = [];
    for (let i = 0; i < quoteStatuses.length; i++) {
      const quote = await prisma.quote.create({
        data: { queryId: query.id, legId: leg.id, freightForwarderId: ffIds[i], status: quoteStatuses[i] },
      });
      quoteIds.push(quote.id);
    }
    return { queryId: query.id, legId: leg.id, quoteIds };
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

    // Two FFs: every case below seeds 2 quotes on one leg, and Quote has a unique
    // (legId, freightForwarderId) constraint, so each quote needs its own FF.
    const mkFf = (suffix: string) =>
      prisma.freightForwarder.create({
        data: {
          freightForwarderCode: `FF-${PREFIX}${suffix}-${Date.now()}`,
          companyName: `Leg Rollup Approved FF ${suffix} ${Date.now()}`,
          pic: "PIC",
          contactNumber: "+10000000000",
          email: `leg-rollup-approved-ff-${suffix}@e2e.test`,
          availableCountries: ["AE"],
          modes: ["AIR"],
          handleDg: false,
        },
      });
    const ffA = await mkFf("A");
    const ffB = await mkFf("B");
    ffIds = [ffA.id, ffB.id];
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("FULLY_QUOTED leg with 2 QUOTED quotes stays FULLY_QUOTED after one is approved (brief's literal regression guard)", async () => {
    const { queryId, legId, quoteIds } = await makeLegWithQuotes(
      LegStatus.FULLY_QUOTED,
      [QuoteStatus.QUOTED, QuoteStatus.QUOTED],
      "stay-full",
    );
    // S5.9 Task 2: QUOTED --approve--> APPROVED is retired — send-for-approval is now the only
    // route to approval. Two fires reach the SAME end state (QUOTED -> PENDING_APPROVAL ->
    // APPROVED) this test originally exercised in one; ROLLUP_FROZEN (leg-quote.projector.ts)
    // also means the leg itself never moves off FULLY_QUOTED here (only the quote is sent for
    // approval, never the leg) — the leg-level freeze is covered by leg-rollup.e2e-spec.ts.
    await status.fire("quote", quoteIds[0], QuoteEvent.SEND_FOR_APPROVAL, { queryId });
    await status.fire("quote", quoteIds[0], QuoteEvent.APPROVE, { queryId });
    const leg = await prisma.leg.findUnique({ where: { id: legId } });
    expect(leg!.status).toBe(LegStatus.FULLY_QUOTED);
  });

  it("a leg with one APPROVED + one freshly-submitted QUOTED quote reaches FULLY_QUOTED (the real pre/post-fix discriminator)", async () => {
    // Pre-fix RESOLVED = [QUOTED, EXPIRED, CLOSED] doesn't count the pre-seeded APPROVED quote,
    // so `resolved` never reaches `quotes.length` once the second FF submits — the leg is stuck
    // reporting PARTIALLY_QUOTED even though both quotes are effectively done. Post-fix, APPROVED
    // counts, resolved === quotes.length, and QUOTE_FULL correctly fires.
    const { queryId, legId, quoteIds } = await makeLegWithQuotes(
      LegStatus.PARTIALLY_QUOTED,
      [QuoteStatus.APPROVED, QuoteStatus.RFQ_SENT],
      "approved-plus-submit",
    );
    await status.fire("quote", quoteIds[1], QuoteEvent.SUBMIT, { queryId });
    const leg = await prisma.leg.findUnique({ where: { id: legId } });
    expect(leg!.status).toBe(LegStatus.FULLY_QUOTED);
  });

  it("REQUOTED stays OUT of the resolved set — a re-quote in flight blocks FULLY_QUOTED", async () => {
    const { queryId, legId, quoteIds } = await makeLegWithQuotes(
      LegStatus.PARTIALLY_QUOTED,
      [QuoteStatus.REQUOTED, QuoteStatus.RFQ_SENT],
      "requoted-blocks",
    );
    await status.fire("quote", quoteIds[1], QuoteEvent.SUBMIT, { queryId });
    const leg = await prisma.leg.findUnique({ where: { id: legId } });
    // one quote is a re-quote in flight (not resolved) — the leg must NOT report FULLY_QUOTED
    expect(leg!.status).toBe(LegStatus.PARTIALLY_QUOTED);
  });
});
