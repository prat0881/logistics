process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { createHash } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE, type ManifestSnapshot } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

const PREFIX = "RFQ-DIST";
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
    // Clean up ALL sub-queries created by this spec (main CODE + sub-codes like CODE-AMD, CODE-DUP, etc.)
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
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Shared fixture helpers (created fresh per test that needs them)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Build a full "happy path" fixture set under a distinct legCode so multiple
   * tests can coexist in the same query without row collisions.
   */
  const mkLeg = async (
    queryId: string,
    opts: {
      legCode: string;
      mode?: "AIR" | "SEA" | "ROAD" | null;
      status?: string;
      isDangerous?: boolean;
      skipTargetDelivery?: boolean;
      skipCargo?: boolean;
      packageIds?: string[];
    },
  ) => {
    const origin = await prisma.point.create({
      data: { queryId, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId, type: "DELIVERY", country: "AE" },
    });

    let packageIds = opts.packageIds;
    if (!packageIds && !opts.skipCargo) {
      const built = await createCargoWithPackages(prisma, {
        queryId,
        packages: [
          { dimL: 10, dimW: 10, dimH: 10, grossWt: 1, tags: opts.isDangerous ? ["DG"] : [] },
        ],
      });
      packageIds = built.packageIds;
    }

    const leg = await prisma.leg.create({
      data: {
        queryId,
        legCode: opts.legCode,
        mode: opts.mode === null ? undefined : (opts.mode ?? "AIR"),
        status: (opts.status ?? "READY_FOR_RFQ") as "READY_FOR_RFQ" | "DRAFT",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: opts.skipTargetDelivery ? undefined : new Date(Date.now() + 86400000),
      },
    });
    if (packageIds && packageIds.length > 0) {
      await assignPackagesToLeg(prisma, leg.id, packageIds);
    }
    return leg;
  };

  it("distributes: mints RFQ, freezes manifest, advances statuses + query rollup", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    // --- build self-contained fixtures ---
    const query = await prisma.query.create({ data: { queryCode: CODE, incoterms: "FOB" } });
    const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
    const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ dimL: 10, dimW: 20, dimH: 30, grossWt: 5 }],
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L-DIST-1",
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);
    const ff = await mkFf(`FF-${PREFIX}-A`, ["CN", "AE"], ["AIR"], "ACTIVE");

    // Select FF via ff-selection endpoint to mint the SELECT quote
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    // --- distribute ---
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    expect(res.body.rfqs).toHaveLength(1);
    const entry = res.body.rfqs[0];
    expect(entry.minted).toBe(true);
    expect(entry.rfqNumber).toMatch(/-RFQ\d{3}$/);
    expect(entry.accessToken).toHaveLength(64);

    // --- verify RFQ row ---
    const rfq = await prisma.rfq.findUnique({ where: { id: entry.rfqId } });
    expect(rfq?.accessTokenHash).toHaveLength(64);
    expect(createHash("sha256").update(entry.accessToken).digest("hex")).toBe(rfq?.accessTokenHash);
    // deadline default ~ +48h
    expect(rfq!.submissionDeadline.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);

    // --- verify quote row ---
    const quote = await prisma.quote.findFirst({ where: { legId: leg.id } });
    expect(quote?.status).toBe("RFQ_SENT");
    expect(quote?.rfqId).toBe(entry.rfqId);
    expect(quote?.manifestSnapshot).toMatchObject({
      legId: leg.id,
      mode: "AIR",
      incoterms: "FOB",
      origin: { country: "CN" },
      destination: { country: "AE" },
    });
    const snap = quote?.manifestSnapshot as unknown as ManifestSnapshot;
    expect(snap.cargo).toEqual(
      expect.arrayContaining([expect.objectContaining({ packageId: packageIds[0] })]),
    );
    expect(Number(snap.cargo[0]!.grossWt)).toBe(5);

    // --- verify status rollup ---
    expect((await prisma.leg.findUnique({ where: { id: leg.id } }))?.status).toBe("RFQ_SENT");
    expect((await prisma.query.findUnique({ where: { id: query.id } }))?.status).toBe("RFQ_SENT");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Amend (D3): 2nd leg added to same FF reuses the same Rfq
  // ──────────────────────────────────────────────────────────────────────────
  it("amend: 2nd leg to same FF reuses the same Rfq (minted=false, same rfqNumber)", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    const query = await prisma.query.create({ data: { queryCode: `${CODE}-AMD`, incoterms: "FOB" } });
    // A separate cleanup entry so afterAll handles it
    const amdFF = await mkFf(`FF-${PREFIX}-AMD`, ["CN", "AE"], ["AIR"], "ACTIVE");
    const legA = await mkLeg(query.id, { legCode: "L-AMD-A" });
    const legB = await mkLeg(query.id, { legCode: "L-AMD-B" });

    // Select FF for leg A and distribute → mints the RFQ
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${legA.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [amdFF.id] })
      .expect(200);

    const res1 = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legA.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    const entry1 = res1.body.rfqs[0];
    expect(entry1.minted).toBe(true);
    const originalDeadline = (await prisma.rfq.findUnique({ where: { id: entry1.rfqId } }))!.submissionDeadline;

    // Select FF for leg B (same FF) and distribute → must AMEND (reuse same Rfq)
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${legB.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [amdFF.id] })
      .expect(200);

    const res2 = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legB.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    const entry2 = res2.body.rfqs[0];
    expect(entry2.minted).toBe(false);
    expect(entry2.rfqId).toBe(entry1.rfqId);
    expect(entry2.rfqNumber).toBe(entry1.rfqNumber);

    // FF has exactly ONE Rfq for this query
    const rfqCount = await prisma.rfq.count({ where: { queryId: query.id, freightForwarderId: amdFF.id } });
    expect(rfqCount).toBe(1);

    // leg B quote is RFQ_SENT
    const quoteB = await prisma.quote.findFirst({ where: { legId: legB.id } });
    expect(quoteB?.status).toBe("RFQ_SENT");

    // leg A deadline unchanged
    const rfqAfter = await prisma.rfq.findUnique({ where: { id: entry1.rfqId } });
    expect(rfqAfter!.submissionDeadline.getTime()).toBe(originalDeadline.getTime());

    // Cleanup this sub-query
    await prisma.quote.deleteMany({ where: { queryId: query.id } });
    await prisma.rfq.deleteMany({ where: { queryId: query.id } });
    await prisma.query.delete({ where: { id: query.id } });
    await prisma.freightForwarder.delete({ where: { id: amdFF.id } });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // F6 dup-guard: 409 on re-distribute; 201+skipped with confirm:true
  // ──────────────────────────────────────────────────────────────────────────
  it("F6 dup-guard: 409 on re-distribute; 201+skipped with confirm:true", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    const query = await prisma.query.create({ data: { queryCode: `${CODE}-DUP`, incoterms: "FOB" } });
    const dupFF = await mkFf(`FF-${PREFIX}-DUP`, ["CN", "AE"], ["AIR"], "ACTIVE");
    const leg = await mkLeg(query.id, { legCode: "L-DUP-A" });

    // Select + distribute
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [dupFF.id] })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    // 2nd distribute with no fresh SELECT quotes → 409
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(409);

    // With confirm:true → 201 with skipped
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({ confirm: true })
      .expect(201);

    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0]).toMatchObject({ legId: leg.id, reason: "already-distributed" });

    // Cleanup
    await prisma.quote.deleteMany({ where: { queryId: query.id } });
    await prisma.rfq.deleteMany({ where: { queryId: query.id } });
    await prisma.query.delete({ where: { id: query.id } });
    await prisma.freightForwarder.delete({ where: { id: dupFF.id } });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // F5: DG cargo + FF with handleDg:false → 400 F5_DG_FF_CANNOT_HANDLE
  // ──────────────────────────────────────────────────────────────────────────
  it("F5: DG cargo + FF handleDg:false → 400 with code F5_DG_FF_CANNOT_HANDLE", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    const query = await prisma.query.create({ data: { queryCode: `${CODE}-DG`, incoterms: "FOB" } });
    const dgFF = await mkFf(`FF-${PREFIX}-DG`, ["CN", "AE"], ["AIR"], "ACTIVE", false /* handleDg=false */);
    const leg = await mkLeg(query.id, { legCode: "L-DG-A", isDangerous: true });

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [dgFF.id] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(400);

    expect(res.body.codes).toContain("F5_DG_FF_CANNOT_HANDLE");

    // Cleanup
    await prisma.quote.deleteMany({ where: { queryId: query.id } });
    await prisma.rfq.deleteMany({ where: { queryId: query.id } });
    await prisma.query.delete({ where: { id: query.id } });
    await prisma.freightForwarder.delete({ where: { id: dgFF.id } });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // F1: incomplete leg (missing mode) → 400 F1_INCOMPLETE_LEG
  // ──────────────────────────────────────────────────────────────────────────
  it("F1: leg missing mode → 400 with code F1_INCOMPLETE_LEG", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    const query = await prisma.query.create({ data: { queryCode: `${CODE}-F1`, incoterms: "FOB" } });
    const f1FF = await mkFf(`FF-${PREFIX}-F1`, ["CN", "AE"], ["AIR"], "ACTIVE");
    const leg = await mkLeg(query.id, { legCode: "L-F1-A", mode: null });

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [f1FF.id] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(400);

    expect(res.body.codes).toContain("F1_INCOMPLETE_LEG");

    // Cleanup
    await prisma.quote.deleteMany({ where: { queryId: query.id } });
    await prisma.rfq.deleteMany({ where: { queryId: query.id } });
    await prisma.query.delete({ where: { id: query.id } });
    await prisma.freightForwarder.delete({ where: { id: f1FF.id } });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // F4: leg in DRAFT status → 400 F4_LEG_NOT_READY
  // ──────────────────────────────────────────────────────────────────────────
  it("F4: leg in DRAFT status → 400 with code F4_LEG_NOT_READY", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    const query = await prisma.query.create({ data: { queryCode: `${CODE}-F4`, incoterms: "FOB" } });
    const f4FF = await mkFf(`FF-${PREFIX}-F4`, ["CN", "AE"], ["AIR"], "ACTIVE");
    // Leg is otherwise complete (origin+dest, mode, cargo, dates) but status is DRAFT
    const leg = await mkLeg(query.id, { legCode: "L-F4-A", status: "DRAFT" });

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [f4FF.id] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(400);

    expect(res.body.codes).toContain("F4_LEG_NOT_READY");

    // Cleanup
    await prisma.quote.deleteMany({ where: { queryId: query.id } });
    await prisma.rfq.deleteMany({ where: { queryId: query.id } });
    await prisma.query.delete({ where: { id: query.id } });
    await prisma.freightForwarder.delete({ where: { id: f4FF.id } });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Override: future deadline accepted; past deadline → 400
  // ──────────────────────────────────────────────────────────────────────────
  it("override: future submissionDeadline is stored; past deadline → 400", async () => {
    const admin = cookie(Role.ADMINISTRATOR);

    const query = await prisma.query.create({ data: { queryCode: `${CODE}-OVR`, incoterms: "FOB" } });
    const ovrFF = await mkFf(`FF-${PREFIX}-OVR`, ["CN", "AE"], ["AIR"], "ACTIVE");
    const leg = await mkLeg(query.id, { legCode: "L-OVR-A" });

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ovrFF.id] })
      .expect(200);

    // Past deadline → 400
    const pastIso = new Date(Date.now() - 3600_000).toISOString();
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({ submissionDeadline: pastIso })
      .expect(400);

    // Future ~+72h deadline → 201 and stored
    const plus72h = new Date(Date.now() + 72 * 3600_000);
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({ submissionDeadline: plus72h.toISOString() })
      .expect(201);

    const entry = res.body.rfqs[0];
    const rfq = await prisma.rfq.findUnique({ where: { id: entry.rfqId } });
    // deadline should be within ±2 minutes of the requested +72h
    const diff = Math.abs(rfq!.submissionDeadline.getTime() - plus72h.getTime());
    expect(diff).toBeLessThan(2 * 60 * 1000);

    // Cleanup
    await prisma.quote.deleteMany({ where: { queryId: query.id } });
    await prisma.rfq.deleteMany({ where: { queryId: query.id } });
    await prisma.query.delete({ where: { id: query.id } });
    await prisma.freightForwarder.delete({ where: { id: ovrFF.id } });
  });
});
