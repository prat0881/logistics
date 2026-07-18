process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Finding } from "@svyft/shared";
import { LegEvent, LegStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { StatusService } from "../src/modules/status/status.service";
import { QueryStatusProjector } from "../src/modules/status/query-status.projector";
import { IllegalTransitionError, TransitionBlockedError } from "../src/modules/status/errors";

const PREFIX = "p3-status-";

describe("Status Machine (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let status: StatusService;
  let projector: QueryStatusProjector;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    status = moduleRef.get(StatusService);
    projector = moduleRef.get(QueryStatusProjector);
    await prisma.statusTransition.deleteMany({ where: { entityId: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await prisma.statusTransition.deleteMany({ where: { entityId: { startsWith: PREFIX } } });
    await app.close();
  });

  it("fires the forward edge (guard passes) → READY_FOR_RFQ + a StatusTransition row", async () => {
    const id = `${PREFIX}forward`;
    const res = await status.fire("leg", id, LegEvent.VALIDATE_PASS, { routeValid: true });
    expect(res.from).toBe(LegStatus.DRAFT); // no prior rows → machine.initial
    expect(res.to).toBe(LegStatus.READY_FOR_RFQ);

    const rows = await prisma.statusTransition.findMany({ where: { entityId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: "DRAFT", to: "READY_FOR_RFQ", event: "validate.pass" });
  });

  it("blocks the forward edge when the guard fails, carrying Finding[] and persisting nothing", async () => {
    const id = `${PREFIX}blocked`;
    const finding: Finding = {
      rule: "R1",
      severity: "blocking",
      scope: { type: "leg", id },
      message: "route not valid",
    };
    let err: unknown;
    try {
      await status.fire("leg", id, LegEvent.VALIDATE_PASS, {
        routeValid: false,
        findings: [finding],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TransitionBlockedError);
    expect((err as TransitionBlockedError).findings).toEqual([finding]);
    expect(await prisma.statusTransition.count({ where: { entityId: id } })).toBe(0);
  });

  it("blocks with a default Finding when routeValid is false and no findings are supplied", async () => {
    const id = `${PREFIX}default-finding`;
    let err: unknown;
    try {
      await status.fire("leg", id, LegEvent.VALIDATE_PASS, { routeValid: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TransitionBlockedError);
    expect((err as TransitionBlockedError).findings).toEqual([
      {
        rule: "C1",
        severity: "blocking",
        scope: { type: "leg" },
        message: "Leg is incomplete or its route is not valid",
      },
    ]);
    expect(await prisma.statusTransition.count({ where: { entityId: id } })).toBe(0);
  });

  it("rejects an illegal (state,event) pair with IllegalTransitionError, persisting nothing", async () => {
    const id = `${PREFIX}illegal`;
    await expect(status.fire("leg", id, LegEvent.REOPEN)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    expect(await prisma.statusTransition.count({ where: { entityId: id } })).toBe(0);
  });

  it("drives the reopen reverse edge READY_FOR_RFQ → DRAFT (the seam's status half)", async () => {
    const id = `${PREFIX}reopen`;
    await status.fire("leg", id, LegEvent.VALIDATE_PASS, { routeValid: true });
    const res = await status.fire("leg", id, LegEvent.REOPEN);
    expect(res.from).toBe(LegStatus.READY_FOR_RFQ);
    expect(res.to).toBe(LegStatus.DRAFT);
    const latest = await prisma.statusTransition.findFirst({
      where: { entityId: id },
      orderBy: { seq: "desc" },
    });
    expect(latest).toMatchObject({ from: "READY_FOR_RFQ", to: "DRAFT", event: "reopen" });
  });

  it("emits leg.status.changed → QueryStatusProjector.recompute(queryId)", async () => {
    const id = `${PREFIX}event`;
    const spy = jest.spyOn(projector, "recompute");
    await status.fire("leg", id, LegEvent.VALIDATE_PASS, { routeValid: true, queryId: "q-42" });
    // EventEmitter2 emit is synchronous → the listener has already invoked recompute.
    expect(spy).toHaveBeenCalledWith("q-42");
    spy.mockRestore();
  });

  it("projects derived query status from leg statuses (pure projection reused by Plan 4/5)", () => {
    expect(projector.project([LegStatus.READY_FOR_RFQ], { created: true })).toBe("RFQ_READY");
    expect(projector.project([LegStatus.DRAFT, LegStatus.READY_FOR_RFQ])).toBe("DRAFT");
  });
});
