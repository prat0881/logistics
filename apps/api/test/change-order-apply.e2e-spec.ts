process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { createHash, randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";
import { QuoteStatus, type ManifestSnapshot } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ChangeMediator } from "../src/modules/changes/change-mediator";
import { seedReferenceData } from "../src/seed/reference-seed";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

// Task 8 (SB6): the change-order APPLY saga — a change-order-path request arriving WITH a
// `reason` runs the full cascade (design §7): apply the field edit + re-freeze the PENDING
// (RFQ_SENT) manifests + snapshot the invalidated (QUOTED) pricing + write a ChangeLog (one
// tx), then fire quote INVALIDATE + leg REOPEN, then notify the invalidated FF(s).
//
// Worked example (design §12): Leg L1 distributed to FF-A (QUOTED, with pricing children) +
// FF-B (RFQ_SENT); package P1 → L1. Executive corrects P1.grossWt (RfqDefining) with a reason.
// After the saga: FF-A → INVALID (its QuoteCargoLine kept as history), FF-B manifest refreshed
// to the new weight, L1 → READY_FOR_RFQ, one ChangeLog row (with the invalidated pricing
// snapshot), one MessageLog to FF-A (eventKey rfq.leg.reopened).
//
// Cargo→Package re-model (Unit 5 ripple): fixtures now build Cargo→Package (+LegPackage) via
// the shared `createCargoWithPackages`/`assignPackagesToLeg` helper instead of the dropped flat
// CargoItem/LegCargo model. grossWt (RfqDefining) now lives on Package, not Cargo (see
// package.impact.ts) — the mediated edit under test is `entity: "package"`, not `entity: "cargo"`.
// ManifestSnapshotCargo also renamed `cargoItemId` → `packageId` (rfq.ts).
const PFX = "chg-order-apply-";
const CODE = `${PFX}query`; // single-leg cargo scenario
const CODE2 = `${PFX}query2`; // query-wide (incoterms) multi-leg scenario
const CODE3 = `${PFX}query3`; // minimal-blast-radius: 1 distributed + 1 DRAFT leg
const CODE4 = `${PFX}query4`; // S5.9.5 CRITICAL 1: priced-EXPIRED vs unpriced-EXPIRED
const FF_PREFIX = `FF-${PFX}`;
const FF_A_CODE = `${FF_PREFIX}A-QUOTED`;
const FF_B_CODE = `${FF_PREFIX}B-SENT`;

const OLD_GROSS_WT = 100; // kg — what the FFs originally priced against
const NEW_GROSS_WT = 250; // kg — the corrected packing-list weight
const FF_A_GRAND_TOTAL = 4200; // FF-A's submitted price, snapshotted into the ChangeLog
const REASON = "client corrected packing list";

describe("ChangeOrderStrategy apply saga (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mediator: ChangeMediator;
  const actorId = randomUUID(); // soft reference (no FK) — same convention as Query.assignedUserId
  const execId = randomUUID();
  const execId2 = randomUUID();
  const execId3 = randomUUID();
  const execId4 = randomUUID();

  // Self-contained cleanup, FK-safe: quotes first (cascades their pricing children incl.
  // QuoteCargoLine, and frees the CargoItem/FF from Restrict FKs) → notification/messageLog/
  // changeLog (soft/cascade refs) → rfqs (before the FF they Restrict) → query (cascades
  // points/legs/legPackages/cargo/packages/items) → FFs (swept last, after every quote/rfq
  // referencing them is gone).
  const cleanupQuery = async (queryCode: string, recipientUserId: string) => {
    const q = await prisma.query.findUnique({ where: { queryCode }, select: { id: true } });
    if (!q) return;
    await prisma.quote.deleteMany({ where: { queryId: q.id } });
    await prisma.notification.deleteMany({ where: { recipientUserId } });
    await prisma.messageLog.deleteMany({ where: { entityType: "QUERY", entityId: q.id } });
    await prisma.changeLog.deleteMany({ where: { queryId: q.id } });
    await prisma.rfq.deleteMany({ where: { queryId: q.id } });
    await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items
  };

  const cleanup = async () => {
    await cleanupQuery(CODE, execId);
    await cleanupQuery(CODE2, execId2);
    await cleanupQuery(CODE3, execId3);
    await cleanupQuery(CODE4, execId4);
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: FF_PREFIX } },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // boots @OnEvent subscribers (the notify handler) + all lifecycle hooks
    prisma = moduleRef.get(PrismaService);
    mediator = moduleRef.get(ChangeMediator);
    await cleanup();
    // create-only upserts: guarantee the rfq.leg.reopened template + density factors exist
    // regardless of test order/DB state (CI has no seed step of its own).
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  const mkFf = (code: string) =>
    prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+10000000000",
        email: `${code}@e2e.test`,
        availableCountries: ["AE"],
        modes: ["AIR"],
        status: "ACTIVE",
      },
    });

  // A minimal "old" manifest (as distribution would have frozen it), so we can prove the
  // refresh (FF-B) rewrites it to the new weight while the invalidated snapshot (FF-A) is kept.
  // `packageId` (not `cargoItemId` — dropped with the flat model, rfq.ts's ManifestSnapshotCargo).
  const oldSnapshot = (legId: string, packageId: string) => ({
    legId,
    frozenAt: "2020-01-01T00:00:00.000Z",
    cargo: [{ packageId, grossWt: String(OLD_GROSS_WT) }],
  });

  it("applies the edit, invalidates the QUOTED FF, refreshes the RFQ_SENT manifest, reopens the leg, records + notifies", async () => {
    // --- fixtures (self-contained) ---
    const query = await prisma.query.create({
      data: { queryCode: CODE, assignedUserId: execId, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: {
        queryId: query.id,
        type: "PICKUP",
        name: "Shenzhen Port",
        city: "Shenzhen",
        country: "CN",
      },
    });
    const dest = await prisma.point.create({
      data: {
        queryId: query.id,
        type: "DELIVERY",
        name: "Jebel Ali",
        city: "Dubai",
        country: "AE",
      },
    });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ dimL: 10, dimW: 10, dimH: 10, grossWt: OLD_GROSS_WT }],
    });
    const packageId = packageIds[0];
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L1",
        mode: "AIR",
        status: "PARTIALLY_QUOTED", // one QUOTED + one RFQ_SENT — a distributed, live leg
        originPointId: origin.id,
        destinationPointId: dest.id,
      },
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);

    const ffA = await mkFf(FF_A_CODE);
    const ffB = await mkFf(FF_B_CODE);

    // FF-A already submitted → has an Rfq (rfqNumber + currency drive the snapshot + notify).
    const rfqA = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: ffA.id,
        rfqNumber: `${CODE}-RFQ001`,
        accessTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        submissionDeadline: new Date(Date.now() + 86400000),
        currency: "USD",
      },
    });

    const quoteA = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffA.id,
        rfqId: rfqA.id,
        status: QuoteStatus.QUOTED,
        grandTotal: FF_A_GRAND_TOTAL,
        totalChargeableWeightT: 1.5,
        manifestSnapshot: oldSnapshot(leg.id, packageId) as unknown as Prisma.InputJsonValue,
      },
    });
    // FF-A's pricing child — must SURVIVE invalidation (history is non-destructive, §11).
    // v3: QuoteCargoLine.chargedWeightKg dropped (that value moved to the leg-level
    // Quote.chargedWeightKg) — this row is now just the packageId pointer.
    await prisma.quoteCargoLine.create({
      data: { quoteId: quoteA.id, packageId },
    });

    const quoteB = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffB.id,
        status: QuoteStatus.RFQ_SENT,
        manifestSnapshot: oldSnapshot(leg.id, packageId) as unknown as Prisma.InputJsonValue,
      },
    });

    // --- act: RfqDefining field (package.grossWt) on a distributed leg, WITH a reason → the saga ---
    const res = await mediator.apply(
      {
        entity: "package",
        id: packageId,
        field: "grossWt",
        queryId: query.id,
        actorId,
        reason: REASON,
      },
      async (tx) => {
        await tx.package.update({ where: { id: packageId }, data: { grossWt: NEW_GROSS_WT } });
      },
    );

    // --- assert: the apply result (no fatal error; change-order path taken) ---
    expect(res.path).toBe("change-order");
    expect(res.class).toBe("RfqDefining");
    expect(res.scope).toEqual([{ type: "leg", id: leg.id }]);
    expect(res.needsConfirmation).toBeUndefined(); // apply, not preview

    // --- assert: the field edit was actually applied ---
    const packageAfter = await prisma.package.findUnique({ where: { id: packageId } });
    expect(Number(packageAfter?.grossWt)).toBe(NEW_GROSS_WT);

    // --- assert: FF-A (QUOTED) → INVALID ---
    const quoteAAfter = await prisma.quote.findUnique({ where: { id: quoteA.id } });
    expect(quoteAAfter?.status).toBe(QuoteStatus.INVALID);

    // --- assert: FF-A's pricing children KEPT (non-destructive invalidation, history) ---
    const ffALines = await prisma.quoteCargoLine.findMany({ where: { quoteId: quoteA.id } });
    expect(ffALines.length).toBe(1);

    // --- assert: FF-A's manifest snapshot is UNCHANGED (frozen as historical context) ---
    const ffASnap = quoteAAfter?.manifestSnapshot as unknown as ManifestSnapshot & {
      cargo: { grossWt: string }[];
    };
    expect(ffASnap.cargo[0].grossWt).toBe(String(OLD_GROSS_WT));

    // --- assert: FF-B (RFQ_SENT) manifest refreshed IN PLACE to the new weight ---
    const quoteBAfter = await prisma.quote.findUnique({ where: { id: quoteB.id } });
    expect(quoteBAfter?.status).toBe(QuoteStatus.RFQ_SENT); // still pending, not invalidated
    const ffBSnap = quoteBAfter?.manifestSnapshot as unknown as ManifestSnapshot;
    expect(ffBSnap.cargo).toHaveLength(1);
    expect(Number(ffBSnap.cargo[0].grossWt)).toBe(NEW_GROSS_WT);
    expect(ffBSnap.cargo[0].packageId).toBe(packageId);
    expect(ffBSnap.incoterms).toBe("FOB"); // re-frozen from the live query

    // --- assert: the leg was reopened cleanly ---
    const legAfter = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(legAfter?.status).toBe("READY_FOR_RFQ");

    // --- assert: one durable ChangeLog row with the reason + invalidated pricing snapshot ---
    const logs = await prisma.changeLog.findMany({
      where: { queryId: query.id, changeType: "change-order" },
    });
    expect(logs).toHaveLength(1);
    const payload = logs[0].payload as {
      field: string | null;
      reason: string;
      impactClass: string;
      affectedScope: { type: string; id: string }[];
      invalidatedQuotes: {
        quoteId: string;
        freightForwarderId: string;
        grandTotal: string | null;
        currency: string | null;
      }[];
      refreshedQuotes: { quoteId: string; freightForwarderId: string }[];
    };
    expect(payload.field).toBe("grossWt");
    expect(payload.reason).toBe(REASON);
    expect(payload.impactClass).toBe("RfqDefining");
    expect(payload.affectedScope).toEqual([{ type: "leg", id: leg.id }]);
    expect(payload.invalidatedQuotes).toHaveLength(1);
    expect(payload.invalidatedQuotes[0].quoteId).toBe(quoteA.id);
    expect(payload.invalidatedQuotes[0].freightForwarderId).toBe(ffA.id);
    expect(Number(payload.invalidatedQuotes[0].grandTotal)).toBe(FF_A_GRAND_TOTAL);
    expect(payload.invalidatedQuotes[0].currency).toBe("USD");
    expect(payload.refreshedQuotes).toEqual([{ quoteId: quoteB.id, freightForwarderId: ffB.id }]);

    // --- assert: the invalidated FF (FF-A) was notified (EMAIL → its contact) ---
    const msg = await prisma.messageLog.findFirst({
      where: {
        entityType: "QUERY",
        entityId: query.id,
        eventKey: "rfq.leg.reopened",
        toAddress: ffA.email,
      },
    });
    expect(msg).not.toBeNull();
    expect(msg?.channel).toBe("EMAIL");
    expect(msg?.subject).toContain(rfqA.rfqNumber);
    expect(msg?.bodyRendered).toContain("L1");
    expect(msg?.bodyRendered).toContain(REASON);

    // --- assert: the pending FF (FF-B) was NOT notified (refreshed silently, §11.4) ---
    const ffBMsg = await prisma.messageLog.findFirst({
      where: {
        entityType: "QUERY",
        entityId: query.id,
        eventKey: "rfq.leg.reopened",
        toAddress: ffB.email,
      },
    });
    expect(ffBMsg).toBeNull();
  });

  it("query-wide incoterms edit reopens ALL legs and groups one notification per FF across its legs", async () => {
    // --- fixtures: 2 legs, FF-A QUOTED on BOTH (one FF invalidated across two legs), plus a
    //     pending FF per leg. Exercises the multi-leg loop, per-leg manifest scoping, and the
    //     per-FF leg-set grouping in the notify step. ---
    const query = await prisma.query.create({
      data: { queryCode: CODE2, assignedUserId: execId2, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: {
        queryId: query.id,
        type: "PICKUP",
        name: "Ningbo Port",
        city: "Ningbo",
        country: "CN",
      },
    });
    const dest = await prisma.point.create({
      data: {
        queryId: query.id,
        type: "DELIVERY",
        name: "Khalifa Port",
        city: "Abu Dhabi",
        country: "AE",
      },
    });

    const mkLeg = async (legCode: string) => {
      const { packageIds } = await createCargoWithPackages(prisma, {
        queryId: query.id,
        packages: [{ dimL: 10, dimW: 10, dimH: 10, grossWt: OLD_GROSS_WT }],
      });
      const leg = await prisma.leg.create({
        data: {
          queryId: query.id,
          legCode,
          mode: "AIR",
          status: "PARTIALLY_QUOTED",
          originPointId: origin.id,
          destinationPointId: dest.id,
        },
      });
      await assignPackagesToLeg(prisma, leg.id, packageIds);
      return leg;
    };
    // legCodes deliberately not substrings of the "...query2-RFQ00x" rfqNumber (avoids false
    // matches in the body assertions below).
    const legOne = await mkLeg("LEGONE");
    const legTwo = await mkLeg("LEGTWO");

    // Distinct FF codes from the first test (both suites live under FF_PREFIX; no inter-test
    // cleanup runs, so codes must not collide on the unique freightForwarderCode).
    const ffA = await mkFf(`${FF_PREFIX}M-A-QUOTED`); // QUOTED on both legs → invalidated on both
    const ffB = await mkFf(`${FF_PREFIX}M-B-SENT`); // RFQ_SENT on legOne → refreshed
    const ffC = await mkFf(`${FF_PREFIX}M-C-SENT`); // RFQ_SENT on legTwo → refreshed

    const rfqA = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: ffA.id,
        rfqNumber: `${CODE2}-RFQ001`,
        accessTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        submissionDeadline: new Date(Date.now() + 86400000),
        currency: "USD",
      },
    });

    const quoteA1 = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: legOne.id,
        freightForwarderId: ffA.id,
        rfqId: rfqA.id,
        status: QuoteStatus.QUOTED,
        grandTotal: 1000,
        manifestSnapshot: {
          legId: legOne.id,
          incoterms: "FOB",
        } as unknown as Prisma.InputJsonValue,
      },
    });
    const quoteA2 = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: legTwo.id,
        freightForwarderId: ffA.id,
        rfqId: rfqA.id,
        status: QuoteStatus.QUOTED,
        grandTotal: 2000,
        manifestSnapshot: {
          legId: legTwo.id,
          incoterms: "FOB",
        } as unknown as Prisma.InputJsonValue,
      },
    });
    const quoteB = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: legOne.id,
        freightForwarderId: ffB.id,
        status: QuoteStatus.RFQ_SENT,
        manifestSnapshot: {
          legId: legOne.id,
          incoterms: "FOB",
        } as unknown as Prisma.InputJsonValue,
      },
    });
    const quoteC = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: legTwo.id,
        freightForwarderId: ffC.id,
        status: QuoteStatus.RFQ_SENT,
        manifestSnapshot: {
          legId: legTwo.id,
          incoterms: "FOB",
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // --- act: query-wide RfqDefining field (incoterms), WITH a reason → all legs cascade ---
    const res = await mediator.apply(
      {
        entity: "query",
        id: query.id,
        field: "incoterms",
        queryId: query.id,
        actorId,
        reason: "incoterms renegotiated",
      },
      async (tx) => {
        await tx.query.update({ where: { id: query.id }, data: { incoterms: "CIF" } });
      },
    );
    expect(res.path).toBe("change-order");
    expect(res.class).toBe("RfqDefining");

    // --- assert: the edit applied + BOTH legs reopened ---
    const queryAfter = await prisma.query.findUnique({ where: { id: query.id } });
    expect(queryAfter?.incoterms).toBe("CIF");
    for (const leg of [legOne, legTwo]) {
      const after = await prisma.leg.findUnique({ where: { id: leg.id } });
      expect(after?.status).toBe("READY_FOR_RFQ");
    }

    // --- assert: FF-A invalidated on BOTH legs; pending FFs untouched + refreshed to new incoterms ---
    for (const q of [quoteA1, quoteA2]) {
      const after = await prisma.quote.findUnique({ where: { id: q.id } });
      expect(after?.status).toBe(QuoteStatus.INVALID);
    }
    for (const q of [quoteB, quoteC]) {
      const after = await prisma.quote.findUnique({ where: { id: q.id } });
      expect(after?.status).toBe(QuoteStatus.RFQ_SENT); // still pending
      const snap = after?.manifestSnapshot as unknown as ManifestSnapshot;
      expect(snap.incoterms).toBe("CIF"); // re-frozen per leg from the updated query
      expect(snap.legId).toBe(q.legId); // each got ITS OWN leg's snapshot, not the other leg's
    }

    // --- assert: one ChangeLog row spanning both legs + both invalidated quotes ---
    const logs = await prisma.changeLog.findMany({
      where: { queryId: query.id, changeType: "change-order" },
    });
    expect(logs).toHaveLength(1);
    const payload = logs[0].payload as {
      affectedScope: { type: string; id: string }[];
      invalidatedQuotes: { quoteId: string }[];
      refreshedQuotes: { quoteId: string }[];
    };
    expect(payload.affectedScope).toEqual(
      expect.arrayContaining([
        { type: "leg", id: legOne.id },
        { type: "leg", id: legTwo.id },
      ]),
    );
    expect(payload.affectedScope).toHaveLength(2);
    expect(payload.invalidatedQuotes.map((q) => q.quoteId).sort()).toEqual(
      [quoteA1.id, quoteA2.id].sort(),
    );
    expect(payload.refreshedQuotes.map((q) => q.quoteId).sort()).toEqual(
      [quoteB.id, quoteC.id].sort(),
    );

    // --- assert: FF-A gets exactly ONE notification covering BOTH its reopened legs (per-FF
    //     grouping — not one-per-leg). ---
    const ffAMsgs = await prisma.messageLog.findMany({
      where: {
        entityType: "QUERY",
        entityId: query.id,
        eventKey: "rfq.leg.reopened",
        toAddress: ffA.email,
      },
    });
    expect(ffAMsgs).toHaveLength(1);
    expect(ffAMsgs[0].subject).toContain(rfqA.rfqNumber);
    expect(ffAMsgs[0].bodyRendered).toContain("LEGONE");
    expect(ffAMsgs[0].bodyRendered).toContain("LEGTWO");

    // --- assert: neither pending FF was notified ---
    for (const ff of [ffB, ffC]) {
      const msg = await prisma.messageLog.findFirst({
        where: {
          entityType: "QUERY",
          entityId: query.id,
          eventKey: "rfq.leg.reopened",
          toAddress: ff.email,
        },
      });
      expect(msg).toBeNull();
    }
  });

  it("reopens ONLY the distributed leg — a fanned-in DRAFT leg is left untouched (minimal blast radius)", async () => {
    // Regression for the whole-branch-review Critical: the classifier fans a query-wide edit to
    // EVERY leg of the query (incl. undistributed ones), but the leg machine only has a REOPEN
    // edge from RFQ_SENT/PARTIALLY_QUOTED/FULLY_QUOTED. Reopening a DRAFT scope leg → either an
    // IllegalTransitionError (500, AFTER tx1 committed) or a silent regression. The saga must
    // reopen only the legs that actually carry a live quote.
    //
    // Mutation guard: reverting the saga to reopen the full classifier fan (`legIds`) makes this
    // test fail — the DRAFT leg's REOPEN throws (act line rejects) AND affectedScope would list it.
    const query = await prisma.query.create({
      data: { queryCode: CODE3, assignedUserId: execId3, incoterms: "FOB" },
    });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ dimL: 10, dimW: 10, dimH: 10, grossWt: OLD_GROSS_WT }],
    });
    // The distributed leg (has a live QUOTED quote) — the ONLY leg that should reopen.
    const distLeg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "DISTLEG", mode: "AIR", status: "FULLY_QUOTED" },
    });
    await assignPackagesToLeg(prisma, distLeg.id, packageIds);
    // The undistributed leg — fanned into scope by the query-wide edit, but carries no quote and
    // must NOT be reopened (it has no REOPEN edge from DRAFT).
    const draftLeg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "DRAFTLEG", mode: "AIR", status: "DRAFT" },
    });

    const ffA = await mkFf(`${FF_PREFIX}D-A-QUOTED`);
    const rfqA = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: ffA.id,
        rfqNumber: `${CODE3}-RFQ001`,
        accessTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        submissionDeadline: new Date(Date.now() + 86400000),
        currency: "USD",
      },
    });
    const quoteA = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: distLeg.id,
        freightForwarderId: ffA.id,
        rfqId: rfqA.id,
        status: QuoteStatus.QUOTED,
        grandTotal: 3000,
        manifestSnapshot: {
          legId: distLeg.id,
          incoterms: "FOB",
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // --- act: query-wide incoterms edit → classifier fans to BOTH legs; only distLeg is live ---
    const res = await mediator.apply(
      {
        entity: "query",
        id: query.id,
        field: "incoterms",
        queryId: query.id,
        actorId,
        reason: "incoterms renegotiated",
      },
      async (tx) => {
        await tx.query.update({ where: { id: query.id }, data: { incoterms: "CIF" } });
      },
    );
    expect(res.path).toBe("change-order"); // no throw — the DRAFT leg was skipped, not reopened

    // --- assert: the edit applied ---
    const queryAfter = await prisma.query.findUnique({ where: { id: query.id } });
    expect(queryAfter?.incoterms).toBe("CIF");

    // --- assert: the distributed leg reopened; its quote invalidated ---
    const distAfter = await prisma.leg.findUnique({ where: { id: distLeg.id } });
    expect(distAfter?.status).toBe("READY_FOR_RFQ");
    const quoteAAfter = await prisma.quote.findUnique({ where: { id: quoteA.id } });
    expect(quoteAAfter?.status).toBe(QuoteStatus.INVALID);

    // --- assert: the DRAFT leg is UNTOUCHED (not reopened, not regressed) ---
    const draftAfter = await prisma.leg.findUnique({ where: { id: draftLeg.id } });
    expect(draftAfter?.status).toBe("DRAFT");

    // --- assert: the ChangeLog records ONLY the distributed leg (minimal blast radius) ---
    const logs = await prisma.changeLog.findMany({
      where: { queryId: query.id, changeType: "change-order" },
    });
    expect(logs).toHaveLength(1);
    const payload = logs[0].payload as { affectedScope: { type: string; id: string }[] };
    expect(payload.affectedScope).toEqual([{ type: "leg", id: distLeg.id }]); // NOT the draft leg

    // --- assert: the invalidated FF was notified (best-effort notify ran to completion) ---
    const msg = await prisma.messageLog.findFirst({
      where: {
        entityType: "QUERY",
        entityId: query.id,
        eventKey: "rfq.leg.reopened",
        toAddress: ffA.email,
      },
    });
    expect(msg).not.toBeNull();
  });
  // ── S5.9.5 final whole-branch review, CRITICAL 1 ────────────────────────────────────────────
  it("a SUBMITTED-price expired offer makes a cargo edit a change-order and is invalidated, while an unpriced one — and one holding only an abandoned scratchpad (S5.9.6 A6) — still free-path", async () => {
    // WHY THIS EXISTS. `downstreamWork` (scope.resolver.ts) counted only RFQ_SENT/QUOTED/
    // PENDING_APPROVAL/APPROVED as live, with EXPIRED excluded as "gone stale". That was safe for
    // the whole life of that exclusion BECAUSE an expired quote never carried a price — the
    // deadline sweep discarded the draft on its way past. S5.9.5 D4 changed exactly that (the sweep
    // now discards only for a quote still at RFQ_SENT) and D8 then made such an offer
    // comparable, rankable, sendable and approvable. So a cargo edit on a leg whose only quote was
    // a priced EXPIRED offer took the FREE path: no invalidation, no change order, no reopen — and
    // the offer stayed on the grid, ★-ranked and selectable, to be approved and priced into the
    // client letter straight off a price written against superseded cargo.
    //
    // The three halves below are ONE test on purpose: the fix is a DISTINCTION, and each half is
    // the others' control. Widening the live set to all of EXPIRED (dropping the `submittedJson`
    // term) reddens halves 2 and 3 — an ordinary never-answered expiry would start demanding a
    // reason and raising change orders where the product has always free-pathed. Leaving EXPIRED
    // out altogether reddens half 1.
    //
    // HALF 3 is S5.9.6 (register A6): before the column split, the live-quote predicate keyed on
    // `draftJson`, so a forwarder who half-edited a reopened portal and went silent was treated as
    // having a live commercial commitment. They never submitted that number and it appears nowhere
    // on the compare screen, so the edit must free-path exactly as half 2 does. Half 3's fixture
    // differs from half 1's in several columns (`rfqId`, `submittedAt`, `grandTotal`,
    // `totalChargeableWeightT`, `submittedJson`) because it also has to be a realistic
    // never-submitted row — but it differs in exactly one of the columns `LIVE_QUOTE_WHERE`
    // READS, which is `submittedJson`; that predicate looks at `status` and that column and
    // nothing else. So the isolation is in the predicate, not in the fixture.
    const query = await prisma.query.create({
      data: { queryCode: CODE4, assignedUserId: execId4, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", name: "Chennai", city: "Chennai", country: "IN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", name: "Jebel Ali", city: "Dubai", country: "AE" },
    });

    // Each leg gets its OWN package, so a `package.grossWt` edit fans to exactly one of them and
    // the two halves cannot contaminate each other through a shared cargo scope.
    const mkLeg = async (legCode: string) => {
      const { packageIds } = await createCargoWithPackages(prisma, {
        queryId: query.id,
        packages: [{ dimL: 10, dimW: 10, dimH: 10, grossWt: OLD_GROSS_WT }],
      });
      const leg = await prisma.leg.create({
        data: {
          queryId: query.id,
          legCode,
          mode: "AIR",
          // Where the rollup actually leaves a leg once its only quote has expired: nothing
          // comparable is left, so we are waiting on a forwarder again. REOPEN has an edge from
          // here, which is what the cascade needs on the priced half.
          status: "RFQ_SENT",
          originPointId: origin.id,
          destinationPointId: dest.id,
        },
      });
      await assignPackagesToLeg(prisma, leg.id, packageIds);
      return { leg, packageId: packageIds[0] };
    };

    const priced = await mkLeg("EXPPRICED");
    const unpriced = await mkLeg("EXPEMPTY");
    const scratch = await mkLeg("EXPSCRATCH");

    const ffPriced = await mkFf(`${FF_PREFIX}E-PRICED`);
    const ffUnpriced = await mkFf(`${FF_PREFIX}E-EMPTY`);
    const ffScratch = await mkFf(`${FF_PREFIX}E-SCRATCH`);

    const rfqPriced = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: ffPriced.id,
        rfqNumber: `${CODE4}-RFQ001`,
        accessTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        submissionDeadline: new Date(Date.now() + 86400000),
        currency: "USD",
      },
    });

    // Scenario B of the design's "Where Expired appears" table: quoted → negotiated → silent →
    // swept. They submitted this price, so this row is a real, acceptable, actionable one. Both
    // JSON columns are set, exactly as `submit` leaves them and as the sweep leaves a REQUOTED
    // quote — `submittedJson` is the offer, `draftJson` the scratchpad kept for portal pre-fill.
    const quotePriced = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: priced.leg.id,
        freightForwarderId: ffPriced.id,
        rfqId: rfqPriced.id,
        status: QuoteStatus.EXPIRED,
        submittedAt: new Date(),
        grandTotal: FF_A_GRAND_TOTAL,
        totalChargeableWeightT: 1.5,
        draftJson: { legId: priced.leg.id, chargedWeightKg: 500 } as unknown as Prisma.InputJsonValue,
        submittedJson: { legId: priced.leg.id, chargedWeightKg: 500 } as unknown as Prisma.InputJsonValue,
        manifestSnapshot: oldSnapshot(priced.leg.id, priced.packageId) as unknown as Prisma.InputJsonValue,
      },
    });

    // Scenario A: RFQ sent, forwarder never submitted, deadline passed, draft discarded. No price,
    // no commitment — and the overwhelming majority of expired rows in production.
    const quoteUnpriced = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: unpriced.leg.id,
        freightForwarderId: ffUnpriced.id,
        status: QuoteStatus.EXPIRED,
        manifestSnapshot: oldSnapshot(unpriced.leg.id, unpriced.packageId) as unknown as Prisma.InputJsonValue,
      },
    });
    expect(quoteUnpriced.draftJson).toBeNull(); // the fixture really is the unpriced shape
    expect(quoteUnpriced.submittedJson).toBeNull();

    // S5.9.6 (A6): asked to re-quote, typed into the reopened portal, hit Save draft, went silent.
    // A scratchpad, never an offer. Of the two columns `LIVE_QUOTE_WHERE` reads it shares
    // `status` with `quotePriced` above and differs only in `submittedJson`.
    const quoteScratch = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: scratch.leg.id,
        freightForwarderId: ffScratch.id,
        status: QuoteStatus.EXPIRED,
        draftJson: { legId: scratch.leg.id, chargedWeightKg: 500 } as unknown as Prisma.InputJsonValue,
        manifestSnapshot: oldSnapshot(scratch.leg.id, scratch.packageId) as unknown as Prisma.InputJsonValue,
      },
    });
    expect(quoteScratch.submittedJson).toBeNull(); // the fixture really is the scratchpad-only shape

    // ── HALF 1: the priced expired offer is a live commitment ────────────────────────────────
    const pricedRes = await mediator.apply(
      {
        entity: "package",
        id: priced.packageId,
        field: "grossWt",
        queryId: query.id,
        actorId,
        reason: REASON,
      },
      async (tx) => {
        await tx.package.update({ where: { id: priced.packageId }, data: { grossWt: NEW_GROSS_WT } });
      },
    );
    expect(pricedRes.path).toBe("change-order");
    expect(pricedRes.scope).toEqual([{ type: "leg", id: priced.leg.id }]);

    // The edit applied, and the superseded price is INVALID — this is the fire that needs the
    // `EXPIRED --invalidate--> INVALID` edge (award.module.ts). Without that edge this line does
    // not merely read the wrong status: `status.fire` throws IllegalTransitionError AFTER tx1 has
    // committed the edit and the ChangeLog, so `mediator.apply` above rejects instead.
    expect(Number((await prisma.package.findUnique({ where: { id: priced.packageId } }))?.grossWt)).toBe(
      NEW_GROSS_WT,
    );
    const pricedAfter = await prisma.quote.findUnique({ where: { id: quotePriced.id } });
    expect(pricedAfter?.status).toBe(QuoteStatus.INVALID);
    // The leg reopened, so the offer is off the compare screen entirely rather than sitting there
    // rankable against cargo that has moved.
    expect((await prisma.leg.findUnique({ where: { id: priced.leg.id } }))?.status).toBe(
      "READY_FOR_RFQ",
    );
    // ...and the invalidation is in the audit trail with the price it superseded.
    const pricedLogs = await prisma.changeLog.findMany({
      where: { queryId: query.id, changeType: "change-order" },
    });
    expect(pricedLogs).toHaveLength(1);
    const pricedPayload = pricedLogs[0].payload as {
      affectedScope: { type: string; id: string }[];
      invalidatedQuotes: { quoteId: string; grandTotal: string | null }[];
      refreshedQuotes: { quoteId: string }[];
    };
    expect(pricedPayload.affectedScope).toEqual([{ type: "leg", id: priced.leg.id }]);
    expect(pricedPayload.invalidatedQuotes.map((q) => q.quoteId)).toEqual([quotePriced.id]);
    expect(Number(pricedPayload.invalidatedQuotes[0].grandTotal)).toBe(FF_A_GRAND_TOTAL);
    expect(pricedPayload.refreshedQuotes).toEqual([]); // nothing was merely refreshed

    // ── HALF 2 (positive control): the unpriced expired quote is NOT a commitment ─────────────
    // Deliberately sent with NO `reason`. On the change-order path that is a PREVIEW, which applies
    // nothing at all — so if this half ever regressed, the weight assertion below would fail too,
    // not just the `path` one.
    const unpricedRes = await mediator.apply(
      {
        entity: "package",
        id: unpriced.packageId,
        field: "grossWt",
        queryId: query.id,
        actorId,
      },
      async (tx) => {
        await tx.package.update({
          where: { id: unpriced.packageId },
          data: { grossWt: NEW_GROSS_WT },
        });
      },
    );
    expect(unpricedRes.path).toBe("free");
    expect(unpricedRes.needsConfirmation).toBeUndefined();
    expect(
      Number((await prisma.package.findUnique({ where: { id: unpriced.packageId } }))?.grossWt),
    ).toBe(NEW_GROSS_WT);
    // Nothing cascaded: the quote is still EXPIRED (not INVALID), the leg never reopened, and no
    // second ChangeLog row appeared.
    expect((await prisma.quote.findUnique({ where: { id: quoteUnpriced.id } }))?.status).toBe(
      QuoteStatus.EXPIRED,
    );
    expect((await prisma.leg.findUnique({ where: { id: unpriced.leg.id } }))?.status).toBe("RFQ_SENT");
    const allChangeOrders = await prisma.changeLog.findMany({
      where: { queryId: query.id, changeType: "change-order" },
    });
    expect(allChangeOrders).toHaveLength(1); // still only HALF 1's

    // ── HALF 3 (S5.9.6, A6): a scratchpad is not a commitment ────────────────────────────────
    // Same no-`reason` preview shape as HALF 2, for the same reason.
    const scratchRes = await mediator.apply(
      {
        entity: "package",
        id: scratch.packageId,
        field: "grossWt",
        queryId: query.id,
        actorId,
      },
      async (tx) => {
        await tx.package.update({
          where: { id: scratch.packageId },
          data: { grossWt: NEW_GROSS_WT },
        });
      },
    );
    expect(scratchRes.path).toBe("free");
    expect(scratchRes.needsConfirmation).toBeUndefined();
    expect(
      Number((await prisma.package.findUnique({ where: { id: scratch.packageId } }))?.grossWt),
    ).toBe(NEW_GROSS_WT);
    expect((await prisma.quote.findUnique({ where: { id: quoteScratch.id } }))?.status).toBe(
      QuoteStatus.EXPIRED,
    );
    expect((await prisma.leg.findUnique({ where: { id: scratch.leg.id } }))?.status).toBe("RFQ_SENT");
    expect(
      await prisma.changeLog.count({ where: { queryId: query.id, changeType: "change-order" } }),
    ).toBe(1); // STILL only HALF 1's
  });
});
