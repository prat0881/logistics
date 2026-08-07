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
    await prisma.quoteCargoLine.create({
      data: { quoteId: quoteA.id, packageId, chargedWeightKg: 1500 },
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
});
