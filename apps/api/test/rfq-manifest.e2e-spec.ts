process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE, type ManifestSnapshot } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { loadLegForRfq } from "../src/modules/rfq/leg-context";
import { buildManifestSnapshot } from "../src/modules/rfq/manifest";

// Task 2 (Unit 1, FF Portal v2 ripple): the RFQ manifest freeze is re-pointed from the old
// flat CargoItem/LegCargo model onto Cargo→Package→Item + LegPackage. This spec builds a REAL
// fixture (query → cargo → 2 packages, one carrying a DG-tagged item → 1 leg → assign both
// packages via LegPackage → select an ACTIVE, DG-handling FF) against the real Postgres DB, then
// exercises the freeze itself by chaining the two REAL, unmodified functions this task owns —
// `loadLegForRfq` + `buildManifestSnapshot` — exactly as `RfqService.performDistribution` chains
// them. No stubbing of leg-context.ts/manifest.ts and no hand-built ManifestSnapshot.
//
// NOT routed through the live `POST /distribute` HTTP endpoint: `RfqService
// .validateLegForDistribution`'s F1 gate (rfq.service.ts:267) still reads the OLD `leg.legCargo`
// field, which is `undefined` once `LEG_RFQ_INCLUDE` stops selecting it (confirmed — a live call
// now throws `TypeError: Cannot read properties of undefined (reading 'length')` and 500s instead
// of freezing). That line is explicitly Task 3's fix (same file, same line, per the Unit-1 plan:
// `docs/plans/stage-4/Stage 4 - FF Portal v2 - Implementation Plan.md`) — out of scope here.
// Task 3's own new e2e (`ff-portal-grain.e2e-spec.ts`) needs a working distribute as its setup,
// so the live HTTP path gets re-proven end-to-end once that lands.
const PFX = "MANIFEST_";
const CODE = `${PFX}1`;

describe(`${PFX}rfq-manifest (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role = Role.ADMINISTRATOR) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: "11111111-1111-1111-1111-111111111111", role, tenantId: null })}`;
  const api = () => request(app.getHttpServer());

  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: PFX } },
      select: { id: true },
    });
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
    await seedReferenceData(prisma); // CI has no seed; charge-line defs feed chargeConfigSnapshot at distribute
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("freezes a per-package manifest with canonical kg and effective DG tag", async () => {
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
    // DG comes from an ITEM tag, not the package's own tags — exercises effectiveTags (BL-3).
    await prisma.item.create({
      data: { packageId: pkg2.id, rowIndex: 0, product: "Battery pack", tags: ["DG"] },
    });

    // --- 1 leg, both packages assigned via LegPackage ---
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-MANIFEST-1",
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
        email: `ff-${PFX}a@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["AIR"],
        status: "ACTIVE",
        handleDg: true,
      },
    });

    await api()
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    // Freeze via the two functions Task 2 owns, chained exactly as
    // RfqService.performDistribution chains them (see header comment for why this doesn't go
    // through the live POST /distribute endpoint yet).
    const ctx = await loadLegForRfq(prisma, query.id, leg.id);
    expect(ctx.hasDg).toBe(true); // effectiveTags over the item-tagged package (BL-3)
    expect(ctx.freshQuotes.map((q) => q.freightForwarderId)).toEqual([ff.id]);

    const snap: ManifestSnapshot = buildManifestSnapshot(ctx, { incoterms: "FOB" }, new Date());
    expect(snap.cargo).toHaveLength(2);
    expect(snap.cargo[0]).toMatchObject({ packageId: expect.any(String), packageNo: expect.any(String) });
    expect(snap.cargo.some((c) => c.tags.includes("DG"))).toBe(true);
    expect(snap.cargo[0]).not.toHaveProperty("cargoItemId");
    expect(Number(snap.cargo[0].grossWt)).toBeGreaterThan(0); // canonical kg
  });
});
