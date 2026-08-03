import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Injectable } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ScheduledEventService } from "../src/modules/comms/scheduled-event.service";
import { randomUUID } from "crypto";

@Injectable()
class Sink {
  hits: { entityId: string; tier: string }[] = [];
  @OnEvent("test.timer")
  onFire(p: { entityId: string; tier: string }): void {
    this.hits.push({ entityId: p.entityId, tier: p.tier });
  }
}

describe("ScheduledEventService (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let svc: ScheduledEventService;
  let sink: Sink;
  const entityId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], providers: [Sink] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    svc = app.get(ScheduledEventService);
    sink = app.get(Sink);
  });

  afterAll(async () => {
    await prisma.scheduledEvent.deleteMany({ where: { entityId } });
    await app.close();
  });

  it("schedule() skips past-due tiers", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await svc.schedule("RFQ", entityId, "test.timer", [
      { tier: "PAST", dueAt: new Date("2025-12-31T23:00:00Z") },
      { tier: "FUTURE", dueAt: new Date("2026-01-02T00:00:00Z") },
    ], { now });
    const rows = await prisma.scheduledEvent.findMany({ where: { entityId }, orderBy: { tier: "asc" } });
    expect(rows.map((r) => r.tier)).toEqual(["FUTURE"]);
  });

  it("runDue() fires due+unfired once and is idempotent", async () => {
    await svc.runDue(new Date("2026-01-03T00:00:00Z"));
    expect(sink.hits.filter((h) => h.entityId === entityId)).toEqual([{ entityId, tier: "FUTURE" }]);
    await svc.runDue(new Date("2026-01-03T00:00:00Z")); // no re-fire
    expect(sink.hits.filter((h) => h.entityId === entityId).length).toBe(1);
    const fired = await prisma.scheduledEvent.count({ where: { entityId, firedAt: { not: null } } });
    expect(fired).toBe(1);
  });

  it("cancel() stops unfired timers", async () => {
    const e2 = randomUUID();
    await svc.schedule("RFQ", e2, "test.timer", [{ tier: "T1", dueAt: new Date("2999-01-01T00:00:00Z") }]);
    await svc.cancel("RFQ", e2, "test.timer");
    await svc.runDue(new Date("2999-02-01T00:00:00Z"));
    expect(await prisma.scheduledEvent.count({ where: { entityId: e2, firedAt: { not: null } } })).toBe(0);
    await prisma.scheduledEvent.deleteMany({ where: { entityId: e2 } });
  });
});
