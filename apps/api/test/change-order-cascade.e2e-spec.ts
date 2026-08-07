process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { createHash, randomUUID } from "node:crypto";
import { ConflictException, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";
import { QuoteStatus, Role, type ManifestSnapshot } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PackageService } from "../src/modules/cargo/package.service";
import { RfqService } from "../src/modules/rfq/rfq.service";
import { seedReferenceData } from "../src/seed/reference-seed";
import type { RequestUser } from "../src/modules/auth/types";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

// Task 13 (SB6, capstone): the full field-edit change-order cascade, end to end, through the
// SAME mediated service boundary the controllers use (PackageService.update — not ChangeMediator
// directly), plus the Task 11 re-distribute reactivation. Two distributed legs prove design
// §11.3 "minimal blast radius": L1 (package P1, FF-A QUOTED + FF-B RFQ_SENT) is the edited leg;
// L2 (package P2, FF-C QUOTED) is the untouched sibling — P2 is assigned ONLY to L2 (never L1),
// so the classifier's package→legs fan-out (LegPackage-driven, [impact.classifier.ts]) must never
// reach L2. FF-C is deliberately QUOTED (not just RFQ_SENT): a scope leak would flip it to
// INVALID, an unmissable signal — a merely-refreshed RFQ_SENT sibling would be a weaker witness.
//
// Cargo→Package re-model (Unit 5 ripple): the field under test (grossWt) moved from Cargo to
// Package (package.impact.ts — dims/weights are what an FF quotes against, RfqDefining), so the
// mediated write path here is PackageService.update, not CargoService.update — this ALSO means
// this spec is the real, non-mocked end-to-end proof of the restored `case "package"` fan-out in
// impact.classifier.ts (routing.service.legsCarryingPackage): P1's edit must fork to the
// change-order path on L1 (which carries live quotes) while never touching L2 (P2's leg).
//
// Story: (1) edit P1.grossWt WITHOUT a reason → 409 ConflictException, preview names FF-A
// invalidating / FF-B refreshing, nothing written. (2) same edit WITH a reason → the saga runs:
// FF-A QUOTED→INVALID (pricing history kept), FF-B manifest refreshed to the new weight, L1→
// READY_FOR_RFQ, one ChangeLog row, one rfq.leg.reopened MessageLog to FF-A. (3) L2/FF-C are
// untouched throughout. (4) re-distributing L1 reactivates FF-A (INVALID→RFQ_SENT, same row)
// and resets its Rfq.submissionDeadline.
const PFX = "chg-order-cascade-";
const CODE = `${PFX}query`;
const FF_PREFIX = `FF-${PFX}`;

const OLD_GROSS_WT = 120; // kg — what FF-A/FF-B originally priced against on L1
const NEW_GROSS_WT = 340; // kg — the corrected packing-list weight
const CARGO2_GROSS_WT = 60; // kg — L2's package; must never move
const FF_A_GRAND_TOTAL = 6300; // FF-A's submitted price, snapshotted into the ChangeLog
const FF_C_GRAND_TOTAL = 2100; // FF-C's submitted price on the sibling leg — must survive untouched
const REASON = "client corrected packing list for L1";

describe("Change-order cascade — capstone full flow (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let packageService: PackageService;
  let rfqService: RfqService;
  const actorId = randomUUID(); // soft reference (no FK) — the Executive making the edits
  const execId = randomUUID(); // soft reference — Query.assignedUserId, the IN_APP recipient
  const user: RequestUser = { userId: actorId, role: Role.EXECUTIVE, tenantId: null };

  // Self-contained cleanup, FK-safe: ScheduledEvent/MessageLog reference entityId as a plain
  // string (no FK relation), so they survive a Query/Rfq delete and need an explicit sweep —
  // step 4 (a real re-distribute) mints fresh reminder/expiry rows for FF-A's Rfq. Then quotes
  // (frees the FF/Rfq Restrict FKs) → notification/changeLog → rfqs (before the FF they
  // Restrict) → query (cascades points/legs/legPackages/cargo/packages/items) → FFs swept last.
  const cleanup = async () => {
    const q = await prisma.query.findUnique({ where: { queryCode: CODE }, select: { id: true } });
    if (q) {
      const rfqs = await prisma.rfq.findMany({ where: { queryId: q.id }, select: { id: true } });
      const rfqIds = rfqs.map((r) => r.id);
      if (rfqIds.length) {
        await prisma.scheduledEvent.deleteMany({ where: { entityType: "RFQ", entityId: { in: rfqIds } } });
      }
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.notification.deleteMany({ where: { recipientUserId: execId } });
      await prisma.messageLog.deleteMany({ where: { entityType: "QUERY", entityId: q.id } });
      await prisma.changeLog.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items
    }
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: FF_PREFIX } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // boots @OnEvent subscribers (the reopen-notify handler) + all lifecycle hooks
    prisma = moduleRef.get(PrismaService);
    packageService = moduleRef.get(PackageService);
    rfqService = moduleRef.get(RfqService);
    await cleanup();
    // create-only upserts: guarantees the rfq.leg.reopened / rfq.updated templates + density
    // factors + RFQ AppSettings exist regardless of test order/DB state (CI has no seed step).
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

  // A minimal "frozen" manifest, as the original distribution would have snapshotted it.
  // `packageId` (not `cargoItemId` — dropped with the flat model, rfq.ts's ManifestSnapshotCargo).
  const mkSnapshot = (legId: string, packageId: string, grossWt: number) => ({
    legId,
    frozenAt: "2020-01-01T00:00:00.000Z",
    cargo: [{ packageId, grossWt: String(grossWt) }],
  });

  it("full field-edit cascade: reject without reason, apply+cascade with reason, minimal blast radius, re-distribute reactivates", async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // Fixtures: one query, two distributed legs.
    //   L1 — package P1, FF-A (QUOTED) + FF-B (RFQ_SENT)   ← the edited leg
    //   L2 — package P2, FF-C (QUOTED)                      ← sibling that MUST stay untouched
    // ─────────────────────────────────────────────────────────────────────────
    const query = await prisma.query.create({
      data: { queryCode: CODE, assignedUserId: execId, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", name: "Shenzhen Port", city: "Shenzhen", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", name: "Jebel Ali", city: "Dubai", country: "AE" },
    });

    const { cargoId: cargo1Id, packageIds: pkg1Ids } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: "PK-C1", dimL: 10, dimW: 10, dimH: 10, grossWt: OLD_GROSS_WT }],
    });
    const pkg1Id = pkg1Ids[0];
    const { packageIds: pkg2Ids } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: "PK-C2", dimL: 8, dimW: 8, dimH: 8, grossWt: CARGO2_GROSS_WT }],
    });
    const pkg2Id = pkg2Ids[0];

    const leg1 = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L1",
        mode: "AIR",
        status: "PARTIALLY_QUOTED", // one QUOTED + one RFQ_SENT — a distributed, live leg
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 7 * 86400000),
      },
    });
    await assignPackagesToLeg(prisma, leg1.id, [pkg1Id]); // ONLY P1 — drives the classifier's fan-out
    const leg2 = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L2",
        mode: "AIR",
        status: "FULLY_QUOTED", // its one FF has already quoted
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 7 * 86400000),
      },
    });
    await assignPackagesToLeg(prisma, leg2.id, [pkg2Id]); // ONLY P2 — never P1

    const ffA = await mkFf(`${FF_PREFIX}A-QUOTED`);
    const ffB = await mkFf(`${FF_PREFIX}B-SENT`);
    const ffC = await mkFf(`${FF_PREFIX}C-SIBLING`);

    // FF-A: submitted on L1 — needs a real Rfq (rfqNumber/currency drive the ChangeLog snapshot
    // + the notify step below); deadline set in the PAST so step 4's "reset" is unambiguous.
    const rfqA = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: ffA.id,
        rfqNumber: `${CODE}-RFQ-A`,
        accessTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        submissionDeadline: new Date(Date.now() - 3600_000),
        currency: "USD",
      },
    });
    const quoteA = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg1.id,
        freightForwarderId: ffA.id,
        rfqId: rfqA.id,
        status: QuoteStatus.QUOTED,
        grandTotal: FF_A_GRAND_TOTAL,
        totalChargeableWeightT: 1.5,
        manifestSnapshot: mkSnapshot(leg1.id, pkg1Id, OLD_GROSS_WT) as unknown as Prisma.InputJsonValue,
      },
    });
    // FF-A's pricing child — must SURVIVE invalidation (non-destructive history, design §11).
    await prisma.quoteCargoLine.create({
      data: { quoteId: quoteA.id, packageId: pkg1Id, chargedWeightKg: 1500 },
    });

    // FF-B: still pending on L1 — refreshed in place, never invalidated, never notified.
    const quoteB = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg1.id,
        freightForwarderId: ffB.id,
        status: QuoteStatus.RFQ_SENT,
        manifestSnapshot: mkSnapshot(leg1.id, pkg1Id, OLD_GROSS_WT) as unknown as Prisma.InputJsonValue,
      },
    });

    // FF-C: submitted on the SIBLING leg L2 — QUOTED (not just RFQ_SENT), so any blast-radius
    // leak onto L2 would flip it to INVALID, an unmissable signal.
    const quoteC = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg2.id,
        freightForwarderId: ffC.id,
        status: QuoteStatus.QUOTED,
        grandTotal: FF_C_GRAND_TOTAL,
        totalChargeableWeightT: 0.7,
        manifestSnapshot: mkSnapshot(leg2.id, pkg2Id, CARGO2_GROSS_WT) as unknown as Prisma.InputJsonValue,
      },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1 — WITHOUT a reason: the mediated package update rejects with a 409-shaped
    // ConflictException carrying needsChangeOrder + the blast-radius preview, and applies
    // NOTHING. FF-A/FF-B are the only quotes previewed; L2/FF-C never appear. This is the real,
    // non-mocked proof that `case "package"` (impact.classifier.ts) + legsCarryingPackage
    // (routing.service.ts) correctly fan P1's edit to L1 and gate on its live quotes.
    // ─────────────────────────────────────────────────────────────────────────
    let caught: unknown;
    try {
      await packageService.update(query.id, cargo1Id, pkg1Id, { grossWt: NEW_GROSS_WT }, user);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const exception = caught as ConflictException;
    expect(exception.getStatus()).toBe(409);
    const body = exception.getResponse() as {
      needsChangeOrder: boolean;
      preview: {
        affectedLegs: string[];
        impactClass: string;
        invalidatingQuotes: { quoteId: string; freightForwarderId: string }[];
        refreshingQuotes: { quoteId: string; freightForwarderId: string }[];
      };
    };
    expect(body.needsChangeOrder).toBe(true);
    expect(body.preview.affectedLegs).toEqual([leg1.id]); // L2 never named
    expect(body.preview.impactClass).toBe("RfqDefining");
    expect(body.preview.invalidatingQuotes).toEqual([{ quoteId: quoteA.id, freightForwarderId: ffA.id }]);
    expect(body.preview.refreshingQuotes).toEqual([{ quoteId: quoteB.id, freightForwarderId: ffB.id }]);

    // Nothing was written by the preview.
    const pkg1AfterPreview = await prisma.package.findUnique({ where: { id: pkg1Id } });
    expect(Number(pkg1AfterPreview?.grossWt)).toBe(OLD_GROSS_WT);
    expect((await prisma.quote.findUnique({ where: { id: quoteA.id } }))?.status).toBe(QuoteStatus.QUOTED);
    expect(await prisma.changeLog.count({ where: { queryId: query.id } })).toBe(0);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2 — the SAME edit WITH a reason: the full cascade runs.
    // ─────────────────────────────────────────────────────────────────────────
    await packageService.update(query.id, cargo1Id, pkg1Id, { grossWt: NEW_GROSS_WT, reason: REASON }, user);

    const pkg1After = await prisma.package.findUnique({ where: { id: pkg1Id } });
    expect(Number(pkg1After?.grossWt)).toBe(NEW_GROSS_WT);

    // FF-A (QUOTED) → INVALID; pricing history kept.
    const quoteAAfter = await prisma.quote.findUnique({ where: { id: quoteA.id } });
    expect(quoteAAfter?.status).toBe(QuoteStatus.INVALID);
    const ffALines = await prisma.quoteCargoLine.findMany({ where: { quoteId: quoteA.id } });
    expect(ffALines).toHaveLength(1);
    const ffASnap = quoteAAfter?.manifestSnapshot as unknown as { cargo: { grossWt: string }[] };
    expect(ffASnap.cargo[0].grossWt).toBe(String(OLD_GROSS_WT)); // frozen as historical context

    // FF-B (RFQ_SENT) — refreshed in place to the new weight, still pending. The refreshed
    // manifest carries the PER-PACKAGE grain (ManifestSnapshotCargo.packageId).
    const quoteBAfter = await prisma.quote.findUnique({ where: { id: quoteB.id } });
    expect(quoteBAfter?.status).toBe(QuoteStatus.RFQ_SENT);
    const ffBSnap = quoteBAfter?.manifestSnapshot as unknown as ManifestSnapshot;
    expect(ffBSnap.cargo).toHaveLength(1);
    expect(Number(ffBSnap.cargo[0].grossWt)).toBe(NEW_GROSS_WT);
    expect(ffBSnap.cargo[0].packageId).toBe(pkg1Id);

    // The re-freeze also re-resolves the charge-config two-gate (SB6, buildChargeConfigSnapshot)
    // onto the SAME refreshed quote — a proper JSON object, not stale/null.
    expect(quoteBAfter?.chargeConfigSnapshot).not.toBeNull();
    expect(typeof quoteBAfter?.chargeConfigSnapshot).toBe("object");

    // L1 reopened.
    const leg1After = await prisma.leg.findUnique({ where: { id: leg1.id } });
    expect(leg1After?.status).toBe("READY_FOR_RFQ");

    // Exactly one durable ChangeLog row, with the reason + FF-A's pricing snapshot. entity/
    // entityId now name the PACKAGE (grossWt moved off Cargo — package.impact.ts).
    const logs = await prisma.changeLog.findMany({ where: { queryId: query.id, changeType: "change-order" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].entity).toBe("package");
    expect(logs[0].entityId).toBe(pkg1Id);
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
    expect(payload.affectedScope).toEqual([{ type: "leg", id: leg1.id }]); // L2 not in scope
    expect(payload.invalidatedQuotes).toHaveLength(1);
    expect(payload.invalidatedQuotes[0].quoteId).toBe(quoteA.id);
    expect(payload.invalidatedQuotes[0].freightForwarderId).toBe(ffA.id);
    expect(Number(payload.invalidatedQuotes[0].grandTotal)).toBe(FF_A_GRAND_TOTAL);
    expect(payload.invalidatedQuotes[0].currency).toBe("USD");
    expect(payload.refreshedQuotes).toEqual([{ quoteId: quoteB.id, freightForwarderId: ffB.id }]);

    // One rfq.leg.reopened MessageLog to FF-A; FF-B (pending) is NOT notified (design §11.4).
    const ffAMsg = await prisma.messageLog.findFirst({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "rfq.leg.reopened", toAddress: ffA.email },
    });
    expect(ffAMsg).not.toBeNull();
    expect(ffAMsg?.channel).toBe("EMAIL");
    expect(ffAMsg?.subject).toContain(rfqA.rfqNumber);
    expect(ffAMsg?.bodyRendered).toContain("L1");
    expect(ffAMsg?.bodyRendered).toContain(REASON);
    const ffBMsg = await prisma.messageLog.findFirst({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "rfq.leg.reopened", toAddress: ffB.email },
    });
    expect(ffBMsg).toBeNull();

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3 — minimal blast radius: L2 / FF-C are completely untouched by the L1 cascade.
    // ─────────────────────────────────────────────────────────────────────────
    const leg2After = await prisma.leg.findUnique({ where: { id: leg2.id } });
    expect(leg2After?.status).toBe("FULLY_QUOTED"); // unchanged

    const quoteCAfter = await prisma.quote.findUnique({ where: { id: quoteC.id } });
    expect(quoteCAfter?.status).toBe(QuoteStatus.QUOTED); // NOT invalidated
    expect(Number(quoteCAfter?.grandTotal)).toBe(FF_C_GRAND_TOTAL);
    const ffCSnap = quoteCAfter?.manifestSnapshot as unknown as {
      cargo: { grossWt: string; packageId: string }[];
    };
    expect(ffCSnap.cargo[0].grossWt).toBe(String(CARGO2_GROSS_WT)); // NOT refreshed, NOT touched
    expect(ffCSnap.cargo[0].packageId).toBe(pkg2Id);

    const ffCMsg = await prisma.messageLog.findFirst({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "rfq.leg.reopened", toAddress: ffC.email },
    });
    expect(ffCMsg).toBeNull(); // never notified — was never in scope

    // ─────────────────────────────────────────────────────────────────────────
    // Step 4 — re-distribute the reopened L1: FF-A's INVALID quote reactivates (Task 11), the
    // SAME row (never a second one), and its Rfq's submissionDeadline resets to a fresh window.
    // ─────────────────────────────────────────────────────────────────────────
    const redistributed = await rfqService.distributeLeg(query.id, leg1.id, {}, user);
    expect(redistributed.rfqs).toHaveLength(1);
    expect(redistributed.rfqs[0].minted).toBe(false); // amended, not re-minted
    expect(redistributed.rfqs[0].rfqId).toBe(rfqA.id);

    const quoteAFinal = await prisma.quote.findUnique({ where: { id: quoteA.id } });
    expect(quoteAFinal?.id).toBe(quoteA.id); // SAME row — not a second quote
    expect(quoteAFinal?.status).toBe(QuoteStatus.RFQ_SENT);

    const rfqAAfter = await prisma.rfq.findUnique({ where: { id: rfqA.id } });
    expect(rfqAAfter?.submissionDeadline.getTime()).toBeGreaterThan(rfqA.submissionDeadline.getTime());
    expect(rfqAAfter?.submissionDeadline.getTime()).toBeGreaterThan(Date.now());
  });
});
