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

  it("charge selection: free pre-distribute (200, reflected in GET), locked post-distribute (409 needsChangeOrder)", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const server = app.getHttpServer();

    // --- a non-warehouse ROAD leg (PICKUP → DELIVERY) so F7/F8 never engage; ROAD is used
    //     (not AIR) because checkModeEndpoints requires AIRPORT/AIRPORT for AIR — ROAD has no
    //     endpoint-type constraint, so PICKUP/DELIVERY doesn't trip the V-M1 guard in
    //     legs.service.ts `update()` (assertModeEndpoints), which is unrelated to Task 11 ---
    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });
    const cargo = await prisma.cargoItem.create({
      data: {
        queryId: query.id,
        rowIndex: 0,
        poReference: "PO-CHG-LOCK-1",
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
        legCode: "L-CHG-LOCK-1",
        mode: "ROAD",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legCargo: { create: { cargoItemId: cargo.id } },
      },
    });
    const roadInsurance = await prisma.chargeLineDefinition.findUniqueOrThrow({ where: { key: "ROAD_STD_INSURANCE" } });

    // --- pre-distribute: PATCH selection applies freely (200) ---
    await request(server)
      .patch(`/api/queries/${query.id}/legs/${leg.id}`)
      .set("Cookie", admin)
      .send({ chargeLineDefinitionIds: [roadInsurance.id] })
      .expect(200);

    // --- reflected in GET /api/queries/:id's leg DTO ---
    const afterPatch = await request(server).get(`/api/queries/${query.id}`).set("Cookie", admin).expect(200);
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
    const afterReject = await request(server).get(`/api/queries/${query.id}`).set("Cookie", admin).expect(200);
    const legDtoAfter = afterReject.body.legs.find((l: { id: string }) => l.id === leg.id);
    expect(legDtoAfter.chargeLineDefinitionIds).toEqual([roadInsurance.id]);
  });
});
