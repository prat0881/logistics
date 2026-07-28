process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { createHash } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE, QuoteStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

const PREFIX = "RFQ-REISS";
const CODE = `YAL00-${PREFIX}`;
// A real UUID subject so the recorded audit actorId (a `@db.Uuid` column) is valid + assertable.
const ACTOR_ID = "11111111-1111-1111-1111-111111111111";

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  // Executive+ (the resolved RBAC): an Executive must be able to re-issue.
  const exec = () =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: ACTOR_ID, role: Role.EXECUTIVE, tenantId: null })}`;

  const mkFf = (code: string) =>
    prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `${code}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["AIR"],
        status: "ACTIVE",
        handleDg: false,
      },
    });

  const cleanup = async () => {
    // Rfq→Query and RfqTokenReissue→Rfq are onDelete: Cascade, so deleting a query
    // removes its rfqs and their audit rows; FFs (Restrict) are deleted after.
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    for (const q of qs) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } });
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

  /** Build a query+leg+FF and distribute so exactly one RFQ (query × FF) is minted. */
  const distributeOne = async (suffix: string) => {
    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-${suffix}`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const cargo = await prisma.cargoItem.create({
      data: {
        queryId: query.id,
        rowIndex: 0,
        poReference: "PO",
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
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `L-${suffix}`,
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
        legCargo: { create: { cargoItemId: cargo.id } },
      },
    });
    const ff = await mkFf(`FF-${PREFIX}-${suffix}`);
    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", exec())
      .send({ ffIds: [ff.id] })
      .expect(200);
    const dist = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", exec())
      .send({})
      .expect(201);
    const entry = dist.body.rfqs[0];
    return { query, leg, ff, entry };
  };

  it("rotates the token + records an audit row, leaving deadline/rfqNumber/quote status intact", async () => {
    const { query, ff, entry } = await distributeOne("A");
    const before = await prisma.rfq.findUnique({ where: { id: entry.rfqId } });
    const originalHash = before!.accessTokenHash;
    const originalDeadline = before!.submissionDeadline.getTime();

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/rfqs/reissue-token`)
      .set("Cookie", exec())
      .send({ freightForwarderId: ff.id })
      .expect(201);

    // response carries the new raw token + identifiers
    expect(res.body.rfqId).toBe(entry.rfqId);
    expect(res.body.rfqNumber).toBe(entry.rfqNumber);
    expect(res.body.freightForwarderId).toBe(ff.id);
    expect(res.body.accessToken).toHaveLength(64);
    expect(res.body.accessToken).not.toBe(entry.accessToken);

    const after = await prisma.rfq.findUnique({ where: { id: entry.rfqId } });
    // hash rotated to sha256 of the new token
    expect(after!.accessTokenHash).not.toBe(originalHash);
    expect(createHash("sha256").update(res.body.accessToken).digest("hex")).toBe(after!.accessTokenHash);
    // deadline + number untouched
    expect(after!.submissionDeadline.getTime()).toBe(originalDeadline);
    expect(after!.rfqNumber).toBe(entry.rfqNumber);
    // quote status untouched (still RFQ_SENT)
    const quote = await prisma.quote.findFirst({ where: { rfqId: entry.rfqId } });
    expect(quote!.status).toBe(QuoteStatus.RFQ_SENT);
    // exactly one audit row, attributed to the caller
    const audits = await prisma.rfqTokenReissue.findMany({ where: { rfqId: entry.rfqId } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(ACTOR_ID);
  });

  it("re-issuing again rotates again and adds a second audit row", async () => {
    const { query, ff, entry } = await distributeOne("B");

    const r1 = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/rfqs/reissue-token`)
      .set("Cookie", exec())
      .send({ freightForwarderId: ff.id })
      .expect(201);
    const r2 = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/rfqs/reissue-token`)
      .set("Cookie", exec())
      .send({ freightForwarderId: ff.id })
      .expect(201);

    expect(r2.body.accessToken).not.toBe(r1.body.accessToken);
    const audits = await prisma.rfqTokenReissue.findMany({ where: { rfqId: entry.rfqId } });
    expect(audits).toHaveLength(2);
  });

  it("404 when no RFQ exists for (query, FF)", async () => {
    const { query } = await distributeOne("C");
    const otherFf = await mkFf(`FF-${PREFIX}-OTHER`); // ACTIVE FF never distributed to on this query
    await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/rfqs/reissue-token`)
      .set("Cookie", exec())
      .send({ freightForwarderId: otherFf.id })
      .expect(404);
  });

  it("401 when unauthenticated (locks the auth guard on the route)", async () => {
    await request(app.getHttpServer())
      .post(`/api/queries/${ACTOR_ID}/rfqs/reissue-token`)
      .send({ freightForwarderId: ACTOR_ID })
      .expect(401);
  });
});
