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
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

// Task 10 (Charge Configuration & Warehouse Attribution), Phase D: a leg that touches a
// WAREHOUSE point cannot be distributed while warehouseHandlingIncluded is undecided (F7), and
// two legs sharing the same warehouse point cannot both carry Yes (F8). See
// apps/api/src/modules/rfq/warehouse.util.ts + rfq.service.ts validateLegForDistribution.
const PREFIX = "WH-ATTR";
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
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items
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

  it("F7: warehouse-touching leg with warehouseHandlingIncluded=null → 400 F7_WAREHOUSE_UNDECIDED; F8: two Yes on the same warehouse → 400 F8_WAREHOUSE_DOUBLE_YES; A=Yes,B=No → 201", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    // --- query + points: P1 (pickup), W (warehouse), P2 (delivery) ---
    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const p1 = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
    const w = await prisma.point.create({ data: { queryId: query.id, type: "WAREHOUSE", country: "CN" } });
    const p2 = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });

    // --- two ROAD legs, both F1-complete + READY_FOR_RFQ: A = P1→W, B = W→P2 ---
    const legA = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `L-${PREFIX}-A`,
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: p1.id,
        destinationPointId: w.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    const legB = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `L-${PREFIX}-B`,
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: w.id,
        destinationPointId: p2.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });

    // F1 (leg completeness) now gates on >=1 assigned package via LegPackage, not the dropped
    // flat CargoItem/LegCargo model — see helpers/cargo.ts. One package per leg, each in its own
    // Cargo grouping (mirrors the original's two independent CargoItem rows, cargoA/cargoB).
    const { packageIds: pkgA } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: `PO-${PREFIX}-A`, dimL: 10, dimW: 10, dimH: 10, grossWt: 5 }],
    });
    const { packageIds: pkgB } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: `PO-${PREFIX}-B`, dimL: 10, dimW: 10, dimH: 10, grossWt: 5 }],
    });
    await assignPackagesToLeg(prisma, legA.id, pkgA);
    await assignPackagesToLeg(prisma, legB.id, pkgB);

    // --- FF (ROAD) selected on both legs, so each has a SELECT quote (F2/F6 gate) ---
    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-A`,
        companyName: `FF-${PREFIX}-A Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PREFIX.toLowerCase()}-a@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["ROAD"],
        status: "ACTIVE",
      },
    });
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${legA.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${legB.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    // ── F7: A.warehouseHandlingIncluded = null (default) → distribute A blocked ──
    await prisma.leg.update({ where: { id: legA.id }, data: { warehouseHandlingIncluded: null } });
    const f7Res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legA.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(400);
    expect(f7Res.body.codes).toContain("F7_WAREHOUSE_UNDECIDED");

    // ── F8: A=Yes and B=Yes (same warehouse W) → distribute A blocked ──
    await prisma.leg.update({ where: { id: legA.id }, data: { warehouseHandlingIncluded: true } });
    await prisma.leg.update({ where: { id: legB.id }, data: { warehouseHandlingIncluded: true } });
    const f8Res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legA.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(400);
    expect(f8Res.body.codes).toContain("F8_WAREHOUSE_DOUBLE_YES");

    // ── success: A=Yes, B=No → distribute A succeeds ──
    await prisma.leg.update({ where: { id: legB.id }, data: { warehouseHandlingIncluded: false } });
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legA.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
  });
});
