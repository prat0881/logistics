process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { Test, type TestingModule } from "@nestjs/testing";
import { QuoteStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ScopeResolver } from "../src/modules/changes/scope.resolver";
import { ffFixture } from "./helpers/freight-forwarder";

const PFX = "p9-downstream-work-";

// SB6 (Task 3): downstreamWork(scope) arms the change-order fork (design doc §7.3/§11.2) —
// TRUE iff a Quote on a scope-leg is "live" (`LIVE_QUOTE_WHERE`, changes/live-quotes.ts). A
// pre-RFQ SELECT quote, or an already-invalidated INVALID one, does NOT count.
//
// CORRECTED (S5.9.5 final whole-branch review, CRITICAL 1) — this used to say EXPIRED does not
// count either, full stop. That is only true of an expired quote that carries no SUBMITTED price.
// A quote expiring out of REQUOTED has already submitted one, and such an offer is comparable,
// rankable, sendable and approvable, so it IS live. All three directions are pinned below, and
// the change-order cascade end of the same distinction is pinned by
// `change-order-apply.e2e-spec.ts`.
//
// UPDATED S5.9.6 (register A6) — the discriminator moved from `draftJson` to `submittedJson`,
// which added a THIRD case that did not previously exist as a distinct shape: an EXPIRED quote
// holding a `draftJson` but NO `submittedJson`, i.e. an abandoned half-edit saved into a reopened
// portal by a forwarder who never submitted it. It shows no offer anywhere on the compare screen,
// so it is not a commitment and must free-path. `legExpiredScratchOnlyId` pins it.
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
  let legExpiredScratchOnlyId: string;
  const ffIds: string[] = [];

  async function mkFf(code: string) {
    const ff = await prisma.freightForwarder.create({
      data: ffFixture({
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "PIC",
        contactNumber: "+10000000000",
        email: `${code}@e2e.test`,
        availableCountries: ["IN"],
        modes: ["ROAD"],
        handleDg: false,
      }),
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
    legExpiredScratchOnlyId = (
      await prisma.leg.create({ data: { queryId, legCode: "L-EXP-SCRATCH" } })
    ).id;

    // A quote requires a real FreightForwarder (hard FK, onDelete: Restrict) and the
    // (legId, freightForwarderId) pair is unique, so each quote below gets its own FF.
    const ffSent = await mkFf(`${PFX}ff-sent`);
    const ffQuoted = await mkFf(`${PFX}ff-quoted`);
    const ffSelect = await mkFf(`${PFX}ff-select`);
    const ffExpired = await mkFf(`${PFX}ff-expired`);
    const ffInvalid = await mkFf(`${PFX}ff-invalid`);
    const ffExpiredPriced = await mkFf(`${PFX}ff-exp-priced`);
    const ffExpiredScratch = await mkFf(`${PFX}ff-exp-scratch`);

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
    // KEPT. The real post-sweep shape, so BOTH columns are set exactly as `submit` left them:
    // `submittedJson` is the offer, `draftJson` the scratchpad the sweep does not discard for a
    // REQUOTED quote (it pre-fills the portal if the forwarder is asked again).
    await prisma.quote.create({
      data: {
        queryId,
        legId: legExpiredPricedId,
        freightForwarderId: ffExpiredPriced.id,
        status: QuoteStatus.EXPIRED,
        submittedAt: new Date(),
        draftJson: { legId: legExpiredPricedId, chargedWeightKg: 500 },
        submittedJson: { legId: legExpiredPricedId, chargedWeightKg: 500 },
      },
    });
    // S5.9.6 (A6): the shape that made the split necessary — a forwarder who was asked to re-quote,
    // typed into the reopened portal, hit Save draft, and went silent. It also differs from the
    // fixture above in `submittedAt` (a never-submitted row must not carry one), but of the only
    // two columns `LIVE_QUOTE_WHERE` reads — `status` and `submittedJson` — it shares the first and
    // differs in the second, so the two assertions cannot pass for each other's reason. They never
    // offered this number, so it is not a commercial commitment.
    await prisma.quote.create({
      data: {
        queryId,
        legId: legExpiredScratchOnlyId,
        freightForwarderId: ffExpiredScratch.id,
        status: QuoteStatus.EXPIRED,
        draftJson: { legId: legExpiredScratchOnlyId, chargedWeightKg: 500 },
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

  // S5.9.5 CRITICAL 1 / S5.9.6 A6 — the halves of the EXPIRED distinction, side by side. Of the
  // only two columns LIVE_QUOTE_WHERE reads, the two fixtures share `status` and differ in
  // `submittedJson` (they also differ in `submittedAt`, which the predicate does not read), so
  // neither assertion can pass for the other's reason: dropping the EXPIRED arm from
  // LIVE_QUOTE_WHERE reddens the first, and re-keying that arm on `draftJson` (as it was before
  // S5.9.6) reddens the second.
  it("is TRUE when the scope leg's only quote is an EXPIRED one that still carries a submitted price", async () => {
    await expect(resolver.downstreamWork([{ type: "leg", id: legExpiredPricedId }])).resolves.toBe(
      true,
    );
  });

  it("S5.9.6 (A6) — is FALSE when the EXPIRED quote carries only an abandoned scratchpad and no submitted price", async () => {
    await expect(
      resolver.downstreamWork([{ type: "leg", id: legExpiredScratchOnlyId }]),
    ).resolves.toBe(false);
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
