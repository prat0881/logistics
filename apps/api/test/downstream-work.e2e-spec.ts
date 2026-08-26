process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { Test, type TestingModule } from "@nestjs/testing";
import { QuoteStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ScopeResolver } from "../src/modules/changes/scope.resolver";

const PFX = "p9-downstream-work-";

// SB6 (Task 3): downstreamWork(scope) arms the change-order fork (design doc §7.3/§11.2) —
// TRUE iff a Quote on a scope-leg is "live" (`LIVE_QUOTE_WHERE`, changes/live-quotes.ts). A
// pre-RFQ SELECT quote, or an already-invalidated INVALID one, does NOT count.
//
// CORRECTED (S5.9.5 final whole-branch review, CRITICAL 1) — this used to say EXPIRED does not
// count either, full stop. That is only true of an expired quote with NO `draftJson`. Since D4
// the deadline sweep KEEPS the draft of a quote expiring out of REQUOTED, and such an offer is
// comparable, rankable, sendable and approvable, so it IS live. Both directions are pinned
// below, and the change-order cascade end of the same distinction is pinned by
// `change-order-apply.e2e-spec.ts`.
//
// Task 2 already guarantees the classifier only ever emits leg-typed scope for downstream-bearing
// entities, but the resolver must not assume that — it filters for type === "leg" on its own.
describe("ScopeResolver.downstreamWork (e2e)", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let resolver: ScopeResolver;

  let queryId: string;
  let legSentId: string;
  let legQuotedId: string;
  let legStaleId: string;
  let legExpiredPricedId: string;
  const ffIds: string[] = [];

  async function mkFf(code: string) {
    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "PIC",
        contactNumber: "+10000000000",
        email: `${code}@e2e.test`,
        availableCountries: ["IN"],
        modes: ["ROAD"],
        handleDg: false,
      },
    });
    ffIds.push(ff.id);
    return ff;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    resolver = moduleRef.get(ScopeResolver);

    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: PFX } } });
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });

    const q = await prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}q` },
    });
    queryId = q.id;

    legSentId = (await prisma.leg.create({ data: { queryId, legCode: "L-SENT" } })).id;
    legQuotedId = (await prisma.leg.create({ data: { queryId, legCode: "L-QUOTED" } })).id;
    legStaleId = (await prisma.leg.create({ data: { queryId, legCode: "L-STALE" } })).id;
    legExpiredPricedId = (await prisma.leg.create({ data: { queryId, legCode: "L-EXP-PRICED" } })).id;

    // A quote requires a real FreightForwarder (hard FK, onDelete: Restrict) and the
    // (legId, freightForwarderId) pair is unique, so each quote below gets its own FF.
    const ffSent = await mkFf(`${PFX}ff-sent`);
    const ffQuoted = await mkFf(`${PFX}ff-quoted`);
    const ffSelect = await mkFf(`${PFX}ff-select`);
    const ffExpired = await mkFf(`${PFX}ff-expired`);
    const ffInvalid = await mkFf(`${PFX}ff-invalid`);
    const ffExpiredPriced = await mkFf(`${PFX}ff-exp-priced`);

    await prisma.quote.create({
      data: { queryId, legId: legSentId, freightForwarderId: ffSent.id, status: QuoteStatus.RFQ_SENT },
    });
    await prisma.quote.create({
      data: { queryId, legId: legQuotedId, freightForwarderId: ffQuoted.id, status: QuoteStatus.QUOTED },
    });
    // legStaleId carries three quotes, none of them "live" (distributed but SELECT hasn't
    // moved / has gone stale) — the leg must still resolve to no downstream work.
    await prisma.quote.create({
      data: { queryId, legId: legStaleId, freightForwarderId: ffSelect.id, status: QuoteStatus.SELECT },
    });
    await prisma.quote.create({
      data: { queryId, legId: legStaleId, freightForwarderId: ffExpired.id, status: QuoteStatus.EXPIRED },
    });
    await prisma.quote.create({
      data: { queryId, legId: legStaleId, freightForwarderId: ffInvalid.id, status: QuoteStatus.INVALID },
    });
    // S5.9.5 D4's scenario B: quoted -> negotiated -> silent -> swept, with the submitted price
    // KEPT. Same status as legStaleId's expired quote; the ONLY difference is the draft.
    await prisma.quote.create({
      data: {
        queryId,
        legId: legExpiredPricedId,
        freightForwarderId: ffExpiredPriced.id,
        status: QuoteStatus.EXPIRED,
        draftJson: { legId: legExpiredPricedId, chargedWeightKg: 500 },
      },
    });
  });

  afterAll(async () => {
    await prisma.quote.deleteMany({ where: { queryId } }).catch(() => {});
    await prisma.freightForwarder.deleteMany({ where: { id: { in: ffIds } } }).catch(() => {});
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } }); // cascades legs
    await moduleRef.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("is true when the scope leg carries an RFQ_SENT quote", async () => {
    await expect(resolver.downstreamWork([{ type: "leg", id: legSentId }])).resolves.toBe(true);
  });

  it("is true when the scope leg carries a QUOTED quote", async () => {
    await expect(resolver.downstreamWork([{ type: "leg", id: legQuotedId }])).resolves.toBe(true);
  });

  it("is false when the scope leg's quotes are only SELECT / unpriced-EXPIRED / INVALID", async () => {
    await expect(resolver.downstreamWork([{ type: "leg", id: legStaleId }])).resolves.toBe(false);
  });

  // S5.9.5 CRITICAL 1 — the two halves of the EXPIRED distinction, side by side. The fixtures
  // differ in exactly one column (`draftJson`), so neither assertion can pass for the other's
  // reason, and dropping the `draftJson` term from LIVE_QUOTE_WHERE reddens the one above while
  // dropping the EXPIRED arm altogether reddens the one below.
  it("is TRUE when the scope leg's only quote is an EXPIRED one that still carries a submitted price", async () => {
    await expect(resolver.downstreamWork([{ type: "leg", id: legExpiredPricedId }])).resolves.toBe(
      true,
    );
  });

  it("is false for a non-leg scope, even carrying the id of a live-quoted leg", async () => {
    await expect(resolver.downstreamWork([{ type: "point", id: legSentId }])).resolves.toBe(false);
  });

  it("is false for an empty scope", async () => {
    await expect(resolver.downstreamWork([])).resolves.toBe(false);
  });

  it("is false for a lone malformed (non-UUID) leg id", async () => {
    await expect(resolver.downstreamWork([{ type: "leg", id: "not-a-uuid" }])).resolves.toBe(false);
  });

  it("a malformed leg id in the batch doesn't poison the other, valid legs (Postgres casts legId IN (...) as one uuid[] literal — one bad id must not drop real live-quote hits)", async () => {
    await expect(
      resolver.downstreamWork([
        { type: "leg", id: legSentId },
        { type: "leg", id: "not-a-uuid" },
      ]),
    ).resolves.toBe(true);
  });
});
