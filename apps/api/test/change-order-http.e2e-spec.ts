process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { createHash, randomUUID } from "node:crypto";
import { ConflictException, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";
import { QuoteStatus, Role } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { LegsService } from "../src/modules/legs/legs.service";
import { seedReferenceData } from "../src/seed/reference-seed";
import type { RequestUser } from "../src/modules/auth/types";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

// Task 10 (SB6): surfaces ChangeOrderStrategy's two-phase preview/apply (Tasks 7-8) at the
// mediated-service boundary. A PATCH that lands on the change-order path (RfqDefining-or-
// heavier field on a leg with live quotes) WITHOUT a `reason` must reject with a
// ConflictException carrying `needsChangeOrder: true` + the blast-radius `preview`, and apply
// NOTHING; the SAME patch WITH a `reason` must run the Task 8 saga exactly as before.
//
// Cargo→Package re-model (Unit 5 ripple): the leg's cargo fixture is now built via the shared
// `createCargoWithPackages`/`assignPackagesToLeg` helper (Cargo→Package + LegPackage) instead of
// the dropped flat CargoItem/LegCargo model. The edit under test here is still `entity: "leg"`
// (leg.mode) — leg-level classification is unaffected by the cargo grain — but the leg's
// re-frozen manifest (during the with-reason cascade below) now flows through the real
// package-grain freeze, so the fixture needs a real package assigned via LegPackage.
const PFX = "chg-order-http-";
const CODE = `${PFX}query`;
const FF_PREFIX = `FF-${PFX}`;
const REASON = "carrier changed the routing";

describe("Change-order 409 surface + reason plumbing (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let legsService: LegsService;
  const actorId = randomUUID(); // soft reference (no FK) — same convention as Query.assignedUserId
  const user: RequestUser = { userId: actorId, role: Role.EXECUTIVE, tenantId: null };

  // Self-contained cleanup, FK-safe: quotes first (frees FF/query Restrict FKs) → rfqs (before
  // the FF they Restrict) → query (cascades points/legs/legPackages/cargo/packages/items) → FFs
  // swept last.
  const cleanup = async () => {
    const q = await prisma.query.findUnique({ where: { queryCode: CODE }, select: { id: true } });
    if (q) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.notification.deleteMany({ where: { recipientUserId: actorId } });
      await prisma.messageLog.deleteMany({ where: { entityType: "QUERY", entityId: q.id } });
      await prisma.changeLog.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: FF_PREFIX } },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // boots @OnEvent subscribers (the notify handler) + all lifecycle hooks
    prisma = moduleRef.get(PrismaService);
    legsService = moduleRef.get(LegsService);
    await cleanup();
    // create-only upserts: guarantee the rfq.leg.reopened template + density factors exist
    // regardless of test order/DB state (CI has no seed step of its own) — the with-reason
    // path below runs the real saga, which notifies.
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
        modes: ["AIR", "ROAD"],
        status: "ACTIVE",
      },
    });

  it("PATCH-equivalent leg.mode edit: 409+preview without reason (nothing applied); applies + invalidates with reason", async () => {
    // --- fixtures: a distributed leg (one QUOTED FF, one RFQ_SENT FF). Origin/destination are
    //     PICKUP/DELIVERY (not AIRPORT/SEAPORT) so V-M1 never blocks the AIR→ROAD edit below —
    //     ROAD is endpoint-agnostic (checkModeEndpoints), so only `mode`'s RfqDefining
    //     classification + the leg's live quotes drive the change-order fork here.
    const query = await prisma.query.create({
      data: { queryCode: CODE, assignedUserId: actorId, incoterms: "FOB" },
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
      packages: [{ dimL: 10, dimW: 10, dimH: 10, grossWt: 100 }],
    });
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

    const ffQuoted = await mkFf(`${FF_PREFIX}QUOTED`);
    const ffSent = await mkFf(`${FF_PREFIX}SENT`);

    // ffQuoted already submitted → needs a real Rfq (rfqNumber + currency drive the snapshot +
    // the with-reason path's notify step).
    const rfqQuoted = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: ffQuoted.id,
        rfqNumber: `${CODE}-RFQ001`,
        accessTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        submissionDeadline: new Date(Date.now() + 86400000),
        currency: "USD",
      },
    });
    const quoteQuoted = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffQuoted.id,
        rfqId: rfqQuoted.id,
        status: QuoteStatus.QUOTED,
        grandTotal: 4200,
        totalChargeableWeightT: 1.5,
        manifestSnapshot: { legId: leg.id, mode: "AIR" } as unknown as Prisma.InputJsonValue,
      },
    });
    const quoteSent = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ffSent.id,
        status: QuoteStatus.RFQ_SENT,
        manifestSnapshot: { legId: leg.id, mode: "AIR" } as unknown as Prisma.InputJsonValue,
      },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // (1) WITHOUT reason: the mediated update rejects with a 409-shaped ConflictException
    //     carrying needsChangeOrder + the blast-radius preview — and applies NOTHING.
    // ─────────────────────────────────────────────────────────────────────────
    let caught: unknown;
    try {
      await legsService.update(query.id, leg.id, { mode: "ROAD" }, user);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const exception = caught as ConflictException;
    expect(exception.getStatus()).toBe(409);
    const body = exception.getResponse() as {
      message: string;
      needsChangeOrder: boolean;
      preview: {
        affectedLegs: string[];
        impactClass: string;
        invalidatingQuotes: { quoteId: string; freightForwarderId: string }[];
        refreshingQuotes: { quoteId: string; freightForwarderId: string }[];
      };
    };
    expect(body.needsChangeOrder).toBe(true);
    expect(body.preview).toBeDefined();
    expect(body.preview.affectedLegs).toEqual([leg.id]);
    expect(body.preview.impactClass).toBe("RfqDefining");
    expect(body.preview.invalidatingQuotes).toEqual([
      { quoteId: quoteQuoted.id, freightForwarderId: ffQuoted.id },
    ]);
    expect(body.preview.refreshingQuotes).toEqual([
      { quoteId: quoteSent.id, freightForwarderId: ffSent.id },
    ]);

    // Nothing was written: the leg's mode is unchanged and both quotes keep their prior status.
    const legAfterPreview = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(legAfterPreview?.mode).toBe("AIR");
    expect(legAfterPreview?.status).toBe("PARTIALLY_QUOTED");
    const quoteQuotedAfterPreview = await prisma.quote.findUnique({
      where: { id: quoteQuoted.id },
    });
    expect(quoteQuotedAfterPreview?.status).toBe(QuoteStatus.QUOTED);

    // ─────────────────────────────────────────────────────────────────────────
    // (2) WITH reason: resolves normally (no throw), the edit lands, and the saga cascades —
    //     the QUOTED quote is invalidated, the RFQ_SENT one is left pending (refreshed).
    // ─────────────────────────────────────────────────────────────────────────
    const updated = await legsService.update(
      query.id,
      leg.id,
      { mode: "ROAD", reason: REASON },
      user,
    );
    expect(updated.mode).toBe("ROAD");

    const legAfterApply = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(legAfterApply?.mode).toBe("ROAD");
    expect(legAfterApply?.status).toBe("READY_FOR_RFQ"); // reopened

    const quoteQuotedAfterApply = await prisma.quote.findUnique({ where: { id: quoteQuoted.id } });
    expect(quoteQuotedAfterApply?.status).toBe(QuoteStatus.INVALID);

    const quoteSentAfterApply = await prisma.quote.findUnique({ where: { id: quoteSent.id } });
    expect(quoteSentAfterApply?.status).toBe(QuoteStatus.RFQ_SENT); // still pending, not invalidated

    // The durable ChangeLog carries the reason (one row from the with-reason call only).
    const logs = await prisma.changeLog.findMany({
      where: { queryId: query.id, changeType: "change-order" },
    });
    expect(logs).toHaveLength(1);
    expect((logs[0].payload as { reason: string }).reason).toBe(REASON);
  });
});
