process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Finding } from "@svyft/shared";
import { LegEvent, LegStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { StatusService } from "../src/modules/status/status.service";
import { QueryStatusProjector } from "../src/modules/status/query-status.projector";
import { StatusRegistry } from "../src/modules/status/status.registry";
import type { StatusMachine } from "../src/modules/status/status.types";
import { legMachine, legTransitions } from "../src/modules/status/leg.machine";
import { IllegalTransitionError, TransitionBlockedError } from "../src/modules/status/errors";

const PREFIX = "p3-status-";

describe("Status Machine (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let status: StatusService;
  let projector: QueryStatusProjector;

  // Task 7: fire("leg", …) now reads AND writes the Leg.status column (DispatchingStateStore),
  // so every fire against the real `leg` machine needs a real Leg row — Leg.id is @db.Uuid, so a
  // synthetic non-uuid entityId would now throw P2023 on load, and a successful forward/reopen
  // would 404 (P2025) trying to update a row that doesn't exist. Each test gets its OWN fresh
  // Query+Leg (never reused across tests) so a persisted status change can't leak between tests.
  async function makeLeg(label: string) {
    const query = await prisma.query.create({
      data: { queryCode: `${PREFIX}${label}-${Date.now()}` },
    });
    const leg = await prisma.leg.create({
      data: { queryId: query.id, legCode: "L1", mode: "ROAD" },
    });
    return { query, leg };
  }

  async function cleanup(): Promise<void> {
    const legs = await prisma.leg.findMany({
      where: { query: { queryCode: { startsWith: PREFIX } } },
      select: { id: true },
    });
    // StatusTransition has no FK to Leg (entity/entityId is a free-text log key) — Query's
    // cascade delete won't touch it, so the log rows need an explicit sweep first.
    await prisma.statusTransition.deleteMany({
      where: { entity: "leg", entityId: { in: legs.map((l) => l.id) } },
    });
    await prisma.query.deleteMany({ where: { queryCode: { startsWith: PREFIX } } }); // cascades Leg
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    status = moduleRef.get(StatusService);
    projector = moduleRef.get(QueryStatusProjector);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("fires the forward edge (guard passes) → READY_FOR_RFQ + a StatusTransition row", async () => {
    const { leg } = await makeLeg("forward");
    const id = leg.id;
    const res = await status.fire("leg", id, LegEvent.VALIDATE_PASS, { routeValid: true });
    expect(res.from).toBe(LegStatus.DRAFT); // no prior rows → machine.initial (matches the fresh leg's column)
    expect(res.to).toBe(LegStatus.READY_FOR_RFQ);

    const rows = await prisma.statusTransition.findMany({ where: { entityId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: "DRAFT", to: "READY_FOR_RFQ", event: "validate.pass" });

    // Task 7's seam: fire also persisted the OWNED Leg.status column in the same tx.
    const reloaded = await prisma.leg.findUnique({ where: { id } });
    expect(reloaded?.status).toBe(LegStatus.READY_FOR_RFQ);
  });

  it("blocks the forward edge when the guard fails, carrying Finding[] and persisting nothing", async () => {
    const { leg } = await makeLeg("blocked");
    const id = leg.id;
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
    const { leg } = await makeLeg("default-finding");
    const id = leg.id;
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

  it("blocks with the default Finding when routeValid is false and findings is an empty array", async () => {
    const { leg } = await makeLeg("empty-findings");
    const id = leg.id;
    let err: unknown;
    try {
      await status.fire("leg", id, LegEvent.VALIDATE_PASS, { routeValid: false, findings: [] });
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
    const { leg } = await makeLeg("illegal");
    const id = leg.id;
    await expect(status.fire("leg", id, LegEvent.REOPEN)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    expect(await prisma.statusTransition.count({ where: { entityId: id } })).toBe(0);
  });

  it("drives the reopen reverse edge READY_FOR_RFQ → DRAFT (the seam's status half)", async () => {
    const { leg } = await makeLeg("reopen");
    const id = leg.id;
    await status.fire("leg", id, LegEvent.VALIDATE_PASS, { routeValid: true });
    const res = await status.fire("leg", id, LegEvent.REOPEN);
    expect(res.from).toBe(LegStatus.READY_FOR_RFQ);
    expect(res.to).toBe(LegStatus.DRAFT);
    const latest = await prisma.statusTransition.findFirst({
      where: { entityId: id },
      orderBy: { seq: "desc" },
    });
    expect(latest).toMatchObject({ from: "READY_FOR_RFQ", to: "DRAFT", event: "reopen" });

    // Task 7's seam: the column moved forward AND back.
    const reloaded = await prisma.leg.findUnique({ where: { id } });
    expect(reloaded?.status).toBe(LegStatus.DRAFT);
  });

  it("emits leg.status.changed → QueryStatusProjector.recompute(queryId)", async () => {
    // Task 7: recompute is DB-backed (Task 6) AND fire now writes Leg.status (Task 7), so this
    // needs a real Leg under a real Query — a well-formed-but-nonexistent uuid would no longer
    // stay "pristine": the LOAD would resolve fine (null → DRAFT), but the forward transition's
    // SAVE would 404 (P2025) trying to update a Leg row that isn't there.
    const { query, leg } = await makeLeg("event");
    const spy = jest.spyOn(projector, "recompute");
    await status.fire("leg", leg.id, LegEvent.VALIDATE_PASS, {
      routeValid: true,
      queryId: query.id,
    });
    // EventEmitter2 emit is synchronous → the listener has already invoked recompute.
    expect(spy).toHaveBeenCalledWith(query.id);
    spy.mockRestore();
    // Let the async projector settle before the suite tears down (avoids a recompute racing cleanup).
    await new Promise((r) => setTimeout(r, 50));
  });

  it("projects derived query status from leg statuses (pure projection reused by Plan 4/5)", () => {
    // Plan 5 reconciliation: RFQ_READY is gated on the rfqReady milestone; CREATED now emerges
    // from all-legs-READY_FOR_RFQ without it (previously this was gated on `created`).
    expect(projector.project([LegStatus.READY_FOR_RFQ], { rfqReady: true })).toBe("RFQ_READY");
    expect(projector.project([LegStatus.READY_FOR_RFQ], {})).toBe("CREATED");
    expect(projector.project([LegStatus.DRAFT, LegStatus.READY_FOR_RFQ])).toBe("DRAFT");
  });

  it("register() clones the machine so contribute() cannot mutate the source transitions singleton", () => {
    const sourceLen = legTransitions.length;
    const reg = new StatusRegistry();
    reg.register(legMachine as StatusMachine);
    reg.contribute("leg", [
      { from: LegStatus.READY_FOR_RFQ, on: "rfq.send" as LegEvent, to: LegStatus.RFQ_SENT },
    ]);
    expect(reg.get("leg").transitions.length).toBe(sourceLen + 1); // the registry's own copy grew
    expect(legTransitions.length).toBe(sourceLen); // the module-level source array is untouched
  });
});
