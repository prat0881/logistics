process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

// Task 11 (Charge Configuration & Warehouse Attribution), Phase E: per-leg charge selection
// (`chargeLineDefinitionIds`) and the warehouse toggle (`warehouseHandlingIncluded`) are
// edited through the EXISTING mediated `legs.update()` path and classified RfqDefining
// (leg.impact.ts) — free while the leg has no downstream work, routed to the SB6
// change-order cascade (409 needsChangeOrder) once a quote has gone live (RFQ_SENT/QUOTED).
// See apps/api/src/modules/legs/legs.service.ts `update()` + `assertWarehouseExclusivity`,
// and apps/api/src/modules/queries/queries.service.ts `shapeQuery` (QueryLegDto shaping).
const PREFIX = "CHG-CFG-LOCK";
const CODE = `YAL00-${PREFIX}`;

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    for (const q of qs) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items/chargeSelections
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } },
    });
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
    // create-only upserts: guarantees the charge-line catalogue (+ other reference rows)
    // exists regardless of test order/DB state (CI has no seed step).
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("charge selection: free pre-distribute (200, reflected in GET), locked post-distribute (409 needsChangeOrder)", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const server = app.getHttpServer();

    // --- a non-warehouse ROAD leg (PICKUP → DELIVERY) so F7/F8 never engage; ROAD is used
    //     (not AIR) because checkModeEndpoints requires AIRPORT/AIRPORT for AIR — ROAD has no
    //     endpoint-type constraint, so PICKUP/DELIVERY doesn't trip the V-M1 guard in
    //     legs.service.ts `update()` (assertModeEndpoints), which is unrelated to Task 11 ---
    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-CHG-LOCK-1",
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    // F1 (leg completeness) now gates on >=1 assigned package via LegPackage, not the dropped
    // flat CargoItem/LegCargo model — see helpers/cargo.ts.
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: "PO-CHG-LOCK-1", dimL: 10, dimW: 10, dimH: 10, grossWt: 5 }],
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);
    const roadInsurance = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "ROAD_STD_INSURANCE" },
    });

    // --- pre-distribute: PATCH selection applies freely (200) ---
    await request(server)
      .patch(`/api/queries/${query.id}/legs/${leg.id}`)
      .set("Cookie", admin)
      .send({ chargeLineDefinitionIds: [roadInsurance.id] })
      .expect(200);

    // --- reflected in GET /api/queries/:id's leg DTO ---
    const afterPatch = await request(server)
      .get(`/api/queries/${query.id}`)
      .set("Cookie", admin)
      .expect(200);
    const legDtoBefore = afterPatch.body.legs.find((l: { id: string }) => l.id === leg.id);
    expect(legDtoBefore.chargeLineDefinitionIds).toEqual([roadInsurance.id]);
    expect(legDtoBefore.warehouseHandlingIncluded).toBeNull(); // untouched, non-warehouse leg

    // --- distribute the leg (1 FF) ---
    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-A`,
        companyName: `FF-${PREFIX}-A Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `FF-${PREFIX}-A@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        status: "ACTIVE",
      },
    });
    await request(server)
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    await request(server)
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    // --- post-distribute: same PATCH now routes to the change-order cascade (409), no reason given ---
    const res = await request(server)
      .patch(`/api/queries/${query.id}/legs/${leg.id}`)
      .set("Cookie", admin)
      .send({ chargeLineDefinitionIds: [] })
      .expect(409);
    expect(res.body.needsChangeOrder).toBe(true);

    // --- the selection is untouched by the rejected change (still the pre-distribute value) ---
    const afterReject = await request(server)
      .get(`/api/queries/${query.id}`)
      .set("Cookie", admin)
      .expect(200);
    const legDtoAfter = afterReject.body.legs.find((l: { id: string }) => l.id === leg.id);
    expect(legDtoAfter.chargeLineDefinitionIds).toEqual([roadInsurance.id]);
  });

  // SB6 change-order RE-FREEZE (design §5.5): editing chargeLineDefinitionIds on a DISTRIBUTED
  // leg routes through ChangeOrderStrategy.apply. Its tx1 loop must rewrite chargeConfigSnapshot
  // (not only manifestSnapshot) on the still-pending RFQ_SENT quotes — otherwise a refreshed FF
  // keeps a STALE charge set and the portal (seeding + Q1) mis-prices. This exercises the exact
  // HTTP path (PATCH + reason → APPLY) that carries the fix.
  //
  // Mutation guard: without the chargeConfigSnapshot re-freeze in the tx1 updateMany, `keysAfter`
  // would still be the pre-edit set ([...TAIL_LIFT]) and BOTH post-edit assertions fail.
  it("charge re-selection on a distributed leg (with reason) APPLIES the change-order and RE-FREEZES chargeConfigSnapshot on the pending RFQ_SENT quote", async () => {
    // A UUID `sub`: the applied change-order writes the actor onto ChangeLog.actorId
    // (String? @db.Uuid), so the shared cookie()'s "u-ADMINISTRATOR" sub would fail P2023. (The
    // preview-only lock test above never reaches the apply/ChangeLog write, so it uses the helper.)
    const admin = `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: randomUUID(), role: Role.ADMINISTRATOR, tenantId: null })}`;
    const server = app.getHttpServer();

    // --- a non-warehouse ROAD leg so F7/F8 never engage (same rationale as the lock test) ---
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-REFREEZE`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-CHG-RF-1",
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    // F1 (leg completeness) now gates on >=1 assigned package via LegPackage, not the dropped
    // flat CargoItem/LegCargo model — see helpers/cargo.ts.
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: "PO-CHG-RF-1", dimL: 10, dimW: 10, dimH: 10, grossWt: 5 }],
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);
    // Two ROAD STANDARD (PLAIN) lines to swap between; ROAD_CORE_TRUCKING is always a core.
    const tailLift = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "ROAD_STD_TAIL_LIFT" },
    });
    const insurance = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "ROAD_STD_INSURANCE" },
    });

    // --- initial selection (pre-distribute, free): TAIL_LIFT ---
    await request(server)
      .patch(`/api/queries/${query.id}/legs/${leg.id}`)
      .set("Cookie", admin)
      .send({ chargeLineDefinitionIds: [tailLift.id] })
      .expect(200);

    // --- distribute to 1 FF → the single quote goes RFQ_SENT with a frozen chargeConfigSnapshot ---
    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-RF`,
        companyName: `FF-${PREFIX}-RF Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `FF-${PREFIX}-RF@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        status: "ACTIVE",
      },
    });
    await request(server)
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    await request(server)
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    type Snap = { lines: { definitionKey: string }[]; warehouseIncluded: boolean };
    const quoteBefore = await prisma.quote.findFirstOrThrow({ where: { legId: leg.id } });
    expect(quoteBefore.status).toBe("RFQ_SENT");
    const keysBefore = (quoteBefore.chargeConfigSnapshot as Snap).lines.map((l) => l.definitionKey);
    expect(keysBefore).toContain("ROAD_STD_TAIL_LIFT"); // the initial selection was frozen at distribute
    expect(keysBefore).not.toContain("ROAD_STD_INSURANCE");

    // --- re-select on the DISTRIBUTED leg WITH a reason → the SB6 change-order APPLIES (200,
    //     returns the updated leg); it is NOT the 409 preview (that needs no reason). ---
    await request(server)
      .patch(`/api/queries/${query.id}/legs/${leg.id}`)
      .set("Cookie", admin)
      .send({ chargeLineDefinitionIds: [insurance.id], reason: "client re-scoped the charges" })
      .expect(200);

    // --- THE RE-FREEZE: the still-pending quote's chargeConfigSnapshot now reflects the NEW
    //     selection (INSURANCE in, TAIL_LIFT out) — the exact stale-snapshot defect this fix closes. ---
    const quoteAfter = await prisma.quote.findFirstOrThrow({ where: { legId: leg.id } });
    expect(quoteAfter.status).toBe("RFQ_SENT"); // refreshed in place, not invalidated
    const keysAfter = (quoteAfter.chargeConfigSnapshot as Snap).lines.map((l) => l.definitionKey);
    expect(keysAfter).toContain("ROAD_STD_INSURANCE"); // the NEW selection is now frozen
    expect(keysAfter).not.toContain("ROAD_STD_TAIL_LIFT"); // the OLD selection is gone
  });

  // CRITICAL fix (whole-branch review): the re-freeze proven above rewrites manifestSnapshot +
  // chargeConfigSnapshot on the pending RFQ_SENT quote, but pre-fix left the FF's already-SAVED
  // draftJson untouched. If the FF had priced a line the change-order just removed from the
  // config, that stale-priced line would (a) ride verbatim through ff-portal.service.ts submit()'s
  // stored-draft copy, (b) get summed into grandTotal even though the Executive removed it, or (c)
  // crash with a NOT NULL violation if it had never been priced (chargeAmount(c)'s `c.amount!`
  // force-unwrap) — and a newly-ADDED line could never be priced at all (the client never shows
  // it), so validateQuote's Q_PRICED would permanently block submission. This exercises the fix:
  // change-order.strategy.ts's re-freeze now also resets draftJson to SQL NULL, and
  // ff-portal.service.ts's submit() additionally filters any stale charge out of a stored draft as
  // defense-in-depth.
  it("charge re-selection on a distributed leg clears the FF's stale draftJson on re-freeze; re-seeded submit excludes the removed line and prices the added one", async () => {
    const admin = `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: randomUUID(), role: Role.ADMINISTRATOR, tenantId: null })}`;
    const server = app.getHttpServer();

    // --- a non-warehouse ROAD leg so F7/F8 never engage (same rationale as the tests above) ---
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-STALEDRAFT`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-CHG-SD-1",
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: "PO-CHG-SD-1", dimL: 10, dimW: 10, dimH: 10, grossWt: 5 }],
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);
    const tailLift = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "ROAD_STD_TAIL_LIFT" },
    });
    const insurance = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "ROAD_STD_INSURANCE" },
    });

    // --- initial selection (pre-distribute, free): TAIL_LIFT ---
    await request(server)
      .patch(`/api/queries/${query.id}/legs/${leg.id}`)
      .set("Cookie", admin)
      .send({ chargeLineDefinitionIds: [tailLift.id] })
      .expect(200);

    // --- distribute to 1 FF → the single quote goes RFQ_SENT, chargeConfigSnapshot = [TAIL_LIFT] ---
    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-SD`,
        companyName: `FF-${PREFIX}-SD Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `FF-${PREFIX}-SD@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        status: "ACTIVE",
      },
    });
    await request(server)
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    const distRes = await request(server)
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const token = distRes.body.rfqs[0].accessToken as string;

    // --- the FF opens the portal and SAVES a draft pricing the TAIL_LIFT line (soon to be
    //     removed by the Executive's change-order below) ---
    const got1 = await request(server).get(`/api/ff/rfq/${token}`).expect(200);
    const legDto1 = got1.body.legs[0];
    expect(legDto1.seededCharges.map((c: { definitionKey: string }) => c.definitionKey)).toEqual([
      "ROAD_STD_TAIL_LIFT",
    ]);

    const draftBefore = {
      legId: leg.id,
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 5, // v3: one leg-level chargeable weight (was per-package)
      notes: null,
      cargo: legDto1.manifest.cargo.map(
        (c: { packageId: string; grossWt: string; volumeCbm: string | null }) => ({
          packageId: c.packageId,
          grossWtKg: Number(c.grossWt),
          cbm: Number(c.volumeCbm ?? 0),
        }),
      ),
      // v3: charges carry a rateVariant (the matrix column); this test isn't exercising
      // per-variant behavior, so every line prices under DEDICATED only.
      charges: legDto1.seededCharges.map(
        (c: { zone: string | null; definitionKey: string; label: string }) => ({
          zone: c.zone,
          definitionKey: c.definitionKey,
          presetKey: null,
          label: c.label,
          amount: 77,
          rateVariant: "DEDICATED",
        }),
      ),
      trucking: [],
      seaRates: [],
      warehouse: [],
      transit: null,
      dgSurchargeNote: null,
      termsConditions: null,
    };
    await request(server)
      .patch(`/api/ff/rfq/${token}/quotes/${leg.id}`)
      .send(draftBefore)
      .expect(200);

    // sanity: draftJson is now populated and prices the soon-to-be-removed TAIL_LIFT line —
    // otherwise the assertions below (draftJson cleared / stale charge dropped) would be vacuous
    const quoteWithDraft = await prisma.quote.findFirstOrThrow({ where: { legId: leg.id } });
    expect(quoteWithDraft.draftJson).not.toBeNull();
    const storedCharges = (
      quoteWithDraft.draftJson as { charges: { definitionKey: string; amount: number }[] }
    ).charges;
    expect(storedCharges).toHaveLength(1);
    expect(storedCharges[0]!.definitionKey).toBe("ROAD_STD_TAIL_LIFT");
    expect(storedCharges[0]!.amount).toBe(77);

    // --- the Executive change-orders the charge config on the DISTRIBUTED leg: TAIL_LIFT out,
    //     INSURANCE in (with a reason → APPLY, not the 409 preview) ---
    await request(server)
      .patch(`/api/queries/${query.id}/legs/${leg.id}`)
      .set("Cookie", admin)
      .send({ chargeLineDefinitionIds: [insurance.id], reason: "client re-scoped the charges" })
      .expect(200);

    // --- (a) THE FIX: the still-pending RFQ_SENT quote's draftJson is now cleared (SQL NULL) —
    //     pre-fix this stayed populated with the stale TAIL_LIFT-priced draft ---
    const quoteAfterChangeOrder = await prisma.quote.findFirstOrThrow({ where: { legId: leg.id } });
    expect(quoteAfterChangeOrder.status).toBe("RFQ_SENT"); // refreshed in place, not invalidated
    expect(quoteAfterChangeOrder.draftJson).toBeNull();

    // --- the FF re-opens the portal: no stale draft, fresh config (INSURANCE only) ---
    // v3: resolveScope seeds a starter QuoteDraft (the per-variant matrix) rather than `null`
    // whenever the leg has >=1 active charge-config line (design §5) — a cleared draftJson no
    // longer shows up as `draft: null`. "No stale draft" now means the FRESH seed reflects the
    // re-frozen config (INSURANCE only, every cell unpriced) and carries NONE of the stale
    // TAIL_LIFT pricing (77) the FF had entered before the change-order.
    const got2 = await request(server).get(`/api/ff/rfq/${token}`).expect(200);
    const legDto2 = got2.body.legs[0];
    expect(legDto2.draft).not.toBeNull();
    const seededDraftKeys = (legDto2.draft.charges as { definitionKey: string }[]).map(
      (c) => c.definitionKey,
    );
    expect(seededDraftKeys.length).toBeGreaterThan(0);
    expect(seededDraftKeys.every((k) => k === "ROAD_STD_INSURANCE")).toBe(true); // no TAIL_LIFT
    expect(
      (legDto2.draft.charges as { amount: number | null }[]).every((c) => c.amount === null),
    ).toBe(true); // nothing pre-priced — not the stale 77
    const keys2 = legDto2.seededCharges.map((c: { definitionKey: string }) => c.definitionKey);
    expect(keys2).toEqual(["ROAD_STD_INSURANCE"]);

    // --- the FF re-seeds and prices against the NEW config (INSURANCE + a trucking rate to
    //     clear ROAD's Q_RATE gate) and submits ---
    const draftAfter = {
      legId: leg.id,
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 5, // v3: one leg-level chargeable weight (was per-package)
      notes: null,
      cargo: legDto2.manifest.cargo.map(
        (c: { packageId: string; grossWt: string; volumeCbm: string | null }) => ({
          packageId: c.packageId,
          grossWtKg: Number(c.grossWt),
          cbm: Number(c.volumeCbm ?? 0),
        }),
      ),
      // DEDICATED only (matches the trucking rate below) — GROUPAGE stays untouched, so only
      // DEDICATED needs to clear Q_PRICED/Q_TRANSIT; grandTotal = trucking 500 + INSURANCE 55 = 555.
      charges: legDto2.seededCharges.map(
        (c: { zone: string | null; definitionKey: string; label: string }) => ({
          zone: c.zone,
          definitionKey: c.definitionKey,
          presetKey: null,
          label: c.label,
          amount: 55,
          rateVariant: "DEDICATED",
        }),
      ),
      trucking: [
        {
          legEndpointPointId: origin.id,
          truckingType: "DEDICATED",
          basis: "PER_TRUCK",
          amount: 500,
          remarks: "Dedicated ex-origin",
          rateVariant: "DEDICATED",
          tonnage: "T_5",
        },
      ],
      seaRates: [],
      warehouse: [],
      transit: {
        departureDate: "2026-08-12T00:00:00.000Z",
        arrivalDate: "2026-08-14T00:00:00.000Z",
        guaranteedTransitDaysByVariant: { DEDICATED: 3 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };
    await request(server)
      .patch(`/api/ff/rfq/${token}/quotes/${leg.id}`)
      .send(draftAfter)
      .expect(200);

    // --- (b) submit against the NEW config succeeds — NO 500, and the materialized ChargeLine
    //     set is EXACTLY the new config's lines (the removed TAIL_LIFT line is absent) ---
    const submitRes = await request(server)
      .post(`/api/ff/rfq/${token}/quotes/${leg.id}/submit`)
      .expect(201);
    expect(submitRes.body.status).toBe("QUOTED");

    const chargeLines = await prisma.chargeLine.findMany({
      where: { quoteId: submitRes.body.quoteId },
    });
    const chargeKeys = chargeLines.map((c) => c.definitionKey);
    expect(chargeKeys).toEqual(["ROAD_STD_INSURANCE"]); // exactly the new config's lines
    expect(chargeKeys).not.toContain("ROAD_STD_TAIL_LIFT"); // the removed line is truly gone

    // --- (c) the persisted grandTotal matches the NEW config only: trucking 500 + INSURANCE 55 =
    //     555 — NOT 500 + 55 + 77, which is what it would be if the stale TAIL_LIFT charge had
    //     leaked through and been summed in ---
    const quoteFinal = await prisma.quote.findUniqueOrThrow({
      where: { id: submitRes.body.quoteId },
    });
    expect(Number(quoteFinal.grandTotal)).toBe(555);
  });
});
