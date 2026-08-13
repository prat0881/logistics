process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

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

// Task 10 (Unit 3, FF Portal v2 ripple): buildChargeConfigSnapshot must freeze the tag two-gate
// (design §13 / packages/shared/src/charge-config.ts resolveChargeConfig) against the SAME
// per-package manifest frozen alongside it at distribute — a TAG_DRIVEN catalogue line only
// freezes onto the quote when it is BOTH Executive-selected (LegChargeLineSelection) AND its
// tagKey is carried by at least one assigned package's effectiveTags (own tags ∪ item tags).
//
// This drives the REAL, unmodified HTTP distribute path (ff-selection -> distribute) against a
// real Cargo->Package->Item + LegPackage fixture (mirrors ff-portal-grain.e2e-spec.ts), then
// reads the frozen Quote.chargeConfigSnapshot directly off Postgres (mirrors
// charge-config-distribute.e2e-spec.ts).
//
// Before Task 10's fix: buildChargeConfigSnapshot calls resolveChargeConfig with only 3
// arguments, so the 4th `packageTags` parameter defaults to [] and the tag half of the two-gate
// can never be satisfied for ANY leg — every TAG_DRIVEN line is dropped regardless of selection.
// So AIR_TAG_DG (selected AND carried by an assigned package) is wrongly ABSENT from the frozen
// snapshot pre-fix — that's the RED this spec pins (AIR_TAG_FRAGILE's absence is a false-negative
// pass pre-fix, for the wrong reason — it only becomes a true assertion once tag-gating is real).
const PFX = "TAGGATE_";

describe(`${PFX}tag-two-gate (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role = Role.ADMINISTRATOR) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: "33333333-3333-3333-3333-333333333333", role, tenantId: null })}`;
  const api = () => request(app.getHttpServer());

  // Self-clean comms rows too (ScheduledEvent/MessageLog key off entityId as a plain string, not
  // a Prisma relation, so they don't cascade off a Query/Rfq delete) — mirrors ff-portal-grain.e2e-spec.ts.
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
    await seedReferenceData(prisma); // create-only upserts: guarantees AIR_TAG_DG/AIR_TAG_FRAGILE exist
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("freezes AIR_TAG_DG (selected + carried by an assigned package) but drops AIR_TAG_FRAGILE (selected, carried by none)", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const CODE = `${PFX}1`;

    // --- query -> cargo -> 1 package carrying a DG-tagged item (no FRAGILE anywhere) ---
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
    // DG comes from an ITEM tag, not the package's own tags — exercises effectiveTags (BL-3),
    // same fixture shape as rfq-manifest.e2e-spec.ts / ff-portal-grain.e2e-spec.ts.
    await prisma.item.create({
      data: { packageId: pkg.id, rowIndex: 0, product: "Battery pack", tags: ["DG"] },
    });

    // --- 1 AIR leg, the package assigned via LegPackage ---
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-TAGGATE-1",
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legPackages: { create: [{ packageId: pkg.id }] },
      },
    });

    // --- Executive selects BOTH tag-driven lines on the popover; only DG is actually carried ---
    const dgDef = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "AIR_TAG_DG" },
    });
    const fragileDef = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "AIR_TAG_FRAGILE" },
    });
    await prisma.legChargeLineSelection.create({ data: { legId: leg.id, definitionId: dgDef.id } });
    await prisma.legChargeLineSelection.create({
      data: { legId: leg.id, definitionId: fragileDef.id },
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

    // --- distribute ---
    const distRes = await api()
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    expect(distRes.body.rfqs[0].accessToken).toHaveLength(64);

    // --- the frozen chargeConfigSnapshot: two-gate resolved against the per-package manifest ---
    const quote = await prisma.quote.findFirstOrThrow({ where: { legId: leg.id } });
    const snap = quote.chargeConfigSnapshot as {
      lines: { definitionKey: string }[];
      warehouseIncluded: boolean;
    };
    const keys = snap.lines.map((l) => l.definitionKey);
    expect(keys).toContain("AIR_ORIGIN_THC"); // sanity: a CORE line always freezes
    expect(keys).toContain("AIR_TAG_DG"); // selected AND the assigned package's effectiveTags carries DG
    expect(keys).not.toContain("AIR_TAG_FRAGILE"); // selected but carried by no assigned package
  });
});
