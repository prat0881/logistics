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

// Task 8 (Charge Configuration & Warehouse Attribution): at distribute, each quote's
// chargeConfigSnapshot must freeze the leg's effective mandatory-to-price PLAIN charge set —
// CORE lines always, STANDARD/TAG_DRIVEN lines only when Executive-selected via
// LegChargeLineSelection — plus the leg's warehouseHandlingIncluded toggle. See
// packages/shared/src/charge-config.ts (resolveChargeConfig) and
// apps/api/src/modules/rfq/charge-config.snapshot.ts (buildChargeConfigSnapshot).
const PREFIX = "CHG-CFG-DIST";
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
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/cargo/legCargo/chargeSelections
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
    // create-only upserts: guarantees the charge-line catalogue (+ other reference rows)
    // exists regardless of test order/DB state (CI has no seed step).
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("freezes chargeConfigSnapshot at distribute: cores + selected standard in, unselected standard out, warehouse toggle carried", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    // --- build an AIR leg with an origin+dest point and cargo ---
    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });
    const cargo = await prisma.cargoItem.create({
      data: {
        queryId: query.id,
        rowIndex: 0,
        poReference: "PO-CHG-1",
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
        legCode: "L-CHG-1",
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legCargo: { create: { cargoItemId: cargo.id } },
      },
    });

    // --- Executive selects AIR_DEST_THC (a STANDARD line) on the popover; nothing else ---
    const destThc = await prisma.chargeLineDefinition.findUniqueOrThrow({ where: { key: "AIR_DEST_THC" } });
    await prisma.legChargeLineSelection.create({ data: { legId: leg.id, definitionId: destThc.id } });

    // --- 1 FF selected for RFQ ---
    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-A`,
        companyName: `FF-${PREFIX}-A Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `FF-${PREFIX}-A@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["AIR"],
        status: "ACTIVE",
      },
    });

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    // --- distribute ---
    const distRes = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const token = distRes.body.rfqs[0].accessToken as string;

    // --- verify the frozen chargeConfigSnapshot on the quote ---
    const quote = await prisma.quote.findFirstOrThrow({ where: { legId: leg.id } });
    const snap = quote.chargeConfigSnapshot as { lines: { definitionKey: string }[]; warehouseIncluded: boolean };
    const keys = snap.lines.map((l) => l.definitionKey);
    expect(keys).toContain("AIR_ORIGIN_THC"); // a core
    expect(keys).toContain("AIR_DEST_THC"); // selected
    expect(keys).not.toContain("AIR_DEST_IMPORT_CLEARANCE"); // unselected standard
    expect(snap.warehouseIncluded).toBe(false);

    // --- Task 9: the FF portal GET must seed legs[0].seededCharges FROM this frozen
    //     snapshot (not the old hardcoded AIR_CHARGE_PRESETS) ---
    const portalRes = await request(app.getHttpServer())
      .get(`/api/ff/rfq/${token}`)
      .expect(200); // no auth cookie — the token IS the auth
    const seededKeys = portalRes.body.legs[0].seededCharges.map(
      (c: { definitionKey: string }) => c.definitionKey,
    );
    expect(seededKeys).toContain("AIR_ORIGIN_THC"); // a core
    expect(seededKeys).toContain("AIR_DEST_THC"); // selected standard
    expect(seededKeys).not.toContain("AIR_DEST_IMPORT_CLEARANCE"); // unselected standard
    expect(portalRes.body.legs[0].warehouseIncluded).toBe(false);
  });

  // ── Task 9: FF portal seeding + submit gate wired to the frozen snapshot ──

  let fixtureSeq = 0;
  /**
   * Build Query → origin/dest Points → CargoItem → Leg(mode, READY_FOR_RFQ) → FF(modes:[mode])
   * → optional LegChargeLineSelection(s) → PUT ff-selection → POST distribute.
   * Mirrors ff-portal.e2e-spec.ts's distributeFixture. Returns the raw accessToken + ids.
   */
  async function distributeFixture(opts: {
    mode: "AIR" | "SEA" | "ROAD";
    selectKeys?: string[];
  }): Promise<{ token: string; legId: string; queryId: string }> {
    const admin = cookie(Role.ADMINISTRATOR);
    const seq = ++fixtureSeq;
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-FIX-${seq}`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });
    const cargo = await prisma.cargoItem.create({
      data: {
        queryId: query.id,
        rowIndex: 0,
        poReference: `PO-${PREFIX}-${seq}`,
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
        legCode: `L-${PREFIX}-${seq}`,
        mode: opts.mode,
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legCargo: { create: { cargoItemId: cargo.id } },
      },
    });
    for (const key of opts.selectKeys ?? []) {
      const def = await prisma.chargeLineDefinition.findUniqueOrThrow({ where: { key } });
      await prisma.legChargeLineSelection.create({ data: { legId: leg.id, definitionId: def.id } });
    }
    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-${seq}`,
        companyName: `FF-${PREFIX}-${seq} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PREFIX.toLowerCase()}-${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: [opts.mode],
        status: "ACTIVE",
        defaultCurrency: "USD",
      },
    });
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
    return { token: res.body.rfqs[0].accessToken as string, legId: leg.id, queryId: query.id };
  }

  /**
   * Build a complete valid draft from the GET response body (mirrors ff-portal.e2e-spec.ts's
   * fullValidDraft, keyed by definitionKey instead of presetKey — the post-Task-9 shape).
   * Optionally omit one mandatory line's charge (`omitKey`) to exercise the Q1 gate.
   */
  function fullValidDraft(
    legId: string,
    mode: "AIR" | "SEA" | "ROAD",
    getBody: {
      legs: Array<{
        seededDensity: Array<{ cargoItemId: string; freightDensity: number }>;
        seededCharges: Array<{ zone: string | null; definitionKey: string; label: string }>;
      }>;
    },
    opts?: { omitKey?: string },
  ) {
    const leg = getBody.legs[0];
    return {
      legId,
      mode,
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      cargo: leg.seededDensity.map((d) => ({
        cargoItemId: d.cargoItemId,
        grossWtT: 1,
        cbm: 1,
        isDangerous: false,
        freightDensity: d.freightDensity,
      })),
      charges: leg.seededCharges
        .filter((c) => c.definitionKey !== opts?.omitKey)
        .map((c, i) => ({
          zone: c.zone,
          definitionKey: c.definitionKey,
          presetKey: null,
          label: c.label,
          amount: i === 0 ? 0 : 10, // 0 is a valid price — Q1 treats amount != null as "priced"
        })),
      trucking: [],
      warehouse: [],
      transit: {
        departureDate: "2026-08-12T00:00:00.000Z",
        arrivalDate: "2026-08-14T00:00:00.000Z",
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };
  }

  it("FF portal seeds a Road PLAIN charge line when selected (previously seeded [])", async () => {
    const { token } = await distributeFixture({ mode: "ROAD", selectKeys: ["ROAD_STD_INSURANCE"] });

    const res = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);

    const seededKeys = res.body.legs[0].seededCharges.map((c: { definitionKey: string }) => c.definitionKey);
    expect(seededKeys).toContain("ROAD_STD_INSURANCE");
  });

  it("submit: all mandatory lines priced (0 allowed) → 201 QUOTED", async () => {
    const { token, legId } = await distributeFixture({ mode: "AIR" });
    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);

    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(fullValidDraft(legId, "AIR", got.body))
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .expect(201);

    expect(res.body.status).toBe("QUOTED");
  });

  it("submit: an unpriced mandatory line → 422 with a Q1 finding", async () => {
    const { token, legId } = await distributeFixture({ mode: "AIR" });
    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const mandatoryKey = got.body.legs[0].seededCharges[0].definitionKey as string;

    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(fullValidDraft(legId, "AIR", got.body, { omitKey: mandatoryKey }))
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .expect(422);

    expect(res.body.findings.some((f: { rule: string }) => f.rule === "Q1")).toBe(true);
  });
});
