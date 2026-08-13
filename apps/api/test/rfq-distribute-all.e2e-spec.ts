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
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

const PREFIX = "RFQ-DALL";
const CODE = `YAL00-${PREFIX}`;

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  const mkFf = (
    code: string,
    countries: string[] = ["AE"],
    modes: ("AIR" | "SEA" | "ROAD")[] = ["AIR"],
    status: "ACTIVE" | "INACTIVE" = "ACTIVE",
    handleDg = false,
  ) =>
    prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `${code}@e2e.test`,
        availableCountries: countries,
        modes,
        status,
        handleDg,
      },
    });

  const cleanup = async () => {
    // order matters: quotes/rfqs reference FF (Restrict) and query (Cascade)
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    for (const q of qs) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items
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
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("distribute-all groups by FF: one RFQ for FF across both legs; skips non-ready legs", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    // Build a query with four legs:
    //   L1, L2 — READY_FOR_RFQ + FF selected → distributed
    //   L3     — READY_FOR_RFQ with NO selection → exercises the "nothing-selected" skip
    //   L4     — DRAFT + FF selected → reaches validateLegForDistribution, fails F4 → exercises gate-skip
    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });

    // Shared FF-X covering both leg endpoints
    const ffX = await mkFf(`FF-${PREFIX}-X`, ["CN", "AE"], ["AIR"], "ACTIVE", false);

    // Helper to build a ready leg with cargo
    const mkReadyLeg = async (legCode: string) => {
      const origin = await prisma.point.create({
        data: { queryId: query.id, type: "PICKUP", country: "CN" },
      });
      const dest = await prisma.point.create({
        data: { queryId: query.id, type: "DELIVERY", country: "AE" },
      });
      const { packageIds } = await createCargoWithPackages(prisma, {
        queryId: query.id,
        packages: [{ dimL: 10, dimW: 10, dimH: 10, grossWt: 1 }], // non-DG
      });
      const leg = await prisma.leg.create({
        data: {
          queryId: query.id,
          legCode,
          mode: "AIR",
          status: "READY_FOR_RFQ",
          originPointId: origin.id,
          destinationPointId: dest.id,
          readyDate: new Date(),
          targetDelivery: new Date(Date.now() + 86400000),
        },
      });
      await assignPackagesToLeg(prisma, leg.id, packageIds);
      return leg;
    };

    const l1 = await mkReadyLeg("L-DALL-1");
    const l2 = await mkReadyLeg("L-DALL-2");

    // L3: READY_FOR_RFQ with NO selection — exercises the "nothing-selected" skip
    const originL3 = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const destL3 = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const { packageIds: packageIdsL3 } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      rowIndex: 1,
      packages: [{ dimL: 10, dimW: 10, dimH: 10, grossWt: 1 }],
    });
    const legL3 = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-DALL-3",
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: originL3.id,
        destinationPointId: destL3.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    await assignPackagesToLeg(prisma, legL3.id, packageIdsL3);

    // L4: DRAFT + FF selected → reaches validateLegForDistribution, fails F4 — exercises the gate-skip branch
    const originL4 = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const destL4 = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const { packageIds: packageIdsL4 } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      rowIndex: 2,
      packages: [{ dimL: 10, dimW: 10, dimH: 10, grossWt: 1 }],
    });
    const l4 = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-DALL-4",
        mode: "AIR",
        status: "DRAFT", // only F4 fires; all other fields are complete
        originPointId: originL4.id,
        destinationPointId: destL4.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    await assignPackagesToLeg(prisma, l4.id, packageIdsL4);

    // Select FF-X on L1, L2, and L4 via ff-selection endpoint
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${l1.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ffX.id] })
      .expect(200);

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${l2.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ffX.id] })
      .expect(200);

    // L4: select FF-X so it has a fresh quote and reaches validateLegForDistribution (fails F4)
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${l4.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ffX.id] })
      .expect(200);

    // Call distribute-all
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/distribute-all`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    // ONE RFQ for FF-X spanning both legs
    expect(res.body.rfqs).toHaveLength(1);
    expect(res.body.rfqs[0].legIds.sort()).toEqual([l1.id, l2.id].sort());
    expect(res.body.distributedLegIds.sort()).toEqual([l1.id, l2.id].sort());

    // DB assertions
    expect(
      await prisma.rfq.count({ where: { queryId: query.id, freightForwarderId: ffX.id } }),
    ).toBe(1);
    expect((await prisma.leg.findUnique({ where: { id: l1.id } }))?.status).toBe("RFQ_SENT");
    expect((await prisma.leg.findUnique({ where: { id: l2.id } }))?.status).toBe("RFQ_SENT");
    // L3 has no selection → skipped with "nothing-selected" → still READY_FOR_RFQ (not sent)
    const l3 = await prisma.leg.findFirst({ where: { queryId: query.id, legCode: "L-DALL-3" } });
    expect(l3?.status).toBe("READY_FOR_RFQ");
    // L4 is DRAFT + has FF selected → fails F4 gate → skipped with "F4_LEG_NOT_READY" → still DRAFT
    expect((await prisma.leg.findUnique({ where: { id: l4.id } }))?.status).toBe("DRAFT");

    // skipped array reports both L3 (nothing-selected) and L4 (gate failure F4)
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ legId: l3?.id, reason: "nothing-selected" }),
        expect.objectContaining({ legId: l4.id, reason: "F4_LEG_NOT_READY" }),
      ]),
    );
  });
});
