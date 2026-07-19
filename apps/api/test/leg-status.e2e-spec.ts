import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { LegEvent, LegStatus, QueryStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { StatusService } from "../src/modules/status/status.service";

const PFX = "p5-legstatus-";

describe("Leg status column + projector rollup (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let status: StatusService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    status = moduleRef.get(StatusService);
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("fire('leg', validate.pass) writes Leg.status + a StatusTransition + rolls up the query", async () => {
    const q = await prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}q`, rfqReadyAt: new Date() },
    });
    const leg = await prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "ROAD" } });

    await status.fire("leg", leg.id, LegEvent.VALIDATE_PASS, { routeValid: true, queryId: q.id });

    const reloaded = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(reloaded?.status).toBe(LegStatus.READY_FOR_RFQ);
    const log = await prisma.statusTransition.findFirst({ where: { entity: "leg", entityId: leg.id }, orderBy: { seq: "desc" } });
    expect(log?.to).toBe(LegStatus.READY_FOR_RFQ);

    // Give the async @OnEvent projector a tick, then assert the rollup.
    await new Promise((r) => setTimeout(r, 50));
    const rq = await prisma.query.findUnique({ where: { id: q.id }, select: { status: true } });
    expect(rq?.status).toBe(QueryStatus.RFQ_READY);
  });

  it("blocks validate.pass when routeValid is not true (guard returns findings)", async () => {
    const q = await prisma.query.create({ data: { queryCode: `${PFX}${Date.now()}-b`, shipmentDescription: `${PFX}q` } });
    const leg = await prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "ROAD" } });
    await expect(status.fire("leg", leg.id, LegEvent.VALIDATE_PASS, { routeValid: false, queryId: q.id })).rejects.toThrow();
    const reloaded = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(reloaded?.status).toBe(LegStatus.DRAFT);
  });
});
