process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import {
  ACCESS_TOKEN_COOKIE,
  QuoteStatus,
  Role,
  deriveQueryStatus,
  type LegStatus,
  type QuoteDraft,
} from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { PackageService } from "../src/modules/cargo/package.service";
import { seedReferenceData } from "../src/seed/reference-seed";
import type { RequestUser } from "../src/modules/auth/types";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";
import { QUERY_LOCKED_MESSAGE } from "../src/modules/award/query-lock.service";

// S5.5 Task 4 (design §10.2) — the payoff of the change-order reversal loop. A post-RFQ
// change-order field edit that reopens an AWARDED leg must undo the award on it (the leg's
// LegAwardDecision goes back to DRAFT), and if the query had already reached QUOTING_CLIENT (a
// client quote was generated), the frozen Query.awardSnapshot is torn down and the query rolls
// back OUT of QUOTING_CLIENT to its real leg rollup. ChangeOrderStrategy.apply already fires the
// quote INVALIDATE + leg REOPEN transitions and emits "changeorder.leg.reopened" (Task 3 made
// this fire for an APPROVED leg too) — AwardChangeOrderListener (this task) is the consumer that
// reacts to that event and tears down the award-side state those transitions just made stale.
//
// Fixture merges two already-proven shapes rather than inventing a third: the APPROVED-leg
// generate fixture from award-generate.e2e-spec.ts (a LegAwardDecision APPROVED + a draftJson-
// priced Quote so generate-client-quote can actually price it) and the package/cargo change-order
// trigger from change-order-cascade.e2e-spec.ts's "cascades onto an APPROVED quote" test (Task 3)
// — the SAME mediated PackageService.update() boundary the controller uses, not ChangeMediator
// directly.
const PFX = "AWRV";
const CODE = `YAL00-${PFX}`;
const FF_PREFIX = `FF-${PFX}`;

describe("change-order reversal of awards (e2e, design §10.2)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let packageService: PackageService;
  const execId = randomUUID(); // Query.assignedUserId — the IN_APP notification recipient
  const actorUser: RequestUser = { userId: randomUUID(), role: Role.EXECUTIVE, tenantId: null };

  const cookieFor = (userId: string, role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role, tenantId: null })}`;

  const mkFf = (code: string) =>
    prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+10000000000",
        email: `${code.toLowerCase()}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        handleDg: false,
        status: "ACTIVE",
      },
    });

  // Priced only on the DEDICATED variant — same minimal shape award-generate.e2e-spec.ts uses so
  // computeQuoteTotals (generateClientQuote) produces exactly one comparable (nativeTotal,
  // transitDays) pair. Currency USD so toUsd() passes the amount through unconditionally — no
  // FxRate fixture row needed (fx.ts: `if (currency === "USD") return amount;`).
  const roadDraft = (
    legId: string,
    originPointId: string,
    amountUsd: number,
    transitDays: number,
  ): QuoteDraft => ({
    legId,
    mode: "ROAD",
    currency: "USD",
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
        amount: amountUsd,
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

  const future = () => new Date(Date.now() + 86400000);

  // One leg, fully wired for BOTH halves of the story: an APPROVED award (decision + quote with
  // a priced draftJson, so generate-client-quote can price it) AND a package assigned to it (so
  // a change-order edit on that package fans out to this leg — impact.classifier.ts's package
  // case, proven by change-order-cascade.e2e-spec.ts). recommendedQuoteId/recommendedVariant/
  // overrideReason are seeded to a NON-null sentinel (unlike award-generate.e2e-spec.ts's
  // fixture, which leaves them null) specifically so the test can prove the listener leaves them
  // alone — the brief: "re-derived on the next shortlist", not this reversal's job.
  async function seedAwardedLeg(queryId: string, label: string, amountUsd: number, transitDays: number) {
    const origin = await prisma.point.create({
      data: { queryId, type: "PICKUP", city: "Shanghai", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId, type: "DELIVERY", city: "Dubai", country: "AE" },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId,
        legCode: label,
        mode: "ROAD",
        originPointId: origin.id,
        destinationPointId: dest.id,
        status: "APPROVED",
      },
    });
    const { cargoId, packageIds } = await createCargoWithPackages(prisma, {
      queryId,
      packages: [{ packageNo: `PK-${label}`, dimL: 10, dimW: 10, dimH: 10, grossWt: 120 }],
    });
    const pkgId = packageIds[0];
    await assignPackagesToLeg(prisma, leg.id, [pkgId]);

    const ff = await mkFf(`${FF_PREFIX}-${label}`);
    const rfq = await prisma.rfq.create({
      data: {
        queryId,
        freightForwarderId: ff.id,
        rfqNumber: `${CODE}-RFQ-${label}`,
        accessTokenHash: `hash-${PFX}-${label}`,
        submissionDeadline: future(),
        incoterms: "FOB",
        currency: "USD",
        quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    const quote = await prisma.quote.create({
      data: {
        queryId,
        legId: leg.id,
        freightForwarderId: ff.id,
        rfqId: rfq.id,
        status: QuoteStatus.APPROVED,
        submittedAt: new Date(),
        draftJson: roadDraft(
          leg.id,
          origin.id,
          amountUsd,
          transitDays,
        ) as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.legAwardDecision.create({
      data: {
        legId: leg.id,
        queryId,
        shortlistedQuoteId: quote.id,
        shortlistedVariant: "DEDICATED",
        recommendedQuoteId: quote.id,
        recommendedVariant: "DEDICATED",
        overrideReason: "pre-existing override reason — must survive the reversal untouched",
        status: "APPROVED",
        sentByUserId: randomUUID(),
        sentForApprovalAt: new Date(),
        decidedByUserId: randomUUID(),
        decidedAt: new Date(),
      },
    });

    return { leg, cargoId, pkgId, ff, rfq, quote };
  }

  // Explicit staged deletes (not relying purely on Query's cascade) — mirrors the union of
  // award-generate.e2e-spec.ts's + change-order-cascade.e2e-spec.ts's cleanup ordering. quote
  // before rfq before query frees the FF's Restrict FKs; messageLog/notification have no FK to
  // Query (loose entityId/recipientUserId) so they need an explicit sweep regardless.
  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    const qIds = qs.map((q) => q.id);
    await prisma.messageLog.deleteMany({ where: { entityType: "QUERY", entityId: { in: qIds } } });
    await prisma.notification.deleteMany({ where: { recipientUserId: execId } });
    const legs = await prisma.leg.findMany({ where: { queryId: { in: qIds } }, select: { id: true } });
    const legIds = legs.map((l) => l.id);
    await prisma.awardDecisionEvent.deleteMany({ where: { legId: { in: legIds } } });
    await prisma.legAwardDecision.deleteMany({ where: { legId: { in: legIds } } });
    await prisma.quote.deleteMany({ where: { queryId: { in: qIds } } });
    await prisma.changeLog.deleteMany({ where: { queryId: { in: qIds } } });
    await prisma.rfq.deleteMany({ where: { queryId: { in: qIds } } });
    for (const id of qIds) {
      await prisma.query.delete({ where: { id } }); // cascades points/legs/legPackages/cargo/packages/items
    }
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: FF_PREFIX } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init(); // boots @OnEvent subscribers — the listener under test, plus its siblings
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    packageService = moduleRef.get(PackageService);
    await seedReferenceData(prisma);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  // S5.9.5 (design D6) — REWRITTEN. This test used to drive the change-order edit straight at a
  // query sitting in QUOTING_CLIENT and assert that the frozen awardSnapshot was silently torn
  // down as a side effect. D6 changes that deliberately: a locked query refuses EVERY write
  // except reopen-comparison and the quotation builder, so the edit is refused, and D6 states
  // the intended trade — "a user correcting a mistake must reopen explicitly rather than
  // discovering their client quotation silently torn down by an edit".
  //
  // The listener under test is NOT weakened: after the explicit reopen, the SAME edit runs and
  // every original assertion about the award reversal (decision -> DRAFT, the REOPEN event and
  // its reason, the untouched sibling, the derived rollup) is asserted unchanged. What is no
  // longer asserted is the snapshot teardown INSIDE the listener — with the edit refused while
  // locked, reopen has already cleared the snapshot by the time the listener runs, so that
  // branch is no longer reachable from this (or, as far as the S5.9.5 endpoint inventory found,
  // any) product path. D6 nonetheless instructs that the teardown stay in place; it is left
  // untouched and is flagged in the task-5 report rather than removed here.
  it("S5.9.5 (D6) — a change-order edit is REFUSED while the query is being quoted to the client; after an explicit reopen the same edit reverses ONLY that leg's award, leaving a sibling APPROVED leg untouched", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-main`, assignedUserId: execId, incoterms: "FOB" },
    });
    const a = await seedAwardedLeg(query.id, "L1", 1000, 3);
    const b = await seedAwardedLeg(query.id, "L2", 500, 5);

    // Reach QUOTING_CLIENT via the real, HTTP-driven generate-client-quote — both legs APPROVED
    // with a decided LegAwardDecision satisfies A6.
    const genRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/generate-client-quote`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send()
      .expect(200);
    expect(genRes.body.status).toBe("QUOTING_CLIENT");
    expect(genRes.body.awardSnapshot.legs).toHaveLength(2);

    // Sanity check before the change-order: both decisions are APPROVED.
    const beforeA = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: a.leg.id } });
    const beforeB = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: b.leg.id } });
    expect(beforeA.status).toBe("APPROVED");
    expect(beforeB.status).toBe("APPROVED");

    const REASON = "client corrected the packing list for L1 post-award";

    // --- D6: while the query is locked, the edit is refused and nothing moves ---
    await expect(
      packageService.update(query.id, a.cargoId, a.pkgId, { grossWt: 340, reason: REASON }, actorUser),
    ).rejects.toMatchObject({ status: 409, response: { message: QUERY_LOCKED_MESSAGE } });
    const duringLock = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(duringLock.awardSnapshot).not.toBeNull();
    expect(duringLock.status).toBe("QUOTING_CLIENT");
    expect(
      (await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: a.leg.id } })).status,
    ).toBe("APPROVED");
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: a.quote.id } })).status).toBe(
      QuoteStatus.APPROVED,
    );

    // --- the door out (D6's first exception), then the SAME edit ---
    // S5.9.5 (D6) — reopen is Manager/Admin only and takes a required reason; an EXECUTIVE cookie
    // would now 403. This reason is distinct from REASON (the later change-order edit's own
    // reason, asserted separately below on the listener's OWN reversal event) so the two are never
    // confused when reading the assertions.
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/reopen-comparison`)
      .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
      .send({ reason: "S5.9.5 e2e — reopening to allow the change-order edit through" })
      .expect(200);
    // Reopen deliberately does NOT un-approve legs (D2), so the fixture the listener reacts to is
    // exactly the one the original test set up — minus the snapshot.
    expect(
      (await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: a.leg.id } })).status,
    ).toBe("APPROVED");
    // reopen-comparison writes its OWN per-leg REOPEN AwardDecisionEvent (award.service.ts), on
    // every leg of the query — so the listener's event can only be identified as a DELTA against
    // what already exists here, not by a bare count.
    const preEditEventIds = new Set(
      (await prisma.awardDecisionEvent.findMany({ where: { queryId: query.id }, select: { id: true } }))
        .map((e) => e.id),
    );
    const newEventsFor = async (legId: string) =>
      (await prisma.awardDecisionEvent.findMany({ where: { legId } })).filter(
        (e) => !preEditEventIds.has(e.id),
      );

    // Drive the REAL change-order path — the same mediated PackageService.update() boundary the
    // controller uses. This alone (SB6's already-fixed cascade, Task 3) invalidates quote A and
    // reopens leg A; what's newly under test here is everything downstream: the award reversal.
    await packageService.update(query.id, a.cargoId, a.pkgId, { grossWt: 340, reason: REASON }, actorUser);

    // --- scene-setting: the SB6 cascade itself (already covered by change-order-cascade.e2e-
    // spec.ts) — asserted here only to prove the fixture actually reached the state this task's
    // listener reacts to. ---
    const legAAfter = await prisma.leg.findUniqueOrThrow({ where: { id: a.leg.id } });
    expect(legAAfter.status).toBe("READY_FOR_RFQ");
    const quoteAAfter = await prisma.quote.findUniqueOrThrow({ where: { id: a.quote.id } });
    expect(quoteAAfter.status).toBe(QuoteStatus.INVALID);

    // --- the reversal under test: leg A's award decision is reset to a clean DRAFT ---
    const decisionAAfter = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: a.leg.id } });
    expect(decisionAAfter.status).toBe("DRAFT");
    expect(decisionAAfter.shortlistedQuoteId).toBeNull();
    expect(decisionAAfter.shortlistedVariant).toBeNull();
    expect(decisionAAfter.sentByUserId).toBeNull();
    expect(decisionAAfter.decidedByUserId).toBeNull();
    expect(decisionAAfter.decidedAt).toBeNull();
    expect(decisionAAfter.rejectionReason).toBeNull();
    // Left alone — re-derived the next time this leg is shortlisted, not the reversal's job.
    expect(decisionAAfter.recommendedQuoteId).toBe(a.quote.id);
    expect(decisionAAfter.recommendedVariant).toBe("DEDICATED");
    expect(decisionAAfter.overrideReason).toBe(
      "pre-existing override reason — must survive the reversal untouched",
    );

    const reopenEventsA = (await newEventsFor(a.leg.id)).filter((e) => e.type === "REOPEN");
    expect(reopenEventsA).toHaveLength(1);
    expect(reopenEventsA[0].queryId).toBe(query.id);
    expect(reopenEventsA[0].reason).toBe(REASON);
    expect(reopenEventsA[0].actorId).toBeNull(); // system action, not attributable to a human decider

    // --- sibling leg B: completely untouched — minimal blast radius extends to the award side too ---
    const decisionBAfter = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: b.leg.id } });
    expect(decisionBAfter.status).toBe("APPROVED");
    expect(decisionBAfter.shortlistedQuoteId).toBe(b.quote.id);
    expect(decisionBAfter.sentByUserId).not.toBeNull();
    const legBAfter = await prisma.leg.findUniqueOrThrow({ where: { id: b.leg.id } });
    expect(legBAfter.status).toBe("APPROVED");
    expect(await newEventsFor(b.leg.id)).toHaveLength(0);

    // --- off QUOTING_CLIENT. The snapshot is null because the REOPEN above cleared it, not
    // because the listener tore it down — see this test's header. What the listener still owns
    // here is the ROLLUP: leg A moved, so the query's derived status must follow it. ---
    const queryAfter = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(queryAfter.awardSnapshot).toBeNull();
    expect(queryAfter.status).not.toBe("QUOTING_CLIENT");
    // ... and matches the REAL derived rollup (not a hardcoded guess) — leg A is now
    // READY_FOR_RFQ (least-advanced), leg B stays APPROVED, no rfqReady milestone was ever set on
    // this directly-seeded fixture.
    const legsAfter = await prisma.leg.findMany({ where: { queryId: query.id }, select: { status: true } });
    const expectedStatus = deriveQueryStatus(legsAfter.map((l) => l.status as LegStatus), {
      rfqReady: !!queryAfter.rfqReadyAt,
      quotingClient: false,
    });
    expect(queryAfter.status).toBe(expectedStatus);
  });

  it("a change-order edit on a leg that was NEVER awarded (no LegAwardDecision) does not throw and creates no spurious decision or event", async () => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-never-awarded`, incoterms: "FOB" },
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
        status: "FULLY_QUOTED", // distributed and quoted, but never shortlisted/awarded
        originPointId: origin.id,
        destinationPointId: dest.id,
      },
    });
    const { cargoId, packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: "PK-NEVER", dimL: 10, dimW: 10, dimH: 10, grossWt: 100 }],
    });
    const pkgId = packageIds[0];
    await assignPackagesToLeg(prisma, leg.id, [pkgId]);

    const ff = await mkFf(`${FF_PREFIX}-NEVER`);
    const rfq = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: ff.id,
        rfqNumber: `${CODE}-RFQ-NEVER`,
        accessTokenHash: `hash-${PFX}-never`,
        submissionDeadline: future(),
        incoterms: "FOB",
        currency: "USD",
        quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    const quote = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ff.id,
        rfqId: rfq.id,
        status: QuoteStatus.QUOTED, // live and submitted; no LegAwardDecision ever created
        submittedAt: new Date(),
      },
    });

    let caught: unknown;
    try {
      await packageService.update(
        query.id,
        cargoId,
        pkgId,
        { grossWt: 250, reason: "never-awarded reopen" },
        actorUser,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined(); // must NOT throw — the listener's try/catch is load-bearing

    const legAfter = await prisma.leg.findUniqueOrThrow({ where: { id: leg.id } });
    expect(legAfter.status).toBe("READY_FOR_RFQ"); // the (already-proven) SB6 cascade still ran
    const quoteAfter = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(quoteAfter.status).toBe(QuoteStatus.INVALID);

    const decision = await prisma.legAwardDecision.findUnique({ where: { legId: leg.id } });
    expect(decision).toBeNull(); // no spurious decision created by the updateMany no-op path

    const events = await prisma.awardDecisionEvent.findMany({ where: { legId: leg.id } });
    expect(events).toHaveLength(0); // no spurious event either

    const queryAfter = await prisma.query.findUniqueOrThrow({ where: { id: query.id } });
    expect(queryAfter.awardSnapshot).toBeNull(); // this query was never generated — stays null
  });
});
