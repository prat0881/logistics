process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import { QuoteEvent, Role, ACCESS_TOKEN_COOKIE, type QuoteDraft } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { StatusService } from "../src/modules/status/status.service";
import { seedReferenceData } from "../src/seed/reference-seed";

// S5.9.2 Task 1 (Q1/Q2/Q3, register C7) — a re-quote must WALK THE LEG BACKWARDS to the status
// its quotes actually justify, and the query must follow.
//
// Before this task, asking a forwarder to sharpen a price moved nothing: `rollupLegTarget`
// already excluded REQUOTED from LEG_ROLLUP_RESOLVED (so it already returned PARTIALLY_QUOTED or
// null for a re-quoted leg), but `LegQuoteProjector.recomputeLeg`'s never-walk-backwards backstop
// (`leg.status === RFQ_SENT`) discarded that answer — the leg kept reading "Fully Quoted" and the
// query "Quoted" while we were in fact waiting on a forwarder again.
//
// The second half of this file is the guard interaction Q1 breaks. A leg sent via A9's "proceed
// without waiting" hatch used to leave FULLY_QUOTED, which `approve()` reads back off the
// immutable StatusTransition row as its "the leg held FULLY_QUOTED" term. After Q1 the same leg
// leaves PARTIALLY_QUOTED, so that term stops covering the case and approve would 409 forever —
// exactly the Critical the last whole-branch review found.
//
// CORRECTED (review round 2 — NEW-2): this preamble used to stop there, describing Q3's original,
// narrower repair ("a THIRD term: the send was an explicit, recorded proceed-without-waiting
// override") and naming `legStatusWhenSentForApproval`, a method that no longer exists. The tests
// directly beneath it had already outgrown both. The rule they actually pin is:
//
//   **A leg is approvable iff it is fully quoted, OR its send was legally permitted.**
//
// `sendForApproval` records WHICH arm of A3 permitted a send from a leg that was NOT FULLY_QUOTED
// — A9's arm keeps the exec's own `proceedReason`, the deadline-passed arm gets a fixed sentence
// — as the `reason` on the send's own leg transition row, read back by `latestSendForApproval`.
// Non-null exactly when the leg was not FULLY_QUOTED, which is what makes the invariant total.
// The first review round found the deadline-passed arm still wedged (a legally-sent leg that
// could never be approved, and that reject/re-send could not free either); "(k)" is that case.
//
// The permission is deliberately NOT part of `isFullyQuotedForDecision`, because reject() uses
// that predicate to pick its return target and must still return a fallen-back leg to
// PARTIALLY_QUOTED, never a promoted FULLY_QUOTED — "(e)". And it is narrow: a PENDING_APPROVAL
// that never passed A3 has no row and no permission — "(m)" — and a row that carries no recorded
// permission is not one merely by existing — "(o)".
const PREFIX = "AWRF";
const CODE = `YAL00-${PREFIX}`;

type FfSpec = {
  key: string;
  status: "QUOTED" | "RFQ_SENT" | "REQUOTED" | "APPROVED" | "PENDING_APPROVAL";
  deadline?: Date;
  draft?: { amount: number; transitDays: number };
};

describe(`${PREFIX} — a re-quote walks the leg back (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let status: StatusService;

  const cookieFor = (userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role: Role.EXECUTIVE, tenantId: null })}`;
  const managerCookieFor = (userId: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role: Role.MANAGER, tenantId: null })}`;

  const future = () => new Date(Date.now() + 86400000);

  const mkFf = (code: string) =>
    prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `${code.toLowerCase()}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        handleDg: false,
        status: "ACTIVE",
      },
    });

  // Minimal ROAD draft, priced only on DEDICATED — same shape as
  // award-workflow-maker.e2e-spec.ts, so computeQuoteTotals yields exactly one comparable offer.
  const roadDraft = (
    legId: string,
    originPointId: string,
    amount: number,
    transitDays: number,
  ): QuoteDraft => ({
    legId,
    mode: "ROAD",
    currency: "INR",
    quoteValidityUntil: "2099-01-01T00:00:00.000Z",
    chargedWeightKg: 500,
    notes: null,
    cargo: [],
    charges: [],
    trucking: [
      {
        legEndpointPointId: originPointId,
        truckingType: "DEDICATED",
        basis: "FIXED",
        amount,
        rateVariant: "DEDICATED",
        tonnage: null,
      },
    ],
    seaRates: [],
    warehouse: [],
    transit: {
      departureDate: null,
      arrivalDate: null,
      guaranteedTransitDaysByVariant: { DEDICATED: transitDays },
    },
    dgSurchargeNote: null,
    termsConditions: null,
  });

  async function seedLeg(
    label: string,
    legStatus: string,
    ffs: FfSpec[],
    opts: { decisionStatus?: "DRAFT" | "PENDING_APPROVAL" | "APPROVED"; shortlistKey?: string } = {},
  ) {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-${label}`, priority: "HIGH", incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", city: "Shanghai", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", city: "Dubai", country: "AE" },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L1",
        mode: "ROAD",
        originPointId: origin.id,
        destinationPointId: dest.id,
        status: legStatus as never,
      },
    });

    const quotes: Record<string, { id: string; ffId: string; rfqId: string }> = {};
    for (const ff of ffs) {
      const ffRow = await mkFf(`FF-${PREFIX}-${label}-${ff.key}`);
      const rfq = await prisma.rfq.create({
        data: {
          queryId: query.id,
          freightForwarderId: ffRow.id,
          rfqNumber: `${CODE}-RFQ-${label}-${ff.key}`,
          accessTokenHash: `hash-${PREFIX}-${label}-${ff.key}`,
          submissionDeadline: ff.deadline ?? future(),
          incoterms: "FOB",
          currency: "INR",
          quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
        },
      });
      const quote = await prisma.quote.create({
        data: {
          queryId: query.id,
          legId: leg.id,
          freightForwarderId: ffRow.id,
          rfqId: rfq.id,
          status: ff.status as never,
          ...(ff.draft
            ? {
                submittedAt: new Date(),
                draftJson: roadDraft(
                  leg.id,
                  origin.id,
                  ff.draft.amount,
                  ff.draft.transitDays,
                ) as unknown as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
      quotes[ff.key] = { id: quote.id, ffId: ffRow.id, rfqId: rfq.id };
    }

    if (opts.decisionStatus) {
      await prisma.legAwardDecision.create({
        data: {
          legId: leg.id,
          queryId: query.id,
          shortlistedQuoteId: opts.shortlistKey ? quotes[opts.shortlistKey].id : null,
          shortlistedVariant: opts.shortlistKey ? "DEDICATED" : null,
          status: opts.decisionStatus,
          sentByUserId: randomUUID(),
          ...(opts.decisionStatus === "PENDING_APPROVAL" || opts.decisionStatus === "APPROVED"
            ? { sentForApprovalAt: new Date() }
            : {}),
          ...(opts.decisionStatus === "APPROVED"
            ? { decidedByUserId: randomUUID(), decidedAt: new Date() }
            : {}),
        },
      });
    }

    return { query, leg, origin, dest, quotes };
  }

  const requote = (queryId: string, legId: string, quoteId: string, userId = randomUUID()) =>
    request(app.getHttpServer())
      .post(`/api/queries/${queryId}/legs/${legId}/quotes/${quoteId}/request-requote`)
      .set("Cookie", cookieFor(userId))
      .send({ comment: "Please sharpen this rate" });

  const legStatus = async (legId: string) =>
    (await prisma.leg.findUniqueOrThrow({ where: { id: legId } })).status;
  const queryStatus = async (queryId: string) =>
    (await prisma.query.findUniqueOrThrow({ where: { id: queryId } })).status;

  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    const qIds = qs.map((q) => q.id);
    const legs = await prisma.leg.findMany({
      where: { queryId: { in: qIds } },
      select: { id: true },
    });
    const legIds = legs.map((l) => l.id);
    const quoteRows = await prisma.quote.findMany({
      where: { queryId: { in: qIds } },
      select: { id: true },
    });
    const rfqs = await prisma.rfq.findMany({
      where: { queryId: { in: qIds } },
      select: { id: true },
    });
    const rfqIds = rfqs.map((r) => r.id);
    if (rfqIds.length) {
      await prisma.scheduledEvent.deleteMany({
        where: { entityType: "RFQ", entityId: { in: rfqIds } },
      });
      await prisma.messageLog.deleteMany({ where: { entityType: "RFQ", entityId: { in: rfqIds } } });
    }
    // StatusTransition has no FK — the Query cascade never touches it (see
    // leg-rollup-approved.e2e-spec.ts's cleanup for the same sweep).
    await prisma.statusTransition.deleteMany({
      where: {
        OR: [
          { entity: "leg", entityId: { in: legIds } },
          { entity: "quote", entityId: { in: quoteRows.map((q) => q.id) } },
        ],
      },
    });
    await prisma.awardDecisionEvent.deleteMany({ where: { legId: { in: legIds } } });
    await prisma.legAwardDecision.deleteMany({ where: { legId: { in: legIds } } });
    await prisma.quote.deleteMany({ where: { queryId: { in: qIds } } });
    await prisma.rfqTokenReissue.deleteMany({ where: { rfqId: { in: rfqIds } } });
    await prisma.rfq.deleteMany({ where: { queryId: { in: qIds } } });
    for (const id of qIds) {
      await prisma.query.delete({ where: { id } }); // cascades points/legs
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } },
    });
    await prisma.fxRate.deleteMany({ where: { note: { startsWith: PREFIX } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    status = moduleRef.get(StatusService);
    await seedReferenceData(prisma);
    await cleanup();
    await prisma.fxRate.create({ data: { currency: "INR", unitsPerUsd: 83.2, note: PREFIX } });
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  // ── Q1/Q2: the fallback itself ────────────────────────────────────────────────────────────

  it("(a) a re-quote with a still-QUOTED sibling walks the leg FULLY_QUOTED -> PARTIALLY_QUOTED, and the query to RFQ_SENT", async () => {
    const { query, leg, quotes } = await seedLeg("a", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "QUOTED", draft: { amount: 90000, transitDays: 4 } },
    ]);
    // Baseline — the query only reaches QUOTED once something recomputes it; drive that off the
    // real projector rather than asserting a seeded value.
    await requote(query.id, leg.id, quotes.REQ.id).expect(200);

    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");
    // Q2 — no query-side change was needed: deriveQueryStatus already maps PARTIALLY_QUOTED to
    // QueryStatus.RFQ_SENT, and query status is a projection off the leg rollup.
    expect(await queryStatus(query.id)).toBe("RFQ_SENT");
  });

  it("(b) a re-quote on a leg whose ONLY quote was re-quoted walks it FULLY_QUOTED -> RFQ_SENT, query RFQ_SENT", async () => {
    const { query, leg, quotes } = await seedLeg("b", "FULLY_QUOTED", [
      { key: "ONLY", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
    ]);

    await requote(query.id, leg.id, quotes.ONLY.id).expect(200);

    // rollupLegTarget([REQUOTED]) is `null` ("nothing to say"), NOT RFQ_SENT — the projector maps
    // "a re-quote left nothing comparable" onto RFQ_SENT itself.
    expect(await legStatus(leg.id)).toBe("RFQ_SENT");
    expect(await queryStatus(query.id)).toBe("RFQ_SENT");
  });

  it("(h) a re-quote on the ONLY comparable offer of an already-PARTIALLY_QUOTED leg walks it to RFQ_SENT", async () => {
    // Reachable and distinct from (b): a leg that never reached FULLY_QUOTED because one FF has
    // not answered. Re-quoting its single QUOTED offer leaves nothing comparable at all.
    const { query, leg, quotes } = await seedLeg("h", "PARTIALLY_QUOTED", [
      { key: "REQ", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "SILENT", status: "RFQ_SENT" },
    ]);

    await requote(query.id, leg.id, quotes.REQ.id).expect(200);

    expect(await legStatus(leg.id)).toBe("RFQ_SENT");
    expect(await queryStatus(query.id)).toBe("RFQ_SENT");
  });

  it("(i) a re-quote against an APPROVED leg walks it past FULLY_QUOTED, all the way back to RFQ_SENT", async () => {
    // The APPROVED path is NegotiationService's own: LegQuoteProjector's ROLLUP_FROZEN guard
    // skips a leg in APPROVED, so the quote fire cannot move it; `requestRequote` fires
    // REOPEN_AWARD (APPROVED -> FULLY_QUOTED) and then owns recomputing the rollup, exactly as
    // leg-quote.projector.ts's "unfreeze gap" note says the caller must. Without that second
    // step the leg would sit at FULLY_QUOTED with a REQUOTED-only quote set — the very C7
    // mismatch Q1 removes, just reached via a different door.
    //
    // AMENDED (S5.9.5 task-10 review round 1). The decision was `APPROVED` here, which the new D1
    // guard in `requestRequote` now refuses outright — an Executive may no longer reverse an
    // approval through this endpoint. That makes `wasApproved` (which reads `leg.status`, not the
    // decision) reachable ONLY from a drifted row: `approve()`/`reject()` each commit their
    // decision write before firing the leg transition, so a failure in that window leaves
    // `leg.status = APPROVED` under a `DRAFT` decision. That is the shape seeded below, and it is
    // the only shape the retained branch still serves — so this test now covers exactly what the
    // branch is kept for, rather than a path the server refuses. The quote stays `APPROVED` for
    // the same reason (`REQUOTABLE_STATUSES` retains it for this identical drift case), and every
    // assertion is unchanged.
    const { query, leg, quotes } = await seedLeg(
      "i",
      "APPROVED",
      [{ key: "WIN", status: "APPROVED", draft: { amount: 83200, transitDays: 3 } }],
      { decisionStatus: "DRAFT", shortlistKey: "WIN" },
    );

    await requote(query.id, leg.id, quotes.WIN.id).expect(200);

    expect(await legStatus(leg.id)).toBe("RFQ_SENT");
    expect(await queryStatus(query.id)).toBe("RFQ_SENT");
  });

  it("(g) the re-quoted forwarder re-submitting rolls the leg forward to FULLY_QUOTED again, query QUOTED", async () => {
    const { query, leg, quotes } = await seedLeg("g", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "QUOTED", draft: { amount: 90000, transitDays: 4 } },
    ]);

    await requote(query.id, leg.id, quotes.REQ.id).expect(200);
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");

    // REQUOTED --submit--> QUOTED is exactly what the forwarder portal fires on a re-submission
    // (ff-portal.service.ts) — driven directly here so the test does not depend on the portal's
    // whole draft-validation surface.
    await status.fire("quote", quotes.REQ.id, QuoteEvent.SUBMIT, { queryId: query.id });

    expect(await legStatus(leg.id)).toBe("FULLY_QUOTED");
    expect(await queryStatus(query.id)).toBe("QUOTED");
  });

  // ── The narrowness of the backstop relaxation ─────────────────────────────────────────────

  it("(j) NOTHING but a re-quote may walk a leg backwards — a straggler submitting on a FULLY_QUOTED leg that already holds a REQUOTED sibling leaves the leg exactly where it is", async () => {
    // This is the mutation discriminator for Step 4's narrowing. The leg's quotes justify only
    // PARTIALLY_QUOTED (rollupLegTarget([QUOTED, REQUOTED, QUOTED]) === PARTIALLY_QUOTED), and
    // the recompute is triggered by a quote.status.changed event — but that event is a SUBMIT,
    // not a re-quote, so the never-walk-backwards backstop must still discard the answer. Drop
    // the "was this recompute triggered by a re-quote?" condition and this leg falls to
    // PARTIALLY_QUOTED and the test goes red.
    const { query, leg, quotes } = await seedLeg("j", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "STALE", status: "REQUOTED", draft: { amount: 90000, transitDays: 4 } },
      { key: "LATE", status: "RFQ_SENT" },
    ]);

    await status.fire("quote", quotes.LATE.id, QuoteEvent.SUBMIT, { queryId: query.id });

    expect(await legStatus(leg.id)).toBe("FULLY_QUOTED");
  });

  // ── Q3: the send/approve/reject guard interaction ─────────────────────────────────────────

  it("(f) without the explicit override, sending a fallen-back leg is still refused and nothing is persisted", async () => {
    const { query, leg, quotes } = await seedLeg("f", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "QUOTED", draft: { amount: 90000, transitDays: 4 } },
    ]);
    await requote(query.id, leg.id, quotes.REQ.id).expect(200);
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({ quoteId: quotes.KEEP.id, variant: "DEDICATED" })
      .expect(400);

    expect(await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } })).toBeNull();
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: quotes.KEEP.id } })).status,
    ).toBe("QUOTED");
  });

  it("(c)+(d) an exec may still send a fallen-back leg with proceedWithoutWaiting + reason, and a checker can then APPROVE it", async () => {
    const { query, leg, quotes } = await seedLeg("cd", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "QUOTED", draft: { amount: 90000, transitDays: 4 } },
    ]);
    await requote(query.id, leg.id, quotes.REQ.id).expect(200);
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");

    const senderId = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId))
      .send({
        quoteId: quotes.KEEP.id,
        variant: "DEDICATED",
        proceedWithoutWaiting: true,
        proceedReason: "Client needs the number today",
      })
      .expect(200);

    expect(await legStatus(leg.id)).toBe("PENDING_APPROVAL");

    // The leg LEFT PARTIALLY_QUOTED, not FULLY_QUOTED — so approve()'s transition-log term is
    // false here and only the recorded override keeps this approval reachable.
    const sendRow = await prisma.statusTransition.findFirst({
      where: { entity: "leg", entityId: leg.id, to: "PENDING_APPROVAL" },
      orderBy: { seq: "desc" },
    });
    expect(sendRow?.from).toBe("PARTIALLY_QUOTED");

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", managerCookieFor(randomUUID())) // four-eyes: not senderId
      .send()
      .expect(200);

    expect(await legStatus(leg.id)).toBe("APPROVED");
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: quotes.KEEP.id } })).status,
    ).toBe("APPROVED");
    // A9 licensed proceeding PAST the re-quote, not resolving it.
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: quotes.REQ.id } })).status,
    ).toBe("REQUOTED");
  });

  it("(e) rejecting an override-sent leg returns it to PARTIALLY_QUOTED, NOT a promoted FULLY_QUOTED", async () => {
    const { query, leg, quotes } = await seedLeg("e", "FULLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "QUOTED", draft: { amount: 90000, transitDays: 4 } },
    ]);
    await requote(query.id, leg.id, quotes.REQ.id).expect(200);

    const senderId = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId))
      .send({
        quoteId: quotes.KEEP.id,
        variant: "DEDICATED",
        proceedWithoutWaiting: true,
        proceedReason: "Client needs the number today",
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", managerCookieFor(randomUUID()))
      .send({ reason: "Let's see what the re-quote comes back with" })
      .expect(200);

    // reject() asks `isFullyQuotedForDecision`, which the Q3 override term is deliberately kept
    // OUT of: both of its terms are false here (live rollup is null, the leg left
    // PARTIALLY_QUOTED), so the leg returns to PARTIALLY_QUOTED. Adding the override term to the
    // shared predicate would promote it to FULLY_QUOTED and leak back the very mismatch Q1
    // removes.
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");
    expect(await queryStatus(query.id)).toBe("RFQ_SENT");
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: quotes.KEEP.id } })).status,
    ).toBe("QUOTED");
    const decision = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: leg.id } });
    expect(decision.status).toBe("DRAFT");

    // …and the recovery path still works: the maker can re-send with a fresh override.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({
        quoteId: quotes.KEEP.id,
        variant: "DEDICATED",
        proceedWithoutWaiting: true,
        proceedReason: "Still cannot wait — re-sending after the rejection",
      })
      .expect(200);
  });

  it("(k) INVARIANT — a legally-permitted send is APPROVABLE: the A3 deadline-passed arm reaches approval, and reject/re-send/approve is no longer an infinite loop", async () => {
    // Task-1 review, IMPORTANT 1. The reviewer's live repro, verbatim: FF-A QUOTED with a closed
    // window; FF-B never answered and its window has closed too, but the expiry sweep has not run,
    // so its quote is still RFQ_SENT. A3's deadline-passed arm legitimately permits the send —
    // and approve() then 409'd forever, because `rollupLegTarget([PENDING_APPROVAL, RFQ_SENT])` is
    // `null` and the transition log says PARTIALLY_QUOTED. Nothing inside the product broke the
    // loop: reject recovered the leg, the re-send succeeded, approve 409'd again. Only the expiry
    // cron could (and for an INVALID sibling, nothing could — INVALID has no `expire` edge).
    //
    // This test asserts the closed invariant AND that the loop is genuinely broken, by walking the
    // full reject -> re-send -> approve cycle the old bug span.
    const past = new Date(Date.now() - 3600000);
    const { query, leg, quotes } = await seedLeg("k", "PARTIALLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", deadline: past, draft: { amount: 83200, transitDays: 3 } },
      { key: "SILENT", status: "RFQ_SENT", deadline: past },
    ]);

    const senderId = randomUUID();
    const send = () =>
      request(app.getHttpServer())
        .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
        .set("Cookie", cookieFor(senderId))
        .send({ quoteId: quotes.KEEP.id, variant: "DEDICATED" });

    await send().expect(200);

    // The send recorded WHY it was permitted, on its own transition row — the fact approve() reads
    // back, and the one approve() cannot re-derive later.
    const sendRow = await prisma.statusTransition.findFirst({
      where: { entity: "leg", entityId: leg.id, event: "send_for_approval", to: "PENDING_APPROVAL" },
      orderBy: { seq: "desc" },
    });
    expect(sendRow?.from).toBe("PARTIALLY_QUOTED");
    expect(sendRow?.reason).toBe("All outstanding RFQ windows had closed at send time");

    // Reject first — proving the recovery path Task 2 relies on still works, and that a fresh send
    // re-records its own permission rather than inheriting the old row.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", managerCookieFor(randomUUID()))
      .send({ reason: "Second opinion first" })
      .expect(200);
    // reject() asks the FACT predicate alone, so it lands on the status the leg actually held.
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");

    await send().expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", managerCookieFor(randomUUID())) // four-eyes: not senderId
      .send()
      .expect(200);

    expect(await legStatus(leg.id)).toBe("APPROVED");
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: quotes.KEEP.id } })).status,
    ).toBe("APPROVED");
    // The silent forwarder is untouched — approval closed out the leg, it did not resolve them.
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: quotes.SILENT.id } })).status,
    ).toBe("RFQ_SENT");
  });

  it("(m) NARROWNESS — a PENDING_APPROVAL that never went through the send guard carries no permission and is still refused", async () => {
    // The counterpart to (k), and what stops "a legally-permitted send is approvable" collapsing
    // into "anything at PENDING_APPROVAL is approvable". This decision and leg status are written
    // straight into the DB — a fixture, a legacy row from before the transition log, or some
    // future path that reaches PENDING_APPROVAL without A3 — so there is NO send_for_approval
    // transition row and therefore no recorded permission. Meanwhile a forwarder's window is
    // genuinely still open, so the leg is not fully quoted by any measure. approve() must refuse.
    //
    // Mutation discriminator: treat an ABSENT send row as licence — gate approve()'s refusal on
    // `sent.from != null`, i.e. "only refuse legs that actually went through a send" — or drop the
    // FULLY_QUOTED question entirely, and this goes green when it must not. Both verified against
    // the running app.
    //
    // CORRECTED (final whole-branch review) — this line used to name "key the permission off
    // `from != null` (a send row exists)" as the discriminator. It is not one HERE: this fixture
    // has no `send_for_approval` row at all (asserted immediately below), so `from` is null under
    // that mutation too, the permission stays null, and approve 409s either way — the test cannot
    // tell. That discriminator belongs to **(o)**, which seeds a row that exists carrying
    // `reason: null`. Both directions were re-run before this rewrite rather than reasoned about:
    // minting a permission from row existence leaves (m) green and reddens (o); gating the refusal
    // on row existence reddens (m) and leaves (o) green.
    const { query, leg } = await seedLeg(
      "m",
      "PENDING_APPROVAL",
      [
        { key: "WIN", status: "PENDING_APPROVAL", draft: { amount: 83200, transitDays: 3 } },
        { key: "OPEN", status: "RFQ_SENT", deadline: future() },
      ],
      { decisionStatus: "PENDING_APPROVAL", shortlistKey: "WIN" },
    );

    // No send row exists at all — the state was fabricated, not earned.
    expect(
      await prisma.statusTransition.findFirst({
        where: { entity: "leg", entityId: leg.id, event: "send_for_approval" },
      }),
    ).toBeNull();

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", managerCookieFor(randomUUID()))
      .send()
      .expect(409);

    expect(await legStatus(leg.id)).toBe("PENDING_APPROVAL");
  });

  it("(o) NARROWNESS — a send row that carries NO recorded permission does not become one just by existing; reject + re-send is the recovery", async () => {
    // The discriminator between "the send recorded a permission" and the weaker "a send row
    // exists". It is not contrived: this is exactly the shape of an IN-FLIGHT row from before this
    // change shipped — a leg sent through A3's deadline arm whose transition row predates the
    // marker, so `from = PARTIALLY_QUOTED` with `reason = null`. Approving it on the strength of
    // the row's mere existence would approve a leg no guard ever recorded a verdict for; it stays
    // refused, which is the pre-existing conservative behaviour.
    //
    // It then walks the recovery, which is the migration path for any such row still in flight at
    // deploy: reject (always possible) -> re-send (records a real permission) -> approve.
    const past = new Date(Date.now() - 3600000);
    const { query, leg, quotes } = await seedLeg(
      "o",
      "PENDING_APPROVAL",
      [
        { key: "WIN", status: "PENDING_APPROVAL", deadline: past, draft: { amount: 83200, transitDays: 3 } },
        { key: "SILENT", status: "RFQ_SENT", deadline: past },
      ],
      { decisionStatus: "PENDING_APPROVAL", shortlistKey: "WIN" },
    );
    // The pre-marker send row: the edge fired, but nothing recorded WHY it was permitted.
    await prisma.statusTransition.create({
      data: {
        entity: "leg",
        entityId: leg.id,
        from: "PARTIALLY_QUOTED",
        to: "PENDING_APPROVAL",
        event: "send_for_approval",
        reason: null,
      },
    });

    // A LATER row that also lands on PENDING_APPROVAL but was written by some other edge — a
    // hypothetical future contribution onto the leg machine — must not be mistaken for the send's
    // own verdict just because it sorts first by `seq`. This is what the `event` filter in
    // `latestSendForApproval`'s WHERE buys (review MINOR 1); without it, this decoy's `reason` is
    // read as a permission and the approve below returns 200.
    await prisma.statusTransition.create({
      data: {
        entity: "leg",
        entityId: leg.id,
        from: "PARTIALLY_QUOTED",
        to: "PENDING_APPROVAL",
        event: "some.future.edge",
        reason: "not a send-for-approval verdict",
      },
    });

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", managerCookieFor(randomUUID()))
      .send()
      .expect(409);
    expect(await legStatus(leg.id)).toBe("PENDING_APPROVAL");

    // Recovery: reject returns the leg to what it actually held…
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/reject`)
      .set("Cookie", managerCookieFor(randomUUID()))
      .send({ reason: "Re-send so the permission is on record" })
      .expect(200);
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");

    // …and a fresh send records its own permission, after which approval goes through.
    const senderId = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(senderId))
      .send({ quoteId: quotes.WIN.id, variant: "DEDICATED" })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/approve`)
      .set("Cookie", managerCookieFor(randomUUID()))
      .send()
      .expect(200);
    expect(await legStatus(leg.id)).toBe("APPROVED");
  });

  it("(n) a send from a genuinely FULLY_QUOTED leg records NO permission — the marker is written iff A3 had to permit something", async () => {
    // Pins the construction the invariant rests on: `reason` is non-null EXACTLY when the leg was
    // not FULLY_QUOTED at send time. Without this, writing the permission unconditionally would go
    // unnoticed, and "a legally-permitted send is approvable" would quietly become "any send is",
    // with the FULLY_QUOTED question dead code. A gratuitous `proceedWithoutWaiting` on a leg with
    // nothing outstanding must not mint one either.
    const { query, leg, quotes } = await seedLeg("n", "FULLY_QUOTED", [
      { key: "ONLY", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({
        quoteId: quotes.ONLY.id,
        variant: "DEDICATED",
        proceedWithoutWaiting: true,
        proceedReason: "belt and braces, though nothing is outstanding",
      })
      .expect(200);

    const sendRow = await prisma.statusTransition.findFirst({
      where: { entity: "leg", entityId: leg.id, event: "send_for_approval", to: "PENDING_APPROVAL" },
      orderBy: { seq: "desc" },
    });
    expect(sendRow?.from).toBe("FULLY_QUOTED");
    expect(sendRow?.reason).toBeNull();
  });

  it("(l) the override waives ONLY the re-quotes — an open RFQ window on a THIRD forwarder still refuses the send", async () => {
    // A3's own narrowness. proceedWithoutWaiting is licence to proceed past an in-flight
    // RE-QUOTE (A9), never past a forwarder who simply has not answered yet and whose window is
    // still open. Filter the whole outstanding set on the override instead of just its REQUOTED
    // members and this goes green when it must not.
    const { query, leg, quotes } = await seedLeg("l", "PARTIALLY_QUOTED", [
      { key: "KEEP", status: "QUOTED", draft: { amount: 83200, transitDays: 3 } },
      { key: "REQ", status: "REQUOTED", draft: { amount: 90000, transitDays: 4 } },
      { key: "OPEN", status: "RFQ_SENT", deadline: future() },
    ]);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/send-for-approval`)
      .set("Cookie", cookieFor(randomUUID()))
      .send({
        quoteId: quotes.KEEP.id,
        variant: "DEDICATED",
        proceedWithoutWaiting: true,
        proceedReason: "cannot wait",
      })
      .expect(400);

    expect(await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } })).toBeNull();
    expect(await legStatus(leg.id)).toBe("PARTIALLY_QUOTED");
  });
});
