process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE, type FfPortalRfqDto, type QuoteDraft } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { ffFixture } from "./helpers/freight-forwarder";

// Task 9 (Unit 3, FF Portal v2 ripple): ff-portal.service.ts is rewritten off the dropped
// density model onto the v2 grain — FfPortalLegDto no longer seeds `seededDensity`; the FF
// enters Charged Wt (kg) directly per package; submit rebuilds/materializes the v2 QuoteDraft
// (packageId/chargedWeightKg cargo, dual-rate `trucking[]`/`seaRates[]`, calc `charges[]`,
// per-variant totals). This spec drives the REAL, unmodified HTTP path end to end --
// ff-selection -> distribute -> GET portal -> PATCH draft -> POST submit -- against a real
// Cargo->Package->Item + LegPackage fixture (same fixture shape as Task 3's original), then
// asserts the v2 materialize: two TruckingCharge rows with distinct rateVariant, Quote.grandTotal
// = the engine's max variant grand total, and the mandatory-Guaranteed-Transit gate (Q_TRANSIT).
//
// Before Task 9's fix: `apps/api` doesn't even `nest build` -- ff-portal.service.ts still
// writes `QuoteCargoLine.freightDensity`/`chargeableWeightT` (dropped by Unit 2's migration)
// and reads `QuoteDraftCargo.cargoItemId`/`grossWtT` (renamed/dropped by Unit 2's shared engine
// rewrite) -- so this spec cannot even compile against the old service. That's the RED Task 9
// fixes; the v2 rewrite below is the GREEN.
//
// Note on the dropped Q5/DG-note gate: v1's submit-gate required a `dgSurchargeNote` whenever
// any package carried the DG tag (isDangerous). v2's `validateQuote` (design §7, Unit 2) does
// NOT carry that rule forward -- `QuoteDraftCargo` itself dropped `isDangerous` entirely. DG
// surcharging is now driven through the ordinary charge-line catalogue (a TAG_DRIVEN line,
// gated on the package's tags at distribute -- Task 10, not yet wired) and priced via the
// normal Q_PRICED rule, not a bespoke note-mandatory check. This spec keeps a DG-tagged package
// in the fixture (manifest-grain fidelity, mirrors Task 3) but does not assert a DG-specific
// submit gate, since none exists in v2.
//
// Post-review addendum: two crash paths the original 6 v2 rules left open (both force-unwrap
// at materialize, ff-portal.service.ts) are now covered here -- (1) `QuoteCargoLine
// .chargedWeightKg` is a NOT NULL column but nothing gated `chargedWeightKg == null`, so a
// missing weight used to crash past the gate as a generic 400 "Invalid request" (a Prisma
// PrismaClientValidationError caught by PrismaExceptionFilter) instead of a proper, specific 422
// finding (Q_WEIGHT closes this, quote-engine.ts); (2) Q_RATE only requires >=1 of the two
// trucking/seaRate variants filled, so a dual-rate draft can legitimately carry the OTHER
// variant as amount=null -- submit now filters those out before materializing instead of
// force-unwrapping `amount!` on a row that was never priced (same crash class).
//
// Task 9 (FF Portal v3, per-variant quoting) pruning addendum: chargedWeightKg moved OFF
// QuoteCargoLine entirely onto a single leg-level Quote.chargedWeightKg (design §3.1/D2) — every
// draft fixture below was re-pointed accordingly (one leg-level value, not one per package), and
// the QuoteCargoLine.chargedWeightKg / per-package-scoped-Q_WEIGHT assertions the (1) addendum
// above describes were removed where the underlying scenario no longer exists. One whole test
// ("blocks submit with 422 Q_WEIGHT... when a package has no Charged Wt") was DELETED rather than
// rewritten — see the note in its place below — because its premise (one package priced, a
// SIBLING package missing its weight) is no longer constructible under v3's one-leg-level-value
// model, and what remained of its intent is already covered by ff-portal-v3.e2e-spec.ts. Also:
// `guaranteedTransitDays` (one value per leg) became `guaranteedTransitDaysByVariant` (one value
// per PRICED rate-variant column — design §3.1/D3); Quote.draftJson is now PERSISTED after submit
// (design §6 finding #8), not nulled, so the one assertion that checked `draftJson).toBeNull()`
// was inverted, not deleted.
const PFX = "FFGRAIN_";

describe(`${PFX}ff-portal-grain (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role = Role.ADMINISTRATOR) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: "22222222-2222-2222-2222-222222222222", role, tenantId: null })}`;
  const api = () => request(app.getHttpServer());

  // Self-clean comms rows too (ScheduledEvent/MessageLog key off entityId as a plain string, not
  // a Prisma relation, so they don't cascade off a Query/Rfq delete) -- mirrors ff-portal.e2e-spec.ts.
  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: PFX } },
      select: { id: true },
    });
    const queryIds = qs.map((q) => q.id);
    const rfqs = queryIds.length
      ? await prisma.rfq.findMany({ where: { queryId: { in: queryIds } }, select: { id: true } })
      : [];
    const rfqIds = rfqs.map((r) => r.id);
    if (rfqIds.length) {
      await prisma.scheduledEvent.deleteMany({
        where: { entityType: "RFQ", entityId: { in: rfqIds } },
      });
    }
    if (queryIds.length) {
      await prisma.messageLog.deleteMany({
        where: { entityType: "QUERY", entityId: { in: queryIds } },
      });
    }
    for (const q of qs) {
      // order matters: quotes/rfqs reference the FF (Restrict) and the query (Cascade)
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PFX}` } },
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
    await seedReferenceData(prisma); // chargeLineDefinition catalogue feeds seededCharges
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("prices dual-rate Road trucking + Charged Wt per package, and gates submit on a missing Guaranteed Transit", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const CODE = `${PFX}1`;

    // --- query → cargo → 2 packages (one carrying a DG-tagged item) ---
    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });

    const cargo = await prisma.cargo.create({ data: { queryId: query.id, rowIndex: 0 } });
    const pkg1 = await prisma.package.create({
      data: {
        queryId: query.id,
        cargoId: cargo.id,
        rowIndex: 0,
        packageNo: "PK-1",
        packageType: "BOX",
        dimL: 100,
        dimW: 50,
        dimH: 40,
        grossWt: 120,
      },
    });
    const pkg2 = await prisma.package.create({
      data: {
        queryId: query.id,
        cargoId: cargo.id,
        rowIndex: 1,
        packageNo: "PK-2",
        packageType: "DRUM",
        dimL: 60,
        dimW: 60,
        dimH: 60,
        grossWt: 45,
      },
    });
    // DG comes from an ITEM tag, not the package's own tags — exercises effectiveTags
    // (manifest-grain fidelity only; v2 has no DG-driven submit gate — see header comment).
    await prisma.item.create({
      data: { packageId: pkg2.id, rowIndex: 0, product: "Battery pack", tags: ["DG"] },
    });

    // --- 1 Road leg, both packages assigned via LegPackage ---
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-FFGRAIN-1",
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legPackages: { create: [{ packageId: pkg1.id }, { packageId: pkg2.id }] },
      },
    });

    // --- ACTIVE, DG-handling FF (F5 requires every selected FF to handle DG) ---
    const ff = await prisma.freightForwarder.create({
      data: ffFixture({
        freightForwarderCode: `FF-${PFX}A`,
        companyName: `FF-${PFX}A Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PFX.toLowerCase()}a@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        status: "ACTIVE",
        handleDg: true,
        defaultCurrency: "USD",
      }),
    });

    await api()
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    // --- distribute ---
    const distRes = await api()
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const token = distRes.body.rfqs[0].accessToken as string;
    expect(token).toHaveLength(64);

    // --- GET portal: manifest.cargo is package-grain; no more density seed; Road has no CORE
    //     PLAIN/HEAVY_WEIGHT_CALC catalogue lines (only TRUCKING, which seeds via `endpoints`,
    //     not `seededCharges`) ---
    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const body = got.body as FfPortalRfqDto;
    const legDto = body.legs[0];

    expect(legDto.manifest.cargo).toHaveLength(2);
    expect(legDto.manifest.cargo.map((c) => c.packageId).sort()).toEqual([pkg1.id, pkg2.id].sort());
    expect(legDto.manifest.cargo.find((c) => c.packageId === pkg2.id)?.tags).toContain("DG");
    expect(legDto).not.toHaveProperty("seededDensity"); // v2 dropped the density seed entirely
    expect(legDto.seededCharges).toEqual([]); // Road: nothing CORE/PLAIN to seed

    // --- price only the trucking + transit; Guaranteed Transit intentionally left blank —
    //     submit must 422/Q_TRANSIT. Two rate variants at the SAME leg (Dedicated ex-origin,
    //     Groupage ex-destination) so both TruckingCharge rows are genuinely distinct. v3:
    //     chargedWeightKg is one leg-level value (was per-package) — the two-packages fixture is
    //     kept for manifest-grain/DG-tag fidelity (effectiveTags), not per-package weight anymore.
    const draftNoTransit: QuoteDraft = {
      legId: leg.id,
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 173.7, // v3: one leg-level chargeable weight (was 125.5 + 48.2 per package)
      notes: null,
      cargo: legDto.manifest.cargo.map((c) => ({
        packageId: c.packageId,
        grossWtKg: Number(c.grossWt),
        cbm: Number(c.volumeCbm ?? 0),
      })),
      charges: [],
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
        {
          legEndpointPointId: dest.id,
          truckingType: "GROUPAGE",
          basis: "PER_CBM",
          amount: 300,
          remarks: "Groupage to destination",
          rateVariant: "GROUPAGE",
          tonnage: null,
        },
      ],
      seaRates: [],
      warehouse: [],
      transit: {
        // Relative to submit-time "now" — Round 4's Q_PAST_DATE (design D3, quote-engine.ts) is
        // unconditional and uses the real wall clock, so a hardcoded absolute date would
        // eventually fall into the past and turn this test's 201-expecting submit red. Ordering
        // preserved: pickup < departure < arrival.
        plannedPickupDate: new Date(Date.now() + 29 * 86400000).toISOString(),
        departureDate: new Date(Date.now() + 30 * 86400000).toISOString(),
        arrivalDate: new Date(Date.now() + 32 * 86400000).toISOString(),
        guaranteedTransitDaysByVariant: {}, // <-- the gap under test
      },
      dgSurchargeNote: "Handled per IATA/ADR DG regulations",
      termsConditions: null,
    };

    await api().patch(`/api/ff/rfq/${token}/quotes/${leg.id}`).send(draftNoTransit).expect(200);
    const blockedRes = await api().post(`/api/ff/rfq/${token}/quotes/${leg.id}/submit`).expect(422);
    // v3: BOTH Dedicated and Groupage are priced variants (both trucking rows are filled), and
    // validateQuote's Q_TRANSIT loop fires once PER priced variant missing its transit-days — so
    // this is 2 findings, not 1 (was a single leg-wide Q_TRANSIT pre-v3).
    expect(blockedRes.body.findings).toHaveLength(2);
    expect(
      (blockedRes.body.findings as { rule: string }[]).every((f) => f.rule === "Q_TRANSIT"),
    ).toBe(true);

    // --- fill Guaranteed Transit Time for BOTH priced variants; submit must now succeed ---
    const draftReady: QuoteDraft = {
      ...draftNoTransit,
      transit: {
        ...draftNoTransit.transit!,
        guaranteedTransitDaysByVariant: { DEDICATED: 3, GROUPAGE: 3 },
      },
    };
    await api().patch(`/api/ff/rfq/${token}/quotes/${leg.id}`).send(draftReady).expect(200);

    const submitRes = await api().post(`/api/ff/rfq/${token}/quotes/${leg.id}/submit`).expect(201);
    expect(submitRes.body.status).toBe("QUOTED");
    const quoteId = submitRes.body.quoteId as string;

    // --- one QuoteCargoLine per package (v3: no chargedWeightKg column on it any more — see the
    //     Quote-level assertion below) ---
    const lines = await prisma.quoteCargoLine.findMany({ where: { quoteId } });
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.packageId).sort()).toEqual([pkg1.id, pkg2.id].sort());
    expect(lines[0]).not.toHaveProperty("chargedWeightKg");

    // --- two TruckingCharge rows, distinct rateVariant, dual-rate fields carried through ---
    const trucking = await prisma.truckingCharge.findMany({
      where: { quoteId },
      orderBy: { amount: "desc" },
    });
    expect(trucking).toHaveLength(2);
    expect(trucking.map((t) => t.rateVariant).sort()).toEqual(["DEDICATED", "GROUPAGE"]);
    const dedicated = trucking.find((t) => t.rateVariant === "DEDICATED")!;
    const groupage = trucking.find((t) => t.rateVariant === "GROUPAGE")!;
    expect(Number(dedicated.amount)).toBe(500);
    expect(dedicated.tonnage).toBe("T_5");
    expect(dedicated.legEndpointPointId).toBe(origin.id);
    expect(Number(groupage.amount)).toBe(300);
    expect(groupage.tonnage).toBeNull();
    expect(groupage.legEndpointPointId).toBe(dest.id);

    // --- two TransitPlan rows (one per priced variant), each carrying its own rateVariant (v3) ---
    const transitPlans = await prisma.transitPlan.findMany({ where: { quoteId } });
    expect(transitPlans).toHaveLength(2);
    expect(transitPlans.map((t) => t.rateVariant).sort()).toEqual(["DEDICATED", "GROUPAGE"]);

    // --- Quote.grandTotal = the engine's MAX variant grand total (no charges/warehouse here,
    //     so each variant's grand total is just its own trucking amount: max(500, 300) = 500) ---
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
    expect(Number(quote.grandTotal)).toBe(500);
    expect(quote.totalChargeableWeightT).toBeNull(); // column kept but unused — kg lives on Quote.chargedWeightKg
    expect(Number(quote.chargedWeightKg)).toBe(173.7); // v3: the one leg-level value, on Quote itself
    expect(quote.dgSurchargeNote).toBe("Handled per IATA/ADR DG regulations");
    // v3 (design §6 finding #8): submit PERSISTS the submitted draft (was Prisma.DbNull
    // pre-fix) — the FF portal preview/print reads it back post-submission.
    expect(quote.draftJson).not.toBeNull();
  });

  it("materializes a HEAVY_WEIGHT_CALC charge line via computeHeavyWeightAmount", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const CODE = `${PFX}2`;

    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });

    const cargo = await prisma.cargo.create({ data: { queryId: query.id, rowIndex: 0 } });
    const pkg = await prisma.package.create({
      data: {
        queryId: query.id,
        cargoId: cargo.id,
        rowIndex: 0,
        packageNo: "PK-1",
        packageType: "CRATE",
        dimL: 120,
        dimW: 80,
        dimH: 100,
        grossWt: 500,
      },
    });

    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-FFGRAIN-2",
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legPackages: { create: [{ packageId: pkg.id }] },
      },
    });

    const ff = await prisma.freightForwarder.create({
      data: ffFixture({
        freightForwarderCode: `FF-${PFX}B`,
        companyName: `FF-${PFX}B Co`,
        pic: "P",
        contactNumber: "+1000000001",
        email: `ff-${PFX.toLowerCase()}b@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["AIR"],
        status: "ACTIVE",
        handleDg: false,
        defaultCurrency: "USD",
      }),
    });

    await api()
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    const distRes = await api()
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const token = distRes.body.rfqs[0].accessToken as string;

    // --- GET portal: Air CORE lines (10 PLAIN + AIR_MAIN_HEAVY_WEIGHT calc) seed unfiltered,
    //     no LegChargeLineSelection needed since CORE lines are always included ---
    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const legDto = (got.body as FfPortalRfqDto).legs[0];
    const calcLine = legDto.seededCharges.find((c) => c.inputType === "HEAVY_WEIGHT_CALC");
    expect(calcLine?.definitionKey).toBe("AIR_MAIN_HEAVY_WEIGHT");
    const plainLines = legDto.seededCharges.filter((c) => c.inputType === "PLAIN");
    expect(plainLines.length).toBeGreaterThan(0);

    // --- price every PLAIN line flat; price the calc line via piece/limit/rate inputs instead
    //     of a flat amount — computeHeavyWeightAmount(180, 100, 2.5) = (180-100)*2.5 = 200 ---
    const draft: QuoteDraft = {
      legId: leg.id,
      mode: "AIR",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 550, // v3: one leg-level chargeable weight (was per-package)
      notes: null,
      cargo: [{ packageId: pkg.id, grossWtKg: 500, cbm: 0.96 }],
      // rateVariant: null on every cell — Air's single implicit column (v3).
      charges: legDto.seededCharges.map((c) =>
        c.inputType === "HEAVY_WEIGHT_CALC"
          ? {
              zone: c.zone,
              definitionKey: c.definitionKey,
              presetKey: c.presetKey,
              label: c.label,
              amount: null,
              rateVariant: null,
              pieceWeightKg: 180,
              airlineLimitKg: 100,
              ratePerExcessKg: 2.5,
            }
          : {
              zone: c.zone,
              definitionKey: c.definitionKey,
              presetKey: c.presetKey,
              label: c.label,
              amount: 50,
              rateVariant: null,
            },
      ),
      trucking: [],
      seaRates: [],
      warehouse: [],
      transit: {
        // Relative to submit-time "now" (unconditional Q_PAST_DATE, design D3) — see the
        // pickup-date fixture above for why. Same day/hour spacing as before: departure day at
        // 00:00, plannedDeparture +10h, plannedArrival +18h, arrival day two days later.
        departureDate: new Date(Date.now() + 30 * 86400000).toISOString(),
        arrivalDate: new Date(Date.now() + 32 * 86400000).toISOString(),
        airline: "Emirates SkyCargo",
        flightNumber: "EK9821",
        plannedDeparture: new Date(Date.now() + 30 * 86400000 + 10 * 3600000).toISOString(),
        plannedArrival: new Date(Date.now() + 30 * 86400000 + 18 * 3600000).toISOString(),
        guaranteedTransitDaysByVariant: { AIR: 2 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };

    await api().patch(`/api/ff/rfq/${token}/quotes/${leg.id}`).send(draft).expect(200);
    const submitRes = await api().post(`/api/ff/rfq/${token}/quotes/${leg.id}/submit`).expect(201);
    expect(submitRes.body.status).toBe("QUOTED");
    const quoteId = submitRes.body.quoteId as string;

    const heavyLine = await prisma.chargeLine.findFirstOrThrow({
      where: { quoteId, definitionKey: "AIR_MAIN_HEAVY_WEIGHT" },
    });
    expect(Number(heavyLine.amount)).toBe(200); // computed, NOT the null `amount` sent in the draft
    expect(Number(heavyLine.pieceWeightKg)).toBe(180);
    expect(Number(heavyLine.airlineLimitKg)).toBe(100);
    expect(Number(heavyLine.ratePerExcessKg)).toBe(2.5);

    const plainCount = plainLines.length;
    const plainTotal = await prisma.chargeLine.count({
      where: { quoteId, definitionKey: { not: "AIR_MAIN_HEAVY_WEIGHT" } },
    });
    expect(plainTotal).toBe(plainCount);

    // Quote.grandTotal (design §7, computeQuoteTotals — now folds HEAVY_WEIGHT_CALC lines via
    // effectiveChargeAmount, quote-engine.ts): the persisted grandTotal must equal the sum of
    // what actually landed on the ChargeLine rows — plainCount flat lines at $50 each, PLUS the
    // computed 200 Heavy-Weight excess — proving the persisted grandTotal agrees with
    // ChargeLine reality end to end, not just the individual line.
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
    expect(Number(quote.grandTotal)).toBe(plainCount * 50 + 200);
  });

  // DELETED (Task 9, v3): "blocks submit with 422 Q_WEIGHT (not a 500) when a package has no
  // Charged Wt" no longer applies — its entire premise was PER-PACKAGE chargedWeightKg (pkg1
  // priced, pkg2 left blank, scope: {type:"cargo", id: pkg2.id}), which v3 structurally removed
  // (chargedWeightKg is now one leg-level QuoteDraft field, not per-QuoteCargoLine — there is no
  // longer a "package missing its own weight while another has one" scenario to construct). What
  // remained of its intent — Q_WEIGHT surfaces as a proper, specifically-scoped 422 finding
  // rather than crashing past the gate on a force-unwrapped null — is now fully and exactly
  // covered by ff-portal-v3.e2e-spec.ts's "submit: missing the leg-level chargedWeightKg -> 422
  // Q_WEIGHT (field-scoped, not per-cargo), Quote stays RFQ_SENT", which asserts the v3 scope
  // shape `{type:"field", id:"chargedWeightKg"}` directly.

  it("materializes only the priced trucking variant when the other dual-rate row is left blank", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const CODE = `${PFX}4`;

    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });

    const cargo = await prisma.cargo.create({ data: { queryId: query.id, rowIndex: 0 } });
    const pkg = await prisma.package.create({
      data: {
        queryId: query.id,
        cargoId: cargo.id,
        rowIndex: 0,
        packageNo: "PK-1",
        packageType: "BOX",
        dimL: 100,
        dimW: 50,
        dimH: 40,
        grossWt: 120,
      },
    });

    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-FFGRAIN-4",
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legPackages: { create: [{ packageId: pkg.id }] },
      },
    });

    const ff = await prisma.freightForwarder.create({
      data: ffFixture({
        freightForwarderCode: `FF-${PFX}D`,
        companyName: `FF-${PFX}D Co`,
        pic: "P",
        contactNumber: "+1000000003",
        email: `ff-${PFX.toLowerCase()}d@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        status: "ACTIVE",
        handleDg: false,
        defaultCurrency: "USD",
      }),
    });

    await api()
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    const distRes = await api()
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const token = distRes.body.rfqs[0].accessToken as string;

    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const legDto = (got.body as FfPortalRfqDto).legs[0];

    // Dedicated priced; Groupage row present but amount left blank — Q_RATE only requires ONE
    // of the two variants filled, so this is a legitimate, submittable draft. Groupage has no
    // charges either, so it stays entirely untouched (v3: only Dedicated needs transit-days).
    const draft: QuoteDraft = {
      legId: leg.id,
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 130, // v3: one leg-level chargeable weight (was per-package)
      notes: null,
      cargo: legDto.manifest.cargo.map((c) => ({
        packageId: c.packageId,
        grossWtKg: Number(c.grossWt),
        cbm: Number(c.volumeCbm ?? 0),
      })),
      charges: [],
      trucking: [
        {
          legEndpointPointId: origin.id,
          truckingType: "DEDICATED",
          basis: "PER_TRUCK",
          amount: 500,
          remarks: "Dedicated priced",
          rateVariant: "DEDICATED",
          tonnage: "T_5",
        },
        {
          legEndpointPointId: dest.id,
          truckingType: "GROUPAGE",
          basis: "PER_CBM",
          amount: null,
          rateVariant: "GROUPAGE",
          tonnage: null,
        },
      ],
      seaRates: [],
      warehouse: [],
      transit: {
        // Relative to submit-time "now" (unconditional Q_PAST_DATE, design D3) — see the
        // pickup-date fixture earlier in this file for why.
        departureDate: new Date(Date.now() + 30 * 86400000).toISOString(),
        arrivalDate: new Date(Date.now() + 32 * 86400000).toISOString(),
        guaranteedTransitDaysByVariant: { DEDICATED: 4 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };

    await api().patch(`/api/ff/rfq/${token}/quotes/${leg.id}`).send(draft).expect(200);
    // Before the fix: `truckingCharge.create`'s `amount: t.amount!` force-unwraps null onto a
    // NOT NULL column for the (legitimately blank) Groupage row — Prisma rejects it with a
    // PrismaClientValidationError, which PrismaExceptionFilter maps to a generic 400 "Invalid
    // request" instead of this succeeding, even though the draft is fully valid per Q_RATE
    // (>=1 of the two variants filled is enough to submit).
    const submitRes = await api().post(`/api/ff/rfq/${token}/quotes/${leg.id}/submit`).expect(201);
    expect(submitRes.body.status).toBe("QUOTED");

    // Exactly ONE TruckingCharge persisted — the unpriced Groupage row is dropped entirely
    // rather than written with a null (or 0-substituted) amount.
    const trucking = await prisma.truckingCharge.findMany({
      where: { quoteId: submitRes.body.quoteId },
    });
    expect(trucking).toHaveLength(1);
    expect(trucking[0]!.rateVariant).toBe("DEDICATED");
    expect(Number(trucking[0]!.amount)).toBe(500);
  });

  it("persists a null TransitPlan.departureDate/arrivalDate (not the 1970 epoch) when only the mode-specific transit fields are set", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const CODE = `${PFX}5`;

    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });

    const cargo = await prisma.cargo.create({ data: { queryId: query.id, rowIndex: 0 } });
    const pkg = await prisma.package.create({
      data: {
        queryId: query.id,
        cargoId: cargo.id,
        rowIndex: 0,
        packageNo: "PK-1",
        packageType: "BOX",
        dimL: 100,
        dimW: 50,
        dimH: 40,
        grossWt: 120,
      },
    });

    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-FFGRAIN-5",
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legPackages: { create: [{ packageId: pkg.id }] },
      },
    });

    const ff = await prisma.freightForwarder.create({
      data: ffFixture({
        freightForwarderCode: `FF-${PFX}E`,
        companyName: `FF-${PFX}E Co`,
        pic: "P",
        contactNumber: "+1000000004",
        email: `ff-${PFX.toLowerCase()}e@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        status: "ACTIVE",
        handleDg: false,
        defaultCurrency: "USD",
      }),
    });

    await api()
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    const distRes = await api()
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const token = distRes.body.rfqs[0].accessToken as string;

    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const legDto = (got.body as FfPortalRfqDto).legs[0];

    // Guaranteed Transit Time set (mandatory, Q_TRANSIT) but NO generic departureDate/
    // arrivalDate — only the Road-specific plannedPickupDate. This is a fully valid draft:
    // guaranteedTransitDaysByVariant is mandatory (per priced variant) and every mode-specific
    // date field is optional.
    // Relative to submit-time "now" (unconditional Q_PAST_DATE, design D3, quote-engine.ts) —
    // captured once so the draft below and the persisted-value assertion after submit stay in
    // sync, instead of two independent hardcoded literals that could drift.
    const plannedPickupIso = new Date(Date.now() + 29 * 86400000).toISOString();
    const draft: QuoteDraft = {
      legId: leg.id,
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 130, // v3: one leg-level chargeable weight (was per-package)
      notes: null,
      cargo: legDto.manifest.cargo.map((c) => ({
        packageId: c.packageId,
        grossWtKg: Number(c.grossWt),
        cbm: Number(c.volumeCbm ?? 0),
      })),
      charges: [],
      trucking: [
        {
          legEndpointPointId: origin.id,
          truckingType: "DEDICATED",
          basis: "PER_TRUCK",
          amount: 500,
          remarks: "Dedicated",
          rateVariant: "DEDICATED",
          tonnage: "T_5",
        },
      ],
      seaRates: [],
      warehouse: [],
      transit: {
        departureDate: null,
        arrivalDate: null,
        plannedPickupDate: plannedPickupIso,
        guaranteedTransitDaysByVariant: { DEDICATED: 5 }, // only Dedicated is priced
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };

    await api().patch(`/api/ff/rfq/${token}/quotes/${leg.id}`).send(draft).expect(200);
    // Before the fix: `transitPlan.create`'s `new Date(draft.transit.departureDate!)` doesn't
    // throw on null — it silently evaluates to 1970-01-01T00:00:00.000Z and Prisma writes that
    // to the (then) NOT NULL column instead of erroring. `.expect(201)` alone wouldn't have
    // caught that (it "succeeds" either way) — the assertions below are what actually pin it.
    const submitRes = await api().post(`/api/ff/rfq/${token}/quotes/${leg.id}/submit`).expect(201);
    expect(submitRes.body.status).toBe("QUOTED");

    const transitPlan = await prisma.transitPlan.findFirstOrThrow({
      where: { quoteId: submitRes.body.quoteId },
    });
    expect(transitPlan.rateVariant).toBe("DEDICATED"); // v3: the one priced variant's column
    expect(transitPlan.departureDate).toBeNull(); // NOT 1970-01-01T00:00:00.000Z
    expect(transitPlan.arrivalDate).toBeNull();
    expect(transitPlan.guaranteedTransitDays).toBe(5);
    expect(transitPlan.plannedPickupDate?.toISOString()).toBe(plannedPickupIso);
  });
});
