process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { Test, type TestingModule } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ChangeMediator } from "../src/modules/changes/change-mediator";
import { CHANGE_LOG, type ChangeLog } from "../src/modules/changes/change-log";
import { ChangeLogPolicy } from "../src/modules/changes/change-log-policy";

const PFX = "p6-prisma-change-log-";

describe("PrismaChangeLog + ChangeLogPolicy (integration)", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let changeLog: ChangeLog;
  let policy: ChangeLogPolicy;
  let mediator: ChangeMediator;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    changeLog = moduleRef.get(CHANGE_LOG);
    policy = moduleRef.get(ChangeLogPolicy);
    mediator = moduleRef.get(ChangeMediator);
  });

  afterAll(async () => {
    // ChangeLog.queryId is ON DELETE CASCADE (see change-log.e2e-spec.ts) — deleting the
    // fixture Query rows is enough to clean up any ChangeLog rows they own.
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await moduleRef.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  async function createQuery(suffix: string) {
    const q = await prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}-${suffix}`, shipmentDescription: `${PFX}q` },
    });
    return q.id;
  }

  describe("ChangeLogPolicy.shouldRecord", () => {
    it("records only the change-order path", () => {
      expect(policy.shouldRecord("change-order")).toBe(true);
      expect(policy.shouldRecord("free")).toBe(false);
    });
  });

  describe("PrismaChangeLog.record", () => {
    it("inserts a ChangeLog row from the new ChangeLogEntry shape", async () => {
      const queryId = await createQuery("record");

      await changeLog.record({
        queryId,
        entity: "cargo",
        entityId: queryId, // any real uuid does — no FK on entityId itself
        changeType: "change-order",
        actorId: null,
        payload: { field: "grossWt", from: 1000, to: 1200 },
      });

      const rows = await prisma.changeLog.findMany({ where: { queryId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entity: "cargo",
        entityId: queryId,
        changeType: "change-order",
        actorId: null,
      });
      expect(rows[0].payload).toEqual({ field: "grossWt", from: 1000, to: 1200 });
    });
  });

  describe("Free path never logs (§7.7 — durable log is change-order-only)", () => {
    // Real Query + CargoItem, mediated through the actual ChangeMediator → FreePathStrategy →
    // ChangeLogPolicy → CHANGE_LOG sink — nothing mocked. Pre-RFQ, cargo isn't on any leg, so
    // ScopeResolver.downstreamWork is false and the edit is guaranteed FREE (same fixture shape
    // as change-mediator.e2e-spec.ts's createCargoRow / "keeps a cargo edit self-scoped" case).
    // grossWt moved off Cargo onto Package (RfqDefining there) in the Stage-3 re-model — Cargo
    // is now a Corrective-only grouping row (poReference/label/dimUnit/weightUnit), same field
    // swap change-mediator.e2e-spec.ts's cargo-entity tests already made (Task 22). The point of
    // this test — a mediated pre-RFQ edit with no downstream leg/quotes resolves FREE and
    // PrismaChangeLog never fires — doesn't depend on which Corrective field is edited.
    it("writes zero ChangeLog rows for a mediated pre-RFQ cargo edit", async () => {
      const queryId = await createQuery("free-guard");
      const cargo = await prisma.cargo.create({
        data: { queryId, rowIndex: 0, poReference: "PO-1" },
      });

      const res = await mediator.apply(
        {
          entity: "cargo",
          id: cargo.id,
          field: "poReference",
          patch: { poReference: "PO-2" },
          queryId,
          actorId: null,
        },
        async (tx) => {
          await tx.cargo.update({ where: { id: cargo.id }, data: { poReference: "PO-2" } });
        },
      );

      expect(res.path).toBe("free"); // confirms the guard's branch was actually exercised
      const rows = await prisma.changeLog.findMany({ where: { queryId } });
      expect(rows).toEqual([]);
    });
  });
});
