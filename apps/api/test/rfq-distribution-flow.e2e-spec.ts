process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { createHash } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

const PREFIX = "RFQ-FLOW";
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
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/cargo/legCargo
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
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("full distribution flow: eligible-ffs → select → distribute → amend → distribute-all → dup-guard", async () => {
    const exec = cookie(Role.EXECUTIVE);

    // ──────────────────────────────────────────────────────────────────────────
    // Fixtures: 2-leg query, two ACTIVE FFs covering both leg countries + mode
    // ──────────────────────────────────────────────────────────────────────────

    // Query with incoterms
    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const queryId = query.id;
    const queryCode = query.queryCode;

    // Two FFs: both serving CN + AE via AIR (so each leg's country set is fully covered)
    const ffX = await mkFf(`FF-${PREFIX}-X`, ["CN", "AE"], ["AIR"], "ACTIVE", false);
    const ffY = await mkFf(`FF-${PREFIX}-Y`, ["CN", "AE"], ["AIR"], "ACTIVE", false);

    // Helper: build a complete READY_FOR_RFQ leg with non-DG cargo
    const mkReadyLeg = async (legCode: string) => {
      const origin = await prisma.point.create({
        data: { queryId, type: "PICKUP", country: "CN" },
      });
      const dest = await prisma.point.create({
        data: { queryId, type: "DELIVERY", country: "AE" },
      });
      const cargo = await prisma.cargoItem.create({
        data: {
          queryId,
          rowIndex: 0,
          poReference: `PO-${legCode}`,
          productName: "Widget",
          packageType: "BOX",
          qty: 1,
          dimL: 10,
          dimW: 10,
          dimH: 10,
          grossWt: 1,
          isDangerous: false,
        },
      });
      return prisma.leg.create({
        data: {
          queryId,
          legCode,
          mode: "AIR",
          status: "READY_FOR_RFQ",
          originPointId: origin.id,
          destinationPointId: dest.id,
          readyDate: new Date(),
          targetDelivery: new Date(Date.now() + 86400000),
          legCargo: { create: { cargoItemId: cargo.id } },
        },
      });
    };

    const l1 = await mkReadyLeg("L-FLOW-1");
    const l2 = await mkReadyLeg("L-FLOW-2");

    // ──────────────────────────────────────────────────────────────────────────
    // Step 1: GET eligible-ffs for L1 → both FF-X and FF-Y must appear
    // ──────────────────────────────────────────────────────────────────────────

    const eligRes = await request(app.getHttpServer())
      .get(`/api/queries/${queryId}/legs/${l1.id}/eligible-ffs`)
      .set("Cookie", exec)
      .expect(200);

    const eligIds: string[] = eligRes.body.map((f: { id: string }) => f.id);
    expect(eligIds).toContain(ffX.id);
    expect(eligIds).toContain(ffY.id);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 2: Select FF-X on L1 → distribute L1 → assert minted RFQ
    // ──────────────────────────────────────────────────────────────────────────

    await request(app.getHttpServer())
      .put(`/api/queries/${queryId}/legs/${l1.id}/ff-selection`)
      .set("Cookie", exec)
      .send({ ffIds: [ffX.id] })
      .expect(200);

    const distL1Res = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/legs/${l1.id}/distribute`)
      .set("Cookie", exec)
      .send({})
      .expect(201);

    expect(distL1Res.body.rfqs).toHaveLength(1);
    const entryL1 = distL1Res.body.rfqs[0];

    // minted=true for a new RFQ
    expect(entryL1.minted).toBe(true);

    // rfqNumber matches the pattern and specifically equals `${queryCode}-RFQ001`
    expect(entryL1.rfqNumber).toMatch(/-RFQ\d{3}$/);
    expect(entryL1.rfqNumber).toBe(`${queryCode}-RFQ001`);

    // accessToken is a 64-char hex string; sha256(token) === accessTokenHash
    expect(entryL1.accessToken).toHaveLength(64);
    const rfqL1 = await prisma.rfq.findUnique({ where: { id: entryL1.rfqId } });
    expect(rfqL1).not.toBeNull();
    expect(createHash("sha256").update(entryL1.accessToken as string).digest("hex")).toBe(
      rfqL1!.accessTokenHash,
    );

    // L1 leg status → RFQ_SENT
    const legL1After = await prisma.leg.findUnique({ where: { id: l1.id } });
    expect(legL1After?.status).toBe("RFQ_SENT");

    // FF-X quote on L1 → RFQ_SENT
    const quoteL1 = await prisma.quote.findFirst({ where: { legId: l1.id, freightForwarderId: ffX.id } });
    expect(quoteL1?.status).toBe("RFQ_SENT");

    // Store for later amend assertions
    const rfqIdForFfX = entryL1.rfqId as string;
    const rfqNumberForFfX = entryL1.rfqNumber as string;

    // ──────────────────────────────────────────────────────────────────────────
    // Step 3: With L2 still READY_FOR_RFQ, query is NOT yet fully RFQ_SENT
    // (least-advanced gate: query status lags until ALL legs are RFQ_SENT)
    // ──────────────────────────────────────────────────────────────────────────

    const queryAfterL1 = await prisma.query.findUnique({ where: { id: queryId } });
    // Don't assert an exact intermediate value — it depends on rfqReadyAt rollup
    expect(queryAfterL1?.status).not.toBe("RFQ_SENT");

    // ──────────────────────────────────────────────────────────────────────────
    // Step 4: Select FF-X on L2 → distribute L2 → assert AMEND (same Rfq)
    // ──────────────────────────────────────────────────────────────────────────

    await request(app.getHttpServer())
      .put(`/api/queries/${queryId}/legs/${l2.id}/ff-selection`)
      .set("Cookie", exec)
      .send({ ffIds: [ffX.id] })
      .expect(200);

    const distL2Res = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/legs/${l2.id}/distribute`)
      .set("Cookie", exec)
      .send({})
      .expect(201);

    expect(distL2Res.body.rfqs).toHaveLength(1);
    const entryL2 = distL2Res.body.rfqs[0];

    // minted=false → this is an amend (existing Rfq reused)
    expect(entryL2.minted).toBe(false);

    // Same rfqId and rfqNumber as step 2 (one-RFQ-per-(query, FF))
    expect(entryL2.rfqId).toBe(rfqIdForFfX);
    expect(entryL2.rfqNumber).toBe(rfqNumberForFfX);

    // FF-X still has exactly ONE Rfq for this query
    const rfqCountFfX = await prisma.rfq.count({ where: { queryId, freightForwarderId: ffX.id } });
    expect(rfqCountFfX).toBe(1);

    // L2 leg status → RFQ_SENT
    const legL2After = await prisma.leg.findUnique({ where: { id: l2.id } });
    expect(legL2After?.status).toBe("RFQ_SENT");

    // ──────────────────────────────────────────────────────────────────────────
    // Step 5: Both legs are now RFQ_SENT → query status must be RFQ_SENT
    // ──────────────────────────────────────────────────────────────────────────

    const queryAfterBothLegs = await prisma.query.findUnique({ where: { id: queryId } });
    expect(queryAfterBothLegs?.status).toBe("RFQ_SENT");

    // ──────────────────────────────────────────────────────────────────────────
    // Step 6: Re-distribute L1 (no fresh SELECT quotes) → 409 dup-guard
    // ──────────────────────────────────────────────────────────────────────────

    await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/legs/${l1.id}/distribute`)
      .set("Cookie", exec)
      .send({})
      .expect(409);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 7: Add FF-Y on both legs via ff-selection, then distribute-all
    //   - ff-selection must NOT disturb the frozen FF-X (RFQ_SENT) quotes
    //   - distribute-all must produce exactly ONE Rfq for FF-Y spanning both legs
    // ──────────────────────────────────────────────────────────────────────────

    // Add FF-Y to L1 (alongside already-sent FF-X → SELECT quote added for FF-Y only)
    await request(app.getHttpServer())
      .put(`/api/queries/${queryId}/legs/${l1.id}/ff-selection`)
      .set("Cookie", exec)
      .send({ ffIds: [ffY.id] })
      .expect(200);

    // Add FF-Y to L2
    await request(app.getHttpServer())
      .put(`/api/queries/${queryId}/legs/${l2.id}/ff-selection`)
      .set("Cookie", exec)
      .send({ ffIds: [ffY.id] })
      .expect(200);

    // distribute-all → mints one RFQ for FF-Y covering both legs
    const distAllRes = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/distribute-all`)
      .set("Cookie", exec)
      .send({})
      .expect(201);

    // Exactly one RFQ entry for FF-Y
    const rfqCountFfY = await prisma.rfq.count({ where: { queryId, freightForwarderId: ffY.id } });
    expect(rfqCountFfY).toBe(1);

    // The response entry for FF-Y should span both legs
    const ffYEntry = distAllRes.body.rfqs.find(
      (r: { freightForwarderId: string }) => r.freightForwarderId === ffY.id,
    );
    expect(ffYEntry).toBeDefined();
    const ffYLegIds: string[] = [...(ffYEntry.legIds as string[])].sort();
    expect(ffYLegIds).toEqual([l1.id, l2.id].sort());

    // Both legs still RFQ_SENT (FF-Y distribution doesn't regress status)
    const l1Final = await prisma.leg.findUnique({ where: { id: l1.id } });
    const l2Final = await prisma.leg.findUnique({ where: { id: l2.id } });
    expect(l1Final?.status).toBe("RFQ_SENT");
    expect(l2Final?.status).toBe("RFQ_SENT");

    // Query status still RFQ_SENT
    const queryFinal = await prisma.query.findUnique({ where: { id: queryId } });
    expect(queryFinal?.status).toBe("RFQ_SENT");
  });
});
