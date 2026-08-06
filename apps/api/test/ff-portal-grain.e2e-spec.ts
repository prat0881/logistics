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

// Task 3 (Unit 1, FF Portal v2 ripple): rfq.service's F1 completeness gate and ff-portal.service's
// resolveScope/submit are re-pointed from the dropped flat CargoItem model onto the per-package
// ManifestSnapshot (Task 1/2 already landed). This spec drives the REAL, unmodified HTTP path
// end to end -- ff-selection -> distribute -> GET portal -> PATCH draft -> POST submit -- against
// a real Cargo->Package->Item + LegPackage fixture (mirrors rfq-manifest.e2e-spec.ts's Task-2
// fixture), then asserts the manifest / seededDensity / QuoteCargoLine are all keyed by packageId.
//
// Before Task 3's fix: POST /distribute 500s -- rfq.service.ts:267's F1 gate reads the dropped
// `leg.legCargo` field (undefined once LEG_RFQ_INCLUDE selects `legPackages` instead), throwing
// `TypeError: Cannot read properties of undefined (reading 'length')`. That's the RED this spec
// proves; the F1 one-liner + the ff-portal.service.ts grain re-point are this task's GREEN.
const PFX = "FFGRAIN_";
const CODE = `${PFX}1`;

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
    const qs = await prisma.query.findMany({ where: { queryCode: { startsWith: PFX } }, select: { id: true } });
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
      // order matters: quotes/rfqs reference the FF (Restrict) and the query (Cascade)
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items
    }
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: `FF-${PFX}` } } });
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
    await seedReferenceData(prisma); // freightDensityFactor + chargeLineDefinition feed density/charge seeding
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("serves a package-grain manifest and materializes one QuoteCargoLine per package", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    // --- query → cargo → 2 packages (one carrying a DG-tagged item) ---
    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });

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
    // DG comes from an ITEM tag, not the package's own tags — exercises effectiveTags AND the
    // ff-portal.service.ts submit derivation `isDangerous: c.tags.includes("DG")`.
    await prisma.item.create({
      data: { packageId: pkg2.id, rowIndex: 0, product: "Battery pack", tags: ["DG"] },
    });

    // --- 1 leg, both packages assigned via LegPackage ---
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-FFGRAIN-1",
        mode: "AIR",
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
      data: {
        freightForwarderCode: `FF-${PFX}A`,
        companyName: `FF-${PFX}A Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PFX.toLowerCase()}a@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["AIR"],
        status: "ACTIVE",
        handleDg: true,
        defaultCurrency: "USD",
      },
    });

    await api()
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    // --- distribute: this is the live F1 gate (rfq.service.ts:267) — pre-fix it 500s on
    //     `leg.legCargo.length` (undefined once LEG_RFQ_INCLUDE selects `legPackages`) ---
    const distRes = await api()
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const token = distRes.body.rfqs[0].accessToken as string;
    expect(token).toHaveLength(64);

    // --- GET portal: manifest.cargo is package-grain; seededDensity keyed by packageId ---
    const got = await api().get(`/api/ff/rfq/${token}`).expect(200);
    const body = got.body as FfPortalRfqDto;
    const legDto = body.legs[0];

    expect(legDto.manifest.cargo).toHaveLength(2);
    expect(legDto.manifest.cargo[0]).toHaveProperty("packageId");
    expect(legDto.manifest.cargo.map((c) => c.packageId).sort()).toEqual([pkg1.id, pkg2.id].sort());
    expect(legDto.manifest.cargo.find((c) => c.packageId === pkg2.id)?.tags).toContain("DG");

    expect(legDto.seededDensity).toHaveLength(2);
    expect(legDto.seededDensity[0]).toHaveProperty("cargoItemId"); // field name unchanged this unit
    expect(legDto.seededDensity.map((d) => d.cargoItemId).sort()).toEqual([pkg1.id, pkg2.id].sort());

    // --- price the mandatory lines + transit; DG package present but NO surcharge note yet —
    //     submit must 422/Q5. This proves `isDangerous` is genuinely derived from the DG tag
    //     server-side (a manifest with no isDangerous field read as `undefined` would otherwise
    //     make this pass vacuously, since the client-sent `isDangerous: false` below is ignored). ---
    const baseDraft: QuoteDraft = {
      legId: leg.id,
      mode: "AIR",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      cargo: legDto.seededDensity.map((d) => ({
        cargoItemId: d.cargoItemId,
        grossWtT: 1,
        cbm: 1,
        isDangerous: false, // client value is ignored; server re-derives from the manifest tags
        freightDensity: d.freightDensity,
      })),
      charges: legDto.seededCharges.map((c) => ({
        zone: c.zone,
        definitionKey: c.definitionKey,
        presetKey: c.presetKey,
        label: c.label,
        amount: 10,
      })),
      trucking: [],
      warehouse: [],
      transit: { departureDate: "2026-08-12T00:00:00.000Z", arrivalDate: "2026-08-14T00:00:00.000Z" },
      dgSurchargeNote: null,
      termsConditions: null,
    };

    await api().patch(`/api/ff/rfq/${token}/quotes/${leg.id}`).send(baseDraft).expect(200);
    const noNoteRes = await api().post(`/api/ff/rfq/${token}/quotes/${leg.id}/submit`).expect(422);
    expect(noNoteRes.body.findings.map((f: { rule: string }) => f.rule)).toContain("Q5");

    // --- add the note; submit must now succeed ---
    await api()
      .patch(`/api/ff/rfq/${token}/quotes/${leg.id}`)
      .send({ ...baseDraft, dgSurchargeNote: "Handled per IATA DGR" })
      .expect(200);

    const submitRes = await api().post(`/api/ff/rfq/${token}/quotes/${leg.id}/submit`).expect(201);
    expect(submitRes.body.status).toBe("QUOTED");

    // --- one QuoteCargoLine per package, packageId set ---
    const lines = await prisma.quoteCargoLine.findMany({ where: { quoteId: submitRes.body.quoteId } });
    expect(lines).toHaveLength(legDto.manifest.cargo.length);
    expect(lines.every((l) => !!l.packageId)).toBe(true);
    expect(lines.map((l) => l.packageId).sort()).toEqual([pkg1.id, pkg2.id].sort());
  });
});
