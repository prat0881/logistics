process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import { Role, ACCESS_TOKEN_COOKIE, type QuoteDraft } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { QUERY_LOCKED_MESSAGE } from "../src/modules/award/query-lock.service";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

// S5.9.5 Task 5 (design D6) — "a locked query refuses every write except Reopen and the
// quotation builder". Locked = `Query.awardSnapshot != null`, i.e. QUOTING_CLIENT or (once a
// letter has been issued) AWAITING_CLIENT_DECISION.
//
// Three tests, and all three are load-bearing:
//   1. `LOCKED_WRITES` × the locked query — every gated endpoint answers 409 + the one copy string.
//   2. the exceptions — all three `queries/:id/quotation` writes AND `reopen-comparison` still
//      work while locked. The lock exists so the client quotation can be composed and issued;
//      gating those would make the locked state a dead end.
//   3. `LOCKED_WRITES` × an UNLOCKED query — the positive control for the whole table. Without
//      it, a guard misplaced so that it fires unconditionally passes test 1 with a full green
//      board.
const PREFIX = "QLCK";
const CODE = `YAL00-${PREFIX}`;

// Four-eyes: the maker who sends a leg for approval must not be the checker who decides it.
const SENDER_ID = randomUUID();
const CHECKER_ID = randomUUID();
const EXEC_ID = randomUUID();

/**
 * Every id a `LOCKED_WRITES` row needs to address a real entity. Two shapes fill it:
 *
 *  - `approveAll: true` (the LOCKED and the generate-control scenarios) — the query carries ONLY
 *    fully-approved legs, because `generate-client-quote` refuses a query with any undecided leg.
 *    The per-action leg slots below all point at that same approved leg: the lock is the FIRST
 *    operation of every gated method, so on a locked query the leg's state never gets read.
 *  - `approveAll: false` (the OPEN scenario) — a leg per action, each parked in the state that
 *    action legitimately succeeds from, so test 3 can assert real success codes.
 */
type Ctx = {
  queryId: string;
  /** Leg carrying a live, priced, comparable offer — the send-for-approval target. */
  legId: string;
  quoteId: string;
  /** Leg with NO quotes — safe target for a mediated leg PATCH/DELETE (a @delete on a leg with
   *  live quotes forks to the change-order path and 409s for an unrelated reason). */
  spareLegId: string;
  approveLegId: string;
  rejectLegId: string;
  requoteLegId: string;
  requoteQuoteId: string;
  /** Leg for `PUT ff-selection`. Deliberately has no packages, so `distribute-all` skips it
   *  (F1_INCOMPLETE_LEG) however the SELECT quote this row mints interleaves with that row. */
  selLegId: string;
  /** Fully distributable leg (packages, dates, mode, READY_FOR_RFQ) with a SELECT quote. */
  distLegId: string;
  /** An ACTIVE forwarder that is NOT yet selected anywhere — the `ff-selection` payload. */
  ffId: string;
  /** A forwarder that already has an `Rfq` row on this query — `reissue-token` needs one. */
  reissueFfId: string;
  cargoId: string;
  spareCargoId: string;
  packageId: string;
  sparePackageId: string;
  itemId: string;
  spareItemId: string;
  pointId: string;
  /** A point referenced by NO leg — `PointsService.remove` refuses one that a leg still uses. */
  sparePointId: string;
  checklistKey: string;
};

type Row = {
  /** Shown by `it.each`'s `$name`. */
  name: string;
  method: "post" | "patch" | "put" | "delete";
  url: (c: Ctx) => string;
  body?: (c: Ctx) => Record<string, unknown>;
  /** Role the route's own `@Roles` requires — a wrong role would 403 before the guard ever runs. */
  role?: Role;
  /** Actor id. Defaults to EXEC_ID; approve/reject use CHECKER_ID for four-eyes. */
  actorId?: string;
  /** Multipart upload instead of a JSON body (the MSDS route). */
  attach?: { field: string; filename: string; buffer: () => Buffer };
  /** Status this same write returns on a NOT-locked query — test 3's assertion. */
  openStatus: number;
  /** Which unlocked scenario test 3 runs this row against. Default: the shared OPEN one. */
  openScenario?: "open" | "openGen";
};

// The DERIVED query-scoped write surface (see the task report for the grep this came from).
// `queries/:id/quotation` and `reopen-comparison` are absent BY DESIGN — they are D6's two
// exceptions and are covered by test 2 instead.
const LOCKED_WRITES: Row[] = [
  // ── queries.controller.ts ───────────────────────────────────────────────────────────────
  {
    name: "PATCH /queries/:id",
    method: "patch",
    url: (c) => `/api/queries/${c.queryId}`,
    // `internalNotes` is Internal in query.impact.ts, so the mediator free-paths it on any query
    // — the row is testing the lock, not the change-order fork.
    body: () => ({ internalNotes: `${PREFIX} note` }),
    openStatus: 200,
  },
  {
    name: "POST /queries/:id/create",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/create`,
    // 422, not 201: both fixtures are deliberately incomplete (no client, no contact phone, no
    // dates), so create-phase validation answers with blocking findings. That is precisely the
    // point for a positive control — the request reached the real validator instead of the lock.
    openStatus: 422,
  },
  {
    name: "PATCH /queries/:id/checklist",
    method: "patch",
    url: (c) => `/api/queries/${c.queryId}/checklist`,
    body: (c) => ({ items: [{ itemKey: c.checklistKey, checked: true }] }),
    openStatus: 200,
  },

  // ── legs.controller.ts ──────────────────────────────────────────────────────────────────
  {
    name: "POST /queries/:id/legs",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/legs`,
    body: () => ({ legName: `${PREFIX} new leg` }),
    openStatus: 201,
  },
  {
    name: "PATCH /queries/:id/legs/:legId",
    method: "patch",
    url: (c) => `/api/queries/${c.queryId}/legs/${c.spareLegId}`,
    body: () => ({ legName: `${PREFIX} renamed` }),
    openStatus: 200,
  },
  {
    name: "DELETE /queries/:id/legs/:legId",
    method: "delete",
    url: (c) => `/api/queries/${c.queryId}/legs/${c.spareLegId}`,
    openStatus: 204,
  },

  // ── points.controller.ts (NOT in the brief's table — see the report) ────────────────────
  {
    name: "POST /queries/:id/points",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/points`,
    body: () => ({ type: "DELIVERY", city: "Dubai", country: "AE" }),
    openStatus: 201,
  },
  {
    name: "PATCH /queries/:id/points/:pointId",
    method: "patch",
    url: (c) => `/api/queries/${c.queryId}/points/${c.sparePointId}`,
    body: () => ({ name: `${PREFIX} renamed point` }),
    openStatus: 200,
  },
  {
    name: "DELETE /queries/:id/points/:pointId",
    method: "delete",
    url: (c) => `/api/queries/${c.queryId}/points/${c.sparePointId}`,
    openStatus: 204,
  },

  // ── cargo.controller.ts ─────────────────────────────────────────────────────────────────
  {
    name: "POST /queries/:id/cargo",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/cargo`,
    body: () => ({ label: `${PREFIX} cargo` }),
    openStatus: 201,
  },
  {
    name: "PATCH /queries/:id/cargo/:cid",
    method: "patch",
    url: (c) => `/api/queries/${c.queryId}/cargo/${c.cargoId}`,
    body: () => ({ label: `${PREFIX} relabelled` }),
    openStatus: 200,
  },
  {
    name: "DELETE /queries/:id/cargo/:cid",
    method: "delete",
    url: (c) => `/api/queries/${c.queryId}/cargo/${c.spareCargoId}`,
    openStatus: 204,
  },

  // ── package.controller.ts ───────────────────────────────────────────────────────────────
  {
    name: "POST /queries/:id/cargo/:cid/packages",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/cargo/${c.cargoId}/packages`,
    body: () => ({
      packageNo: `${PREFIX}-NEW-${randomUUID().slice(0, 8)}`,
      packageType: "PALLET",
      dimL: 10,
      dimW: 10,
      dimH: 10,
      grossWt: 5,
    }),
    openStatus: 201,
  },
  {
    name: "PATCH /queries/:id/cargo/:cid/packages/:pid",
    method: "patch",
    url: (c) => `/api/queries/${c.queryId}/cargo/${c.cargoId}/packages/${c.packageId}`,
    // `tags` is Corrective in package.impact.ts (dims/weights are RfqDefining and would fork to
    // the change-order path on a leg that already carries live quotes).
    body: () => ({ tags: [] }),
    openStatus: 200,
  },
  {
    name: "POST /queries/:id/cargo/:cid/packages/:pid/msds",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/cargo/${c.cargoId}/packages/${c.packageId}/msds`,
    attach: { field: "file", filename: "msds.pdf", buffer: () => Buffer.from("%PDF-1.4\n%qlck\n") },
    openStatus: 201,
  },
  {
    name: "POST /queries/:id/cargo/:cid/packages/:pid/copies",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/cargo/${c.cargoId}/packages/${c.sparePackageId}/copies`,
    body: () => ({ count: 2 }),
    openStatus: 201,
  },
  {
    name: "DELETE /queries/:id/cargo/:cid/packages/:pid",
    method: "delete",
    url: (c) => `/api/queries/${c.queryId}/cargo/${c.cargoId}/packages/${c.sparePackageId}`,
    openStatus: 204,
  },

  // ── item.controller.ts ──────────────────────────────────────────────────────────────────
  {
    name: "POST /queries/:id/cargo/:cid/packages/:pid/items",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/cargo/${c.cargoId}/packages/${c.packageId}/items`,
    body: () => ({ product: `${PREFIX} widget` }),
    openStatus: 201,
  },
  {
    name: "PATCH /queries/:id/cargo/:cid/packages/:pid/items/:iid",
    method: "patch",
    url: (c) =>
      `/api/queries/${c.queryId}/cargo/${c.cargoId}/packages/${c.packageId}/items/${c.itemId}`,
    body: () => ({ product: `${PREFIX} renamed widget` }),
    openStatus: 200,
  },
  {
    name: "DELETE /queries/:id/cargo/:cid/packages/:pid/items/:iid",
    method: "delete",
    url: (c) =>
      `/api/queries/${c.queryId}/cargo/${c.cargoId}/packages/${c.packageId}/items/${c.spareItemId}`,
    openStatus: 204,
  },

  // ── rfq.controller.ts ───────────────────────────────────────────────────────────────────
  {
    name: "PUT /queries/:id/legs/:legId/ff-selection",
    method: "put",
    url: (c) => `/api/queries/${c.queryId}/legs/${c.selLegId}/ff-selection`,
    body: (c) => ({ ffIds: [c.ffId] }),
    openStatus: 200,
  },
  {
    name: "POST /queries/:id/legs/:legId/distribute",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/legs/${c.distLegId}/distribute`,
    // `confirm: true` makes this row order-independent against the `distribute-all` row below:
    // whichever runs first, the second gets a 201 "already-distributed" result instead of the
    // confirm-required 409 (which would be a 409 that is NOT the lock's).
    body: () => ({ confirm: true }),
    openStatus: 201,
  },
  {
    name: "POST /queries/:id/distribute-all",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/distribute-all`,
    body: () => ({ confirm: true }),
    openStatus: 201,
  },
  {
    name: "POST /queries/:id/rfqs/reissue-token",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/rfqs/reissue-token`,
    body: (c) => ({ freightForwarderId: c.reissueFfId }),
    openStatus: 201,
  },

  // ── award.controller.ts (reopen-comparison is EXCEPTED — test 2) ────────────────────────
  {
    name: "POST /queries/:id/legs/:legId/send-for-approval",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/legs/${c.legId}/send-for-approval`,
    body: (c) => ({ quoteId: c.quoteId, variant: "DEDICATED" }),
    actorId: SENDER_ID,
    role: Role.MANAGER,
    openStatus: 200,
  },
  {
    name: "POST /queries/:id/legs/:legId/approve",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/legs/${c.approveLegId}/approve`,
    role: Role.MANAGER,
    actorId: CHECKER_ID,
    openStatus: 200,
  },
  {
    name: "POST /queries/:id/legs/:legId/reject",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/legs/${c.rejectLegId}/reject`,
    body: () => ({ reason: `${PREFIX} not competitive` }),
    role: Role.MANAGER,
    actorId: CHECKER_ID,
    openStatus: 200,
  },
  {
    name: "POST /queries/:id/legs/:legId/quotes/:quoteId/request-requote",
    method: "post",
    url: (c) =>
      `/api/queries/${c.queryId}/legs/${c.requoteLegId}/quotes/${c.requoteQuoteId}/request-requote`,
    body: () => ({ comment: `${PREFIX} please sharpen` }),
    // D3 — Executive ONLY (deliberately excluding Manager/Administrator).
    role: Role.EXECUTIVE,
    openStatus: 200,
  },
  {
    name: "POST /queries/:id/generate-client-quote",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/generate-client-quote`,
    role: Role.MANAGER,
    // Its own unlocked scenario: generate refuses a query with any undecided leg, so it cannot
    // run against the mixed-state OPEN fixture — and succeeding LOCKS whatever it runs on.
    openScenario: "openGen",
    openStatus: 200,
  },

  // ── emails.controller.ts ────────────────────────────────────────────────────────────────
  {
    name: "POST /queries/:id/emails/follow-up",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/emails/follow-up`,
    openStatus: 201,
  },
  {
    name: "POST /queries/:id/emails/acknowledgement",
    method: "post",
    url: (c) => `/api/queries/${c.queryId}/emails/acknowledgement`,
    openStatus: 201,
  },
];

describe("S5.9.5 (D6) — a locked query refuses every write except Reopen and the quotation (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  let locked: Ctx;
  let open: Ctx;
  let openGen: Ctx;

  const cookieFor = (userId: string, role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: userId, role, tenantId: null })}`;

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

  // The minimal ROAD draft the award specs use — priced only on the DEDICATED variant, so
  // computeQuoteTotals yields exactly one comparable (nativeTotal, transitDays) pair per quote.
  const roadDraft = (legId: string, originPointId: string): QuoteDraft => ({
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
        amount: 83200,
        rateVariant: "DEDICATED",
        tonnage: null,
      },
    ],
    seaRates: [],
    warehouse: [],
    transit: {
      departureDate: null,
      arrivalDate: null,
      guaranteedTransitDaysByVariant: { DEDICATED: 3 },
    },
    dgSurchargeNote: null,
    termsConditions: null,
  });

  /**
   * One leg + its own dedicated FF/Rfq/Quote. `quoteStatus: null` leaves the leg quote-free.
   * `decision` seeds a LegAwardDecision directly (APPROVED = the state `approve()` leaves behind;
   * PENDING_APPROVAL = a send that has not been decided, with `SENDER_ID` as the maker so the
   * four-eyes rule lets `CHECKER_ID` decide it).
   */
  async function mkLeg(
    queryId: string,
    key: string,
    opts: {
      legCode: string;
      legStatus: string;
      originId: string;
      destId: string;
      quoteStatus: string | null;
      priced?: boolean;
      decision?: "APPROVED" | "PENDING_APPROVAL";
      packageIds?: string[];
      dated?: boolean;
    },
  ) {
    const leg = await prisma.leg.create({
      data: {
        queryId,
        legCode: opts.legCode,
        mode: "ROAD",
        originPointId: opts.originId,
        destinationPointId: opts.destId,
        status: opts.legStatus as never,
        ...(opts.dated ? { readyDate: new Date(), targetDelivery: future() } : {}),
      },
    });
    if (opts.packageIds?.length) await assignPackagesToLeg(prisma, leg.id, opts.packageIds);

    let quoteId: string | null = null;
    let ffId: string | null = null;
    if (opts.quoteStatus) {
      const ffRow = await mkFf(`FF-${PREFIX}-${key}`);
      ffId = ffRow.id;
      const rfq = await prisma.rfq.create({
        data: {
          queryId,
          freightForwarderId: ffRow.id,
          rfqNumber: `${CODE}-RFQ-${key}`,
          accessTokenHash: `hash-${PREFIX}-${key}`,
          submissionDeadline: future(),
          incoterms: "FOB",
          currency: "INR",
          quoteValidityUntil: new Date("2099-01-01T00:00:00.000Z"),
        },
      });
      const quote = await prisma.quote.create({
        data: {
          queryId,
          legId: leg.id,
          freightForwarderId: ffRow.id,
          rfqId: rfq.id,
          status: opts.quoteStatus as never,
          ...(opts.priced
            ? {
                submittedAt: new Date(),
                draftJson: roadDraft(leg.id, opts.originId) as unknown as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
      quoteId = quote.id;
    }

    if (opts.decision && quoteId) {
      await prisma.legAwardDecision.create({
        data: {
          legId: leg.id,
          queryId,
          shortlistedQuoteId: quoteId,
          shortlistedVariant: "DEDICATED",
          status: opts.decision,
          sentByUserId: SENDER_ID,
          sentForApprovalAt: new Date(),
          ...(opts.decision === "APPROVED"
            ? { decidedByUserId: CHECKER_ID, decidedAt: new Date() }
            : {}),
        },
      });
    }

    return { legId: leg.id, quoteId, ffId };
  }

  /** Legs are seeded straight through Prisma with hand-written legCodes, which never touches the
   *  per-query `CodeSequence` LegsService.create mints from. Without this the first leg created
   *  through the real endpoint would mint "L1" again and hit the (queryId, legCode) unique index —
   *  a 409 "Already exists" that has nothing to do with the lock. */
  const syncLegSequence = (queryId: string, seeded: number) =>
    prisma.codeSequence.upsert({
      where: { key: `LEG:${queryId}` },
      create: { key: `LEG:${queryId}`, lastNumber: seeded },
      update: { lastNumber: seeded },
    });

  /**
   * Build a whole scenario: query + checklist + points + cargo tree + legs.
   * `approveAll` shapes the leg set — see `Ctx`'s doc comment.
   */
  async function seedScenario(label: string, approveAll: boolean): Promise<Ctx> {
    const query = await prisma.query.create({
      data: {
        queryCode: `${CODE}-${label}`,
        priority: "HIGH",
        incoterms: "FOB",
        contactName: `${PREFIX} Contact`,
        // Required by the two emails endpoints (the dispatcher needs a recipient).
        contactEmail: `${PREFIX.toLowerCase()}@e2e.test`,
      },
    });

    const defs = await prisma.checklistDefinition.findMany({ orderBy: { order: "asc" } });
    await prisma.queryChecklistItem.createMany({
      data: defs.map((d) => ({ queryId: query.id, itemKey: d.itemKey })),
    });

    const pA = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", city: "Shanghai", country: "CN" },
    });
    const pB = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", city: "Dubai", country: "AE" },
    });
    // Referenced by no leg, so `PointsService.remove`'s leg-reference guard lets the DELETE row
    // through and the outcome under test is the lock, not that guard.
    const pSpare = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", city: "Jebel Ali", country: "AE" },
    });

    const main = await createCargoWithPackages(prisma, {
      queryId: query.id,
      rowIndex: 0,
      packages: [
        {
          packageNo: `${PREFIX}-${label}-MAIN`,
          items: [{ product: "main item" }, { product: "spare item" }],
        },
        { packageNo: `${PREFIX}-${label}-SPARE` },
      ],
    });
    // A second grouping with no packages at all — the cargo DELETE row's target. Deleting the
    // one that carries the legs' freight would fork to the change-order path on a quoted leg.
    const spareCargo = await createCargoWithPackages(prisma, {
      queryId: query.id,
      rowIndex: 1,
      packages: [],
    });

    if (approveAll) {
      // Two approved legs — exactly what `generate-client-quote` requires.
      const l1 = await mkLeg(query.id, `${label}-1`, {
        legCode: "L1",
        legStatus: "APPROVED",
        originId: pA.id,
        destId: pB.id,
        quoteStatus: "APPROVED",
        priced: true,
        decision: "APPROVED",
        packageIds: [main.packageIds[0]],
        dated: true,
      });
      const l2 = await mkLeg(query.id, `${label}-2`, {
        legCode: "L2",
        legStatus: "APPROVED",
        originId: pB.id,
        destId: pSpare.id,
        quoteStatus: "APPROVED",
        priced: true,
        decision: "APPROVED",
        dated: true,
      });
      await syncLegSequence(query.id, 2);
      const ffFree = await mkFf(`FF-${PREFIX}-${label}-FREE`);
      return {
        queryId: query.id,
        legId: l1.legId,
        quoteId: l1.quoteId!,
        spareLegId: l2.legId,
        approveLegId: l1.legId,
        rejectLegId: l1.legId,
        requoteLegId: l1.legId,
        requoteQuoteId: l1.quoteId!,
        selLegId: l1.legId,
        distLegId: l1.legId,
        ffId: ffFree.id,
        reissueFfId: l1.ffId!,
        cargoId: main.cargoId,
        spareCargoId: spareCargo.cargoId,
        packageId: main.packageIds[0],
        sparePackageId: main.packageIds[1],
        itemId: main.itemIds[0],
        spareItemId: main.itemIds[1],
        pointId: pA.id,
        sparePointId: pSpare.id,
        checklistKey: defs[0].itemKey,
      };
    }

    // OPEN: one leg per action, each in the state that action legitimately succeeds from.
    const send = await mkLeg(query.id, `${label}-send`, {
      legCode: "L1",
      legStatus: "FULLY_QUOTED",
      originId: pA.id,
      destId: pB.id,
      quoteStatus: "QUOTED",
      priced: true,
    });
    const approve = await mkLeg(query.id, `${label}-appr`, {
      legCode: "L2",
      legStatus: "FULLY_QUOTED",
      originId: pA.id,
      destId: pB.id,
      quoteStatus: "QUOTED",
      priced: true,
    });
    const reject = await mkLeg(query.id, `${label}-rej`, {
      legCode: "L3",
      legStatus: "FULLY_QUOTED",
      originId: pA.id,
      destId: pB.id,
      quoteStatus: "QUOTED",
      priced: true,
    });
    const requote = await mkLeg(query.id, `${label}-req`, {
      legCode: "L4",
      legStatus: "FULLY_QUOTED",
      originId: pA.id,
      destId: pB.id,
      quoteStatus: "QUOTED",
      priced: true,
    });
    // No packages on purpose — see `Ctx.selLegId`.
    const sel = await mkLeg(query.id, `${label}-sel`, {
      legCode: "L5",
      legStatus: "READY_FOR_RFQ",
      originId: pA.id,
      destId: pB.id,
      quoteStatus: null,
      dated: true,
    });
    const dist = await mkLeg(query.id, `${label}-dist`, {
      legCode: "L6",
      legStatus: "READY_FOR_RFQ",
      originId: pA.id,
      destId: pB.id,
      quoteStatus: null,
      packageIds: [main.packageIds[0]],
      dated: true,
    });
    const spareLeg = await mkLeg(query.id, `${label}-spare`, {
      legCode: "L7",
      legStatus: "DRAFT",
      originId: pA.id,
      destId: pB.id,
      quoteStatus: null,
    });

    // Reach PENDING_APPROVAL through the REAL maker endpoint rather than writing a
    // LegAwardDecision row by hand: `approve()` reads the send's own immutable StatusTransition
    // row to decide whether the send was permitted, so a hand-seeded decision can be refused for
    // reasons that have nothing to do with the lock. SENDER_ID is the maker, so CHECKER_ID can
    // decide both legs without tripping four-eyes.
    for (const target of [approve, reject]) {
      await request(app.getHttpServer())
        .post(`/api/queries/${query.id}/legs/${target.legId}/send-for-approval`)
        .set("Cookie", cookieFor(SENDER_ID, Role.MANAGER))
        .send({ quoteId: target.quoteId, variant: "DEDICATED" })
        .expect(200);
    }

    // Mint the SELECT quote `distribute` needs, through the real selection endpoint (the query
    // is not locked yet, so this seeding call is itself unaffected by the guard under test).
    const ffDist = await mkFf(`FF-${PREFIX}-${label}-dist`);
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${dist.legId}/ff-selection`)
      .set("Cookie", cookieFor(EXEC_ID, Role.EXECUTIVE))
      .send({ ffIds: [ffDist.id] })
      .expect(200);

    await syncLegSequence(query.id, 7);
    const ffFree = await mkFf(`FF-${PREFIX}-${label}-free`);
    return {
      queryId: query.id,
      legId: send.legId,
      quoteId: send.quoteId!,
      spareLegId: spareLeg.legId,
      approveLegId: approve.legId,
      rejectLegId: reject.legId,
      requoteLegId: requote.legId,
      requoteQuoteId: requote.quoteId!,
      selLegId: sel.legId,
      distLegId: dist.legId,
      ffId: ffFree.id,
      reissueFfId: send.ffId!,
      cargoId: main.cargoId,
      spareCargoId: spareCargo.cargoId,
      packageId: main.packageIds[0],
      sparePackageId: main.packageIds[1],
      itemId: main.itemIds[0],
      spareItemId: main.itemIds[1],
      pointId: pA.id,
      sparePointId: pSpare.id,
      checklistKey: defs[0].itemKey,
    };
  }

  const callRow = (row: Row, c: Ctx) => {
    const agent = request(app.getHttpServer());
    const url = row.url(c);
    const req =
      row.method === "post"
        ? agent.post(url)
        : row.method === "patch"
          ? agent.patch(url)
          : row.method === "put"
            ? agent.put(url)
            : agent.delete(url);
    req.set("Cookie", cookieFor(row.actorId ?? EXEC_ID, row.role ?? Role.EXECUTIVE));
    if (row.attach) return req.attach(row.attach.field, row.attach.buffer(), row.attach.filename);
    return req.send(row.body ? row.body(c) : {});
  };

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
    await prisma.messageLog.deleteMany({ where: { entityId: { in: [...qIds, ...legIds] } } });
    await prisma.awardDecisionEvent.deleteMany({ where: { legId: { in: legIds } } });
    await prisma.legAwardDecision.deleteMany({ where: { legId: { in: legIds } } });
    await prisma.quote.deleteMany({ where: { queryId: { in: qIds } } });
    await prisma.rfq.deleteMany({ where: { queryId: { in: qIds } } });
    for (const id of qIds) {
      await prisma.query.delete({ where: { id } }); // cascades points/legs/cargo/files/quotations
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
    await seedReferenceData(prisma);
    await cleanup();
    // Every seeded quote is INR — `generate-client-quote` needs a rate on file to price it.
    await prisma.fxRate.create({ data: { currency: "INR", unitsPerUsd: 83.2, note: PREFIX } });

    locked = await seedScenario("locked", true);
    open = await seedScenario("open", false);
    openGen = await seedScenario("gen", true);

    // Drive the real endpoint that freezes the snapshot — this, and nothing else, is what
    // "locked" means.
    await request(app.getHttpServer())
      .post(`/api/queries/${locked.queryId}/generate-client-quote`)
      .set("Cookie", cookieFor(CHECKER_ID, Role.MANAGER))
      .send()
      .expect(200);
    const frozen = await prisma.query.findUnique({
      where: { id: locked.queryId },
      select: { awardSnapshot: true, status: true },
    });
    expect(frozen?.awardSnapshot).not.toBeNull();
    expect(frozen?.status).toBe("QUOTING_CLIENT");
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  // ── 1. every gated write is refused while the query is locked ───────────────────────────
  it.each(LOCKED_WRITES)("$name is refused while the query is locked", async (row) => {
    const res = await callRow(row, locked);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(QUERY_LOCKED_MESSAGE);
  });

  // ── 2. the two exceptions ───────────────────────────────────────────────────────────────
  it("the quotation builder and reopen-comparison still work while the query is locked", async () => {
    const manager = cookieFor(CHECKER_ID, Role.MANAGER);
    const server = app.getHttpServer();

    // The quotation builder is the WHOLE POINT of the locked state: QUOTING_CLIENT is entered by
    // freezing the snapshot, and AWAITING_CLIENT_DECISION is reached BY issuing the letter.
    const draft = await request(server)
      .get(`/api/queries/${locked.queryId}/quotation`)
      .set("Cookie", manager)
      .expect(200);

    const patched = await request(server)
      .patch(`/api/queries/${locked.queryId}/quotation`)
      .set("Cookie", manager)
      .send({ marginPct: 12.5 })
      .expect(200);
    expect(patched.body.marginPct).toBe(12.5);
    expect(draft.body.id).toBe(patched.body.id);

    const issued = await request(server)
      .post(`/api/queries/${locked.queryId}/quotation/issue`)
      .set("Cookie", manager)
      .send({
        recipientEmail: `${PREFIX.toLowerCase()}-client@e2e.test`,
        expectedUpdatedAt: patched.body.updatedAt,
      })
      .expect(200);
    expect(issued.body.status).toBe("ISSUED");
    // Issuing moved the query to AWAITING_CLIENT_DECISION — still locked (snapshot still frozen),
    // which is the second of the two statuses D6 covers.
    const afterIssue = await prisma.query.findUnique({
      where: { id: locked.queryId },
      select: { status: true, awardSnapshot: true },
    });
    expect(afterIssue?.status).toBe("AWAITING_CLIENT_DECISION");
    expect(afterIssue?.awardSnapshot).not.toBeNull();

    await request(server)
      .post(`/api/queries/${locked.queryId}/quotation/revise`)
      .set("Cookie", manager)
      .send()
      .expect(200);

    // And reopen is the door out. It asserts the OPPOSITE condition (409 when NOT locked) and
    // deliberately does not use the guard. S5.9.5 (D6) made it Manager/Admin-only with a required
    // reason, so this call uses the `manager` cookie already in scope above (an EXECUTIVE would
    // now 403).
    await request(server)
      .post(`/api/queries/${locked.queryId}/reopen-comparison`)
      .set("Cookie", manager)
      .send({ reason: "S5.9.5 query-lock e2e — reopen the door out" })
      .expect(200);

    // The refusals above really were the LOCK, not this query: the same PATCH that 409'd in test
    // 1 succeeds on the very same row now that the snapshot is gone.
    await request(server)
      .patch(`/api/queries/${locked.queryId}`)
      .set("Cookie", cookieFor(EXEC_ID, Role.EXECUTIVE))
      .send({ internalNotes: `${PREFIX} after reopen` })
      .expect(200);
  }, 60_000);

  // ── 3. the positive control for the whole table ─────────────────────────────────────────
  // NOT optional: without it, a guard misplaced so that it fires unconditionally would pass
  // test 1 with a full green board.
  it.each(LOCKED_WRITES)(
    "$name succeeds when the query is NOT locked (positive control)",
    async (row) => {
      const ctx = row.openScenario === "openGen" ? openGen : open;
      const res = await callRow(row, ctx);
      // The lock did not fire — the specific thing this control exists to prove.
      expect(res.body?.message).not.toBe(QUERY_LOCKED_MESSAGE);
      // …and the write actually reached its handler and produced that handler's own answer.
      // `toMatchObject` on the whole envelope so a mismatch prints the response body, which is
      // what says WHICH guard answered instead.
      expect({ status: res.status, body: res.body }).toMatchObject({ status: row.openStatus });
    },
    60_000,
  );
});
