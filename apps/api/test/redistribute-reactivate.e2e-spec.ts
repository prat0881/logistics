process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { createHash, randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import { Role, ACCESS_TOKEN_COOKIE, QuoteStatus, type ManifestSnapshot } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";

// Task 11 (SB6): re-distributing a REOPENED leg (READY_FOR_RFQ, post-change-order) must
// reactivate its INVALID quote(s) — the SAME row (Quote @@unique([legId, freightForwarderId])
// forbids a 2nd row per leg×FF) fires QuoteEvent.SEND (INVALID→RFQ_SENT, the Task 5 edge),
// re-freezes its manifestSnapshot from the CURRENT leg/cargo data, and AMENDS (never re-mints)
// the FF's existing Rfq — resetting its submissionDeadline to a fresh window.
//
// Fixtures build the "post-change-order" state directly via prisma (leg READY_FOR_RFQ + an
// INVALID quote + its pre-existing Rfq — exactly what Task 8's apply saga produces) rather
// than re-running that whole saga; see change-order-apply.e2e-spec.ts for the saga itself.
const PREFIX = "RFQ-REDIST";
const CODE = `YAL00-${PREFIX}`;

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  const mkFf = (code: string) =>
    prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `${code}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["AIR"],
        status: "ACTIVE",
      },
    });

  // Self-clean fixtures + the non-cascaded comms rows (ScheduledEvent/MessageLog reference
  // entityId as a plain string, not a Prisma relation, so they survive a Query/Rfq delete —
  // same pattern as rfq-distribute-comms.e2e-spec.ts).
  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    const queryIds = qs.map((q) => q.id);
    const rfqs = queryIds.length
      ? await prisma.rfq.findMany({ where: { queryId: { in: queryIds } }, select: { id: true } })
      : [];
    const rfqIds = rfqs.map((r) => r.id);

    if (rfqIds.length) {
      await prisma.scheduledEvent.deleteMany({ where: { entityType: "RFQ", entityId: { in: rfqIds } } });
    }
    if (queryIds.length) {
      await prisma.messageLog.deleteMany({ where: { entityType: "QUERY", entityId: { in: queryIds } } });
    }
    for (const q of qs) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/cargo/legCargo
    }
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } } });
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
    await cleanup();
    // create-only upserts: guarantees the rfq.updated / rfq.invitation templates + reminder/
    // deadline AppSettings exist regardless of test order/DB state (CI has no seed step).
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  const OLD_GROSS_WT = 111; // kg — deliberately wrong vs. the live cargo, so a refreshed
  // manifest is provably rebuilt from CURRENT data, not just re-stamped.

  // A stale manifest snapshot, as the ORIGINAL distribution would have frozen it before the
  // change-order invalidated this quote (mirrors change-order-apply.e2e-spec.ts's oldSnapshot).
  const oldSnapshot = (legId: string, cargoItemId: string) => ({
    legId,
    frozenAt: "2020-01-01T00:00:00.000Z",
    mode: "SEA", // the live leg is AIR — proves the whole snapshot is rebuilt, not patched
    cargo: [{ cargoItemId, grossWt: String(OLD_GROSS_WT) }],
  });

  it("reactivates an INVALID quote on re-distribute: RFQ_SENT, manifest refreshed, deadline reset, FF notified", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    // --- fixtures: the "post-change-order" state (what Task 8's apply saga would have left) ---
    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });
    const cargo = await prisma.cargoItem.create({
      data: {
        queryId: query.id,
        rowIndex: 0,
        poReference: "PO-REDIST-1",
        productName: "Widget",
        packageType: "BOX",
        qty: 1,
        dimL: 10,
        dimW: 10,
        dimH: 10,
        grossWt: 250,
        isDangerous: false,
      },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-REDIST-1",
        mode: "AIR",
        status: "READY_FOR_RFQ", // reopened by the change-order cascade
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legCargo: { create: { cargoItemId: cargo.id } },
      },
    });
    const ff = await mkFf(`FF-${PREFIX}-A`);

    // The FF's Rfq from the ORIGINAL distribution — invalidation never deletes it (non-
    // destructive, §11.3). Its window has lapsed, simulating time having passed.
    const oldDeadline = new Date(Date.now() - 3600_000);
    const rfq = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: ff.id,
        rfqNumber: `${CODE}-RFQ001`,
        accessTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        submissionDeadline: oldDeadline,
        incoterms: "FOB",
        currency: "USD",
      },
    });
    const quote = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ff.id,
        rfqId: rfq.id,
        status: QuoteStatus.INVALID,
        manifestSnapshot: oldSnapshot(leg.id, cargo.id) as unknown as Prisma.InputJsonValue,
      },
    });

    // The FF's reminder + expiry timers from the ORIGINAL distribution — never cancelled by
    // the change-order invalidation, still keyed to the OLD (lapsed) deadline. Tier keys match
    // what performDistribution will recompute (T24H is one of DEFAULT_RFQ_REMINDER_OFFSETS
    // [36,24,12,6,2]; DEADLINE is rfq.expiry's only tier) so schedule()'s upsert would
    // otherwise find-and-no-op these SAME rows on redistribute. Covers BOTH concrete breakage
    // modes in one fixture: the reminder is still open (firedAt: null — "redistribute before
    // the old deadline lapses" would otherwise fire EXPIRE too early); the expiry already FIRED
    // (firedAt set — "redistribute after the old deadline lapsed" would otherwise leave the
    // reactivated quote with NO expiry at all, since runDue() only ever revisits firedAt:null
    // rows, and ScheduledEventService.cancel()'s own WHERE clause requires firedAt:null too —
    // it could never even touch this row).
    const staleReminder = await prisma.scheduledEvent.create({
      data: {
        entityType: "RFQ", entityId: rfq.id, eventKey: "rfq.reminder", tier: "T24H",
        dueAt: new Date(oldDeadline.getTime() - 24 * 3600_000),
      },
    });
    const staleExpiry = await prisma.scheduledEvent.create({
      data: {
        entityType: "RFQ", entityId: rfq.id, eventKey: "rfq.expiry", tier: "DEADLINE", dueAt: oldDeadline,
        firedAt: oldDeadline,
      },
    });

    // --- act: re-distribute the reopened leg. No ff-selection call — an INVALID quote is
    //     already "frozen" (setFfSelection only manages SELECT rows), so the FF is implicitly
    //     still selected. ---
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    // --- assert: the SAME Rfq was amended, not re-minted ---
    expect(res.body.rfqs).toHaveLength(1);
    const entry = res.body.rfqs[0];
    expect(entry.minted).toBe(false);
    expect(entry.rfqId).toBe(rfq.id);
    expect(entry.rfqNumber).toBe(rfq.rfqNumber);
    expect(entry.accessToken).toBeUndefined();

    // --- assert: quote reactivated INVALID → RFQ_SENT, SAME row (no 2nd quote created) ---
    const quotesForFf = await prisma.quote.findMany({ where: { legId: leg.id, freightForwarderId: ff.id } });
    expect(quotesForFf).toHaveLength(1);
    const quoteAfter = quotesForFf[0];
    expect(quoteAfter.id).toBe(quote.id);
    expect(quoteAfter.status).toBe(QuoteStatus.RFQ_SENT);
    expect(quoteAfter.rfqId).toBe(rfq.id);

    // --- assert: manifestSnapshot refreshed from LIVE leg/cargo data, not the stale one ---
    const snap = quoteAfter.manifestSnapshot as unknown as ManifestSnapshot;
    expect(snap.mode).toBe("AIR"); // stale snapshot said "SEA"
    expect(snap.cargo).toHaveLength(1);
    expect(Number(snap.cargo[0].grossWt)).toBe(250); // stale snapshot said 111
    expect(new Date(snap.frozenAt).getTime()).toBeGreaterThan(Date.now() - 60_000); // just re-frozen

    // --- assert: Rfq.submissionDeadline reset to a fresh future window (default ~48h) ---
    const rfqAfter = await prisma.rfq.findUnique({ where: { id: rfq.id } });
    expect(rfqAfter!.submissionDeadline.getTime()).toBeGreaterThan(oldDeadline.getTime());
    expect(rfqAfter!.submissionDeadline.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);

    // --- assert: the leg was re-sent (READY_FOR_RFQ → RFQ_SENT) ---
    expect((await prisma.leg.findUnique({ where: { id: leg.id } }))?.status).toBe("RFQ_SENT");

    // --- assert: the STALE reminder/expiry timers were cleared and re-armed off the NEW
    //     deadline, not left pointing at the old lapsed one (schedule()'s upsert is a no-op on
    //     an existing (entityType,entityId,eventKey,tier) row, so a naive re-call alone would
    //     NOT move dueAt — this only holds if redistribute actively clears the stale rows first) ---
    const expiryAfter = await prisma.scheduledEvent.findFirst({
      where: { entityType: "RFQ", entityId: rfq.id, eventKey: "rfq.expiry", tier: "DEADLINE" },
    });
    expect(expiryAfter).not.toBeNull();
    expect(expiryAfter!.dueAt.getTime()).toBe(rfqAfter!.submissionDeadline.getTime());
    expect(expiryAfter!.dueAt.getTime()).toBeGreaterThan(staleExpiry.dueAt.getTime());
    expect(expiryAfter!.firedAt).toBeNull();
    expect(expiryAfter!.cancelledAt).toBeNull();

    const reminderAfter = await prisma.scheduledEvent.findFirst({
      where: { entityType: "RFQ", entityId: rfq.id, eventKey: "rfq.reminder", tier: "T24H" },
    });
    expect(reminderAfter).not.toBeNull();
    expect(reminderAfter!.dueAt.getTime()).toBeGreaterThan(staleReminder.dueAt.getTime());
    expect(reminderAfter!.firedAt).toBeNull();
    expect(reminderAfter!.cancelledAt).toBeNull();

    // --- assert: the FF was notified. The Rfq pre-existed (amend, not mint), so this reuses
    //     the SAME "RFQ Updated" path an ordinary amend uses (D3) — no new template needed. ---
    const msg = await prisma.messageLog.findFirst({
      where: { entityType: "QUERY", entityId: query.id, eventKey: "rfq.updated", toAddress: ff.email },
    });
    expect(msg).not.toBeNull();
    expect(msg?.subject).toContain(rfq.rfqNumber);
  });

  it("a SELECT (fresh) quote still distributes normally (unaffected by the reactivation path)", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    const query = await prisma.query.create({ data: { queryCode: `${CODE}-FRESH`, incoterms: "FOB" } });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });
    const cargo = await prisma.cargoItem.create({
      data: {
        queryId: query.id,
        rowIndex: 0,
        poReference: "PO-REDIST-FRESH",
        productName: "Widget",
        packageType: "BOX",
        qty: 1,
        dimL: 10,
        dimW: 10,
        dimH: 10,
        grossWt: 5,
        isDangerous: false,
      },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-REDIST-FRESH",
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legCargo: { create: { cargoItemId: cargo.id } },
      },
    });
    const ff = await mkFf(`FF-${PREFIX}-FRESH`);

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    expect(res.body.rfqs).toHaveLength(1);
    expect(res.body.rfqs[0].minted).toBe(true); // brand-new FF on this query → mints

    const quote = await prisma.quote.findFirst({ where: { legId: leg.id, freightForwarderId: ff.id } });
    expect(quote?.status).toBe("RFQ_SENT");
    expect(quote?.manifestSnapshot).toMatchObject({ legId: leg.id, mode: "AIR" });
  });

  it("distribute-all reactivates a reopened INVALID-only leg instead of skipping it as already-distributed", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    const query = await prisma.query.create({ data: { queryCode: `${CODE}-ALL`, incoterms: "FOB" } });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });
    const cargo = await prisma.cargoItem.create({
      data: {
        queryId: query.id,
        rowIndex: 0,
        poReference: "PO-REDIST-ALL",
        productName: "Widget",
        packageType: "BOX",
        qty: 1,
        dimL: 10,
        dimW: 10,
        dimH: 10,
        grossWt: 42,
        isDangerous: false,
      },
    });
    // Reopened leg (READY_FOR_RFQ) whose ONLY quote is INVALID — the "distributeAll silently
    // skips this" bug the fix closes: without `&& ctx.invalidQuotes.length === 0` on the gate,
    // `ctx.freshQuotes.length === 0` alone would mark it "already-distributed" and never call
    // performDistribution for it at all.
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-REDIST-ALL",
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legCargo: { create: { cargoItemId: cargo.id } },
      },
    });
    const ff = await mkFf(`FF-${PREFIX}-ALL`);
    const oldDeadline = new Date(Date.now() - 3600_000);
    const rfq = await prisma.rfq.create({
      data: {
        queryId: query.id,
        freightForwarderId: ff.id,
        rfqNumber: `${CODE}-ALL-RFQ001`,
        accessTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        submissionDeadline: oldDeadline,
        incoterms: "FOB",
        currency: "USD",
      },
    });
    const quote = await prisma.quote.create({
      data: {
        queryId: query.id,
        legId: leg.id,
        freightForwarderId: ff.id,
        rfqId: rfq.id,
        status: QuoteStatus.INVALID,
        manifestSnapshot: oldSnapshot(leg.id, cargo.id) as unknown as Prisma.InputJsonValue,
      },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/distribute-all`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    // NOT skipped — actually distributed
    expect(res.body.skipped).not.toEqual(expect.arrayContaining([expect.objectContaining({ legId: leg.id })]));
    expect(res.body.distributedLegIds).toContain(leg.id);

    const quoteAfter = await prisma.quote.findUnique({ where: { id: quote.id } });
    expect(quoteAfter?.status).toBe(QuoteStatus.RFQ_SENT);
    expect(quoteAfter?.rfqId).toBe(rfq.id);

    const rfqAfter = await prisma.rfq.findUnique({ where: { id: rfq.id } });
    expect(rfqAfter!.submissionDeadline.getTime()).toBeGreaterThan(oldDeadline.getTime());

    expect((await prisma.leg.findUnique({ where: { id: leg.id } }))?.status).toBe("RFQ_SENT");
  });
});
