# Stage 4 · Sub-build 6 — Change-Order Cascade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the Stage-3 change-order cascade so an RFQ-defining/Structural edit to a distributed leg previews its blast radius, requires a reason, invalidates the affected quotes, reopens the leg, records a durable `ChangeLog`, and notifies the affected FF(s).

**Architecture:** No Stage-3 behaviour file is edited. SB6 overrides three reserved seams (`ScopeResolver.downstreamWork`, `ChangeOrderStrategy.run`, the `CHANGE_LOG` provider), `contribute()`s leg-reopen + quote-reactivation status edges, extends the impact classifier's scope fan-out, adds one `quotes` impact map, and adds one `ChangeLog` table. The change-order runs as a two-phase interaction (preview → confirm-with-reason) mapped onto the unchanged single-shot `ChangeMediator`.

**Tech Stack:** NestJS 10 + Prisma 5 (Postgres), `@svyft/shared` (isomorphic zod/enums), Jest e2e (`*.e2e-spec.ts`), the SB5 `comms` framework (`NotificationDispatcher` + `MessageTemplate`).

**Design of record:** `docs/Stage 4 - Sub-build 6 - Change-Order Cascade - Design.md` (read it first — every task's *why* lives there; §-refs below point into it).

## Global Constraints

- **Zero Stage-3 behaviour edits.** Only the sanctioned extension points: provider overrides, `StatusRegistry.contribute`, `ImpactRegistry.declare`, and the classifier's scope method. Do **not** edit `leg.machine.ts`, `quote.machine.ts`, `decidePath`, or the state-store.
- **One door for status:** every status change goes through `StatusService.fire`. `fire` owns its own tx and must be called **after** the data `$transaction` commits (it cannot nest — [status.service.ts:40](../../apps/api/src/modules/status/status.service.ts)).
- **P2003 unmapped:** the global `PrismaExceptionFilter` does not map FK violations — guard referenced ids in services.
- **Migrations additive + hand-authored:** `prisma migrate dev` is unusable here (drifts on `CargoItem.volumeCbm` generated column → PG 42601). Hand-author `migration.sql` + `prisma migrate deploy` + `prisma generate`.
- **Shared-enum pattern:** `const` object + union + `Object.values(...) as [X,...X[]]`, pinned by a `toEqual` test. Never a TS `enum`.
- **Lint is verification:** `pnpm run lint` is part of CI `build-test`; no `no-explicit-any`, no unused vars. Run it per task.
- **api has no unit runner:** `pnpm --filter @svyft/api test` runs only `test/*.e2e-spec.ts`. Put unit-style tests there as `*.e2e-spec.ts` (no AppModule boot needed for a pure unit test). Every full-AppModule e2e **must** `await moduleRef.close()` in `afterAll` (the schedule cron keeps the process alive otherwise).
- **CI has no seed:** e2e needing reference data must call `seedReferenceData(prisma)` in `beforeAll`; e2e needing templates must seed the `rfq.leg.reopened` `MessageTemplate` (Task 9).
- **Build shared after any shared edit:** `pnpm --filter @svyft/shared build` (web/api read the built dist).
- **RBAC:** workflow writes stay Executive+ (authenticated, **no** `@Roles`).

---

## File structure

**New files**
- `prisma/migrations/<ts>_add_change_log/migration.sql` — the `ChangeLog` table.
- `apps/api/src/modules/rfq/quote.impact.ts` — the `quotes` impact map.
- `apps/api/src/modules/changes/change-log-policy.ts` — `ChangeLogPolicy` (what to record).
- `apps/api/src/modules/changes/prisma-change-log.ts` — `PrismaChangeLog` (the real sink).
- `apps/api/src/modules/changes/change-order.strategy.spec` tests live in `apps/api/test/change-order.e2e-spec.ts`.
- `apps/api/test/change-order-cascade.e2e-spec.ts` — full-flow e2e.

**Modified files**
- `prisma/schema.prisma` — `ChangeLog` model + `Query.changeLogs` relation.
- `apps/api/src/modules/routing/routing.service.ts` — `legsUsingPoint`, `legsOfQuery`, `legOfQuote` helpers.
- `apps/api/src/modules/changes/impact.classifier.ts` — scope fan-out for point/query/quote.
- `apps/api/src/modules/changes/scope.resolver.ts` — real `downstreamWork`.
- `apps/api/src/modules/changes/change-log.ts` — extend `ChangeLogEntry`.
- `apps/api/src/modules/changes/change-order.strategy.ts` — the saga.
- `apps/api/src/modules/changes/changes.module.ts` — bind `CHANGE_LOG` → `PrismaChangeLog`, provide `ChangeLogPolicy`, import needed modules.
- `apps/api/src/modules/rfq/rfq.module.ts` — `contribute()` reopen + reactivation edges + declare `quoteImpactMap`.
- `apps/api/src/modules/rfq/rfq.service.ts` — reactivate `INVALID` quotes on re-distribute.
- `apps/api/src/modules/{legs,cargo,points,queries}/*.controller.ts` + service — surface the change-order preview as `409`, plumb `reason`.
- `apps/api/src/seed/message-templates.seed.ts` — seed `rfq.leg.reopened`.
- `packages/shared/src/change.ts` — `ChangeOrderPreview` type + `changeType` union.
- `docs/Stage 4 - Technical Design.md` — align §7.1/§7.2 (reopen edges now real; classifier fan-out).

---

## Task 1: `ChangeLog` table + migration

**Files:**
- Modify: `prisma/schema.prisma` (add model + relation)
- Create: `prisma/migrations/<ts>_add_change_log/migration.sql`
- Test: `apps/api/test/change-log.e2e-spec.ts`

**Interfaces — Produces:** the `ChangeLog` Prisma model consumed by `PrismaChangeLog` (Task 6).

- [ ] **Step 1: Add the model to `schema.prisma`** (after `StatusTransition`):

```prisma
model ChangeLog {
  id                String   @id @default(uuid()) @db.Uuid
  tenantId          String?  @db.Uuid
  queryId           String   @db.Uuid
  query             Query    @relation(fields: [queryId], references: [id], onDelete: Cascade)
  entity            String
  entityId          String   @db.Uuid
  changeType        String
  actorId           String?  @db.Uuid
  at                DateTime @default(now())
  auditRefId        String?  @db.Uuid
  approvalRequestId String?  @db.Uuid
  payload           Json
  @@index([queryId])
  @@index([entity, entityId])
}
```

Add to the `Query` model's relations: `changeLogs ChangeLog[]`.

- [ ] **Step 2: Hand-author the migration** `prisma/migrations/<ts>_add_change_log/migration.sql` (use a UTC timestamp folder name, e.g. `20260803120000_add_change_log`):

```sql
CREATE TABLE "ChangeLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "changeType" TEXT NOT NULL,
    "actorId" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auditRefId" UUID,
    "approvalRequestId" UUID,
    "payload" JSONB NOT NULL,
    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ChangeLog_queryId_idx" ON "ChangeLog"("queryId");
CREATE INDEX "ChangeLog_entity_entityId_idx" ON "ChangeLog"("entity", "entityId");
ALTER TABLE "ChangeLog" ADD CONSTRAINT "ChangeLog_queryId_fkey"
    FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply + regenerate**

Run: `pnpm --filter @svyft/api exec prisma migrate deploy && pnpm --filter @svyft/api exec prisma generate`
Expected: migration `add_change_log` applied; client regenerated with `prisma.changeLog`.

- [ ] **Step 4: Write the failing test** `apps/api/test/change-log.e2e-spec.ts` (pure Prisma, self-contained; boots a `PrismaService`):

```ts
import { PrismaService } from "../src/prisma/prisma.service";

describe("ChangeLog table", () => {
  const prisma = new PrismaService();
  let queryId: string;
  beforeAll(async () => {
    await prisma.$connect();
    const q = await prisma.query.create({
      data: { queryCode: `CLG-${Date.now()}`, status: "RFQ_SENT" },
      select: { id: true },
    });
    queryId = q.id;
  });
  afterAll(async () => {
    await prisma.query.delete({ where: { id: queryId } }); // cascades ChangeLog
    await prisma.$disconnect();
  });

  it("persists a change-log row and cascades on query delete", async () => {
    const row = await prisma.changeLog.create({
      data: {
        queryId, entity: "cargo", entityId: queryId, changeType: "change-order",
        payload: { field: "grossWt", from: "1000", to: "1200" },
      },
    });
    expect(row.id).toBeDefined();
    const found = await prisma.changeLog.findMany({ where: { queryId } });
    expect(found).toHaveLength(1);
  });
});
```

> Note: `query.create` above omits required fields for brevity — copy the minimal valid `Query` fixture from `apps/api/test/queries.e2e-spec.ts` (client snapshot fields etc.).

- [ ] **Step 5: Run it** — `pnpm --filter @svyft/api test -- change-log` → PASS. Then `pnpm --filter @svyft/api exec tsc --noEmit` and `pnpm run lint`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(sb6): add ChangeLog table + migration"`

---

## Task 2: Classifier scope fan-out (point/query/quote → legs)

**Files:**
- Modify: `apps/api/src/modules/routing/routing.service.ts`
- Modify: `apps/api/src/modules/changes/impact.classifier.ts`
- Test: `apps/api/test/impact-classifier-scope.e2e-spec.ts`

**Interfaces — Consumes:** `ImpactClassifier.classify(req)` (existing). **Produces:** a classifier whose `scope` is always leg-typed for `cargo`/`leg`/`point`/`query`/`quotes` (so Task 3's `downstreamWork` and Task 7/8's saga receive uniform leg ids). New `RoutingService` methods: `legsUsingPoint(pointId): Promise<string[]>`, `legsOfQuery(queryId): Promise<string[]>`, `legOfQuote(quoteId): Promise<string | null>`.

- [ ] **Step 1: Add the failing test** `apps/api/test/impact-classifier-scope.e2e-spec.ts` — for a `point` edit, scope resolves to the legs using that point (build a Query + 2 Points + 1 Leg fixture; copy the leg fixture helper from `legs.e2e-spec.ts`). Assert `classify({entity:"point", id: pointId, field:"country", queryId}).scope` equals `[{type:"leg", id: legId}]`.

- [ ] **Step 2: Run it** → FAIL (scope is currently `[{type:"point", id}]`).

- [ ] **Step 3: Add the routing helpers** to `routing.service.ts`:

```ts
async legsUsingPoint(pointId: string, client: Db = this.prisma): Promise<string[]> {
  const rows = await client.leg.findMany({
    where: { OR: [{ originPointId: pointId }, { destinationPointId: pointId }] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
async legsOfQuery(queryId: string, client: Db = this.prisma): Promise<string[]> {
  const rows = await client.leg.findMany({ where: { queryId }, select: { id: true } });
  return rows.map((r) => r.id);
}
async legOfQuote(quoteId: string, client: Db = this.prisma): Promise<string | null> {
  const q = await client.quote.findUnique({ where: { id: quoteId }, select: { legId: true } });
  return q?.legId ?? null;
}
```

- [ ] **Step 4: Extend the classifier** — replace the `else` branch in `impact.classifier.ts:29-37` with a switch that fans point/query/quote to legs (cargo unchanged):

```ts
let legIds: string[];
switch (req.entity) {
  case "cargo": legIds = await this.routing.legsCarryingCargo(req.id); break;
  case "point": legIds = await this.routing.legsUsingPoint(req.id); break;
  case "query": legIds = await this.routing.legsOfQuery(req.id); break;
  case "quotes": { const l = await this.routing.legOfQuote(req.id); legIds = l ? [l] : []; break; }
  case "leg": legIds = [req.id]; break;
  default: legIds = [];
}
const scope: FindingScope[] =
  legIds.length > 0
    ? legIds.map((id) => ({ type: "leg", id }))
    : [{ type: req.entity as FindingScope["type"], id: req.id }]; // self-scope fallback (pre-RFQ / unassigned)
return { class: impactClass, scope };
```

- [ ] **Step 5: Run the test** → PASS. Confirm the existing `cargo` classifier tests still pass: `pnpm --filter @svyft/api test -- impact`. Then `tsc --noEmit` + `pnpm run lint`.

- [ ] **Step 6: Commit** — `git commit -am "feat(sb6): classifier fans point/query/quote scope to legs"`

---

## Task 3: `ScopeResolver.downstreamWork` — real predicate

**Files:**
- Modify: `apps/api/src/modules/changes/scope.resolver.ts`
- Modify: `apps/api/src/modules/changes/changes.module.ts` (ScopeResolver now needs `PrismaService` — already available via the module; add if missing)
- Test: `apps/api/test/downstream-work.e2e-spec.ts`

**Interfaces — Produces:** `downstreamWork(scope) => Promise<boolean>` = TRUE iff a `Quote` on a scope-leg is `RFQ_SENT` or `QUOTED`.

- [ ] **Step 1: Failing test** — build Query+Leg+FF+Quote fixtures; assert `downstreamWork([{type:"leg", id: legId}])` is `true` when a `RFQ_SENT` quote exists on the leg, `false` when only `SELECT`/`EXPIRED`/`INVALID` exist, and `false` for a non-leg scope.

- [ ] **Step 2: Run it** → FAIL (returns hardcoded `false`).

- [ ] **Step 3: Implement**:

```ts
import { Injectable } from "@nestjs/common";
import { QuoteStatus, type FindingScope } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class ScopeResolver {
  constructor(private readonly prisma: PrismaService) {}
  async downstreamWork(scope: FindingScope[]): Promise<boolean> {
    const legIds = scope.filter((s) => s.type === "leg").map((s) => s.id);
    if (legIds.length === 0) return false;
    const live = await this.prisma.quote.count({
      where: { legId: { in: legIds }, status: { in: [QuoteStatus.RFQ_SENT, QuoteStatus.QUOTED] } },
    });
    return live > 0;
  }
}
```

- [ ] **Step 4: Run** → PASS. `tsc --noEmit` + `pnpm run lint`.

- [ ] **Step 5: Verify the whole free path still works** — `pnpm --filter @svyft/api test -- change-mediator` (the Stage-3 free-path e2e must stay green; pre-RFQ edits still route free because no live quotes).

- [ ] **Step 6: Commit** — `git commit -am "feat(sb6): ScopeResolver.downstreamWork detects live quotes"`

---

## Task 4: `quotes` impact map

**Files:**
- Create: `apps/api/src/modules/rfq/quote.impact.ts`
- Modify: `apps/api/src/modules/rfq/rfq.module.ts` (declare it)
- Test: `apps/api/test/quote-impact.e2e-spec.ts`

**Interfaces — Produces:** `quoteImpactMap` declared for entity `"quotes"`, so `@delete` classifies as `Structural`, `@create` as free.

- [ ] **Step 1: Failing test** — assert `impactRegistry.classOf("quotes", "@delete") === ImpactClass.Structural` and `classOf("quotes", "@create") === ImpactClass.Corrective`. *(Why Corrective not a lower class for `@create`: adding an FF is a new distribution that invalidates nothing → below the RfqDefining fork threshold → free path. Any class < RfqDefining works; Corrective is the honest label.)*

- [ ] **Step 2: Create the map** `quote.impact.ts`:

```ts
import { ImpactClass } from "@svyft/shared";

// Quote (Forwarder-selection) impact classes (Design §4). @delete (remove an FF from a sent
// leg) = Structural (change-order — voids that FF's quote). @create (add an FF) = a new
// distribution that invalidates nothing → below the fork threshold (free). The FF's own
// price/density/transit are edited in the FF portal, NEVER through the mediator, so they are
// free by construction and are not listed here.
export const quoteImpactMap: Record<"@create" | "@delete", ImpactClass> = {
  "@create": ImpactClass.Corrective,
  "@delete": ImpactClass.Structural,
};
```

- [ ] **Step 3: Declare it** in `rfq.module.ts` `onModuleInit` (the module already injects `ImpactRegistry`? if not, add it): `this.impacts.declare("quotes", quoteImpactMap);`

- [ ] **Step 4: Run** → PASS. `tsc --noEmit` + `pnpm run lint`.

- [ ] **Step 5: Commit** — `git commit -am "feat(sb6): declare quotes impact map"`

---

## Task 5: Status edges — leg REOPEN + quote reactivation

**Files:**
- Modify: `apps/api/src/modules/rfq/rfq.module.ts` (`contribute` in `onModuleInit`)
- Test: `apps/api/test/sb6-status-edges.e2e-spec.ts`

**Interfaces — Produces:** the leg machine accepts `REOPEN` from `RFQ_SENT`/`PARTIALLY_QUOTED`/`FULLY_QUOTED` → `READY_FOR_RFQ`; the quote machine accepts `SEND` from `INVALID` → `RFQ_SENT`.

- [ ] **Step 1: Failing test** — create a Query+Leg fixture, `fire('leg', legId, LegEvent.SEND_RFQ)` to `RFQ_SENT`, then `fire('leg', legId, LegEvent.REOPEN)` and assert the leg is `READY_FOR_RFQ`. Create a Quote at `QUOTED`, `fire('quote', qId, QuoteEvent.INVALIDATE)` → `INVALID`, then `fire('quote', qId, QuoteEvent.SEND)` and assert `RFQ_SENT`.

- [ ] **Step 2: Run it** → FAIL (`IllegalTransitionError` — edges absent).

- [ ] **Step 3: Contribute the edges** in `rfq.module.ts` `onModuleInit` (alongside the existing leg-forward `contribute`):

```ts
this.registry.contribute("leg", [
  { from: LegStatus.RFQ_SENT, on: LegEvent.REOPEN, to: LegStatus.READY_FOR_RFQ, kind: "reopen" },
  { from: LegStatus.PARTIALLY_QUOTED, on: LegEvent.REOPEN, to: LegStatus.READY_FOR_RFQ, kind: "reopen" },
  { from: LegStatus.FULLY_QUOTED, on: LegEvent.REOPEN, to: LegStatus.READY_FOR_RFQ, kind: "reopen" },
]);
this.registry.contribute("quote", [
  { from: QuoteStatus.INVALID, on: QuoteEvent.SEND, to: QuoteStatus.RFQ_SENT, kind: "forward" },
]);
```

*(`LegEvent.REOPEN`, `QuoteEvent.SEND`, `QuoteEvent.INVALIDATE` all already exist in `@svyft/shared` — verified. No machine file is edited; `findTransition` matches on `(from, event)` so the same `REOPEN`/`SEND` event carries multiple edges.)*

- [ ] **Step 4: Run** → PASS. `tsc --noEmit` + `pnpm run lint`.

- [ ] **Step 5: Commit** — `git commit -am "feat(sb6): contribute leg-reopen + quote-reactivation status edges"`

---

## Task 6: `PrismaChangeLog` + `ChangeLogPolicy` + wire the sink

**Files:**
- Modify: `apps/api/src/modules/changes/change-log.ts` (extend `ChangeLogEntry`)
- Create: `apps/api/src/modules/changes/prisma-change-log.ts`
- Create: `apps/api/src/modules/changes/change-log-policy.ts`
- Modify: `apps/api/src/modules/changes/changes.module.ts`
- Test: `apps/api/test/prisma-change-log.e2e-spec.ts`

**Interfaces — Produces:** `CHANGE_LOG` now resolves to `PrismaChangeLog`; `ChangeLogEntry` gains `queryId`, `changeType`, `payload`. `ChangeLogPolicy.shouldRecord(path)` → boolean.

- [ ] **Step 1: Extend `ChangeLogEntry`** in `change-log.ts`:

```ts
export interface ChangeLogEntry {
  queryId: string;
  entity: string;
  entityId: string;
  changeType: string;      // "change-order"
  actorId?: string | null;
  payload: Record<string, unknown>;
}
```

- [ ] **Step 2: `ChangeLogPolicy`** `change-log-policy.ts` (change-order only for now; expandable later — Design §10):

```ts
import { Injectable } from "@nestjs/common";
import type { ImpactPath } from "@svyft/shared";

@Injectable()
export class ChangeLogPolicy {
  shouldRecord(path: ImpactPath): boolean {
    return path === "change-order";
  }
}
```

- [ ] **Step 3: `PrismaChangeLog`** `prisma-change-log.ts`:

```ts
import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { ChangeLog, ChangeLogEntry } from "./change-log";

@Injectable()
export class PrismaChangeLog implements ChangeLog {
  constructor(private readonly prisma: PrismaService) {}
  async record(entry: ChangeLogEntry): Promise<void> {
    await this.prisma.changeLog.create({
      data: {
        queryId: entry.queryId,
        entity: entry.entity,
        entityId: entry.entityId,
        changeType: entry.changeType,
        actorId: entry.actorId ?? null,
        payload: entry.payload as Prisma.InputJsonValue,
      },
    });
  }
}
```

- [ ] **Step 4: Wire in `changes.module.ts`** — `provide: CHANGE_LOG, useClass: PrismaChangeLog` (replace `NoopChangeLog`), add `ChangeLogPolicy` to providers + exports.

- [ ] **Step 5: Failing test → impl → PASS** — `prisma-change-log.e2e-spec.ts`: `record({...})` inserts a `ChangeLog` row (self-contained Query fixture, cascade cleanup). `ChangeLogPolicy` returns `true` for `"change-order"`, `false` for `"free"`.

- [ ] **Step 6: Verify the free path did NOT start logging** — the `FreePathStrategy` still calls `changeLog.record`, so guard it: in `free-path.strategy.ts` wrap the `record` call in `if (this.policy.shouldRecord(decision.path))` (inject `ChangeLogPolicy`). Add a test: a free-path apply writes **no** `ChangeLog` row. *(This is the one FreePathStrategy edit — it is Stage-3 infra, not behaviour; it prevents the real sink from logging every free edit.)*

- [ ] **Step 7: `tsc --noEmit` + `pnpm run lint` + commit** — `git commit -am "feat(sb6): PrismaChangeLog sink + change-order-only policy"`

---

## Task 7: `ChangeOrderStrategy` — preview phase

**Files:**
- Modify: `packages/shared/src/change.ts` (add `ChangeOrderPreview` + `ChangeResult` preview shape)
- Modify: `apps/api/src/modules/changes/change-order.strategy.ts`
- Test: `apps/api/test/change-order-preview.e2e-spec.ts`

**Interfaces — Produces:** when `req.reason` is absent, `ChangeOrderStrategy.run` returns `{ path:"change-order", needsConfirmation:true, preview }` and writes nothing. `ChangeOrderPreview = { affectedLegs: string[]; invalidatingQuotes: {quoteId; freightForwarderId}[]; refreshingQuotes: {quoteId; freightForwarderId}[]; impactClass: ImpactClass }`.

- [ ] **Step 1: Add shared types** in `change.ts`:

```ts
export interface ChangeOrderPreview {
  affectedLegs: string[];
  invalidatingQuotes: { quoteId: string; freightForwarderId: string }[];
  refreshingQuotes: { quoteId: string; freightForwarderId: string }[];
  impactClass: ImpactClass;
}
```

Extend `ChangeResult` (in `free-path.strategy.ts`) with optional `needsConfirmation?: boolean` and `preview?: ChangeOrderPreview`. Build `@svyft/shared`.

- [ ] **Step 2: Failing test** — a change-order request **without** `reason` returns `needsConfirmation:true` + a preview naming the `QUOTED` quote in `invalidatingQuotes` and the `RFQ_SENT` quote in `refreshingQuotes`, and asserts the edited field was **NOT** written (read the row back — unchanged).

- [ ] **Step 3: Implement the preview branch** in `change-order.strategy.ts` (inject `PrismaService`):

```ts
async run(req: ChangeRequest, decision: ImpactDecision, uow: UnitOfWork): Promise<ChangeResult> {
  const legIds = decision.scope.filter((s) => s.type === "leg").map((s) => s.id);
  const quotes = await this.prisma.quote.findMany({
    where: { legId: { in: legIds }, status: { in: [QuoteStatus.RFQ_SENT, QuoteStatus.QUOTED] } },
    select: { id: true, freightForwarderId: true, status: true },
  });
  const invalidating = quotes.filter((q) => q.status === QuoteStatus.QUOTED)
    .map((q) => ({ quoteId: q.id, freightForwarderId: q.freightForwarderId }));
  const refreshing = quotes.filter((q) => q.status === QuoteStatus.RFQ_SENT)
    .map((q) => ({ quoteId: q.id, freightForwarderId: q.freightForwarderId }));

  if (!req.reason) {
    return {
      path: "change-order", class: decision.class, scope: decision.scope, findings: [],
      needsConfirmation: true,
      preview: { affectedLegs: legIds, invalidatingQuotes: invalidating, refreshingQuotes: refreshing, impactClass: decision.class },
    };
  }
  // apply branch → Task 8
  return this.apply(req, decision, uow, invalidating, refreshing);
}
```

- [ ] **Step 4: Stub `apply`** to `throw new Error("apply not implemented")` for now so the file compiles; Task 8 fills it.

- [ ] **Step 5: Run** → PASS (preview test). `tsc --noEmit` + `pnpm run lint`.

- [ ] **Step 6: Commit** — `git commit -am "feat(sb6): change-order preview (no write without reason)"`

---

## Task 8: `ChangeOrderStrategy` — apply phase (the saga)

**Files:**
- Modify: `apps/api/src/modules/changes/change-order.strategy.ts`
- Modify: `apps/api/src/modules/changes/changes.module.ts` (inject `StatusService`, `RfqNotificationsService` from Task 9, manifest builder)
- Test: `apps/api/test/change-order-apply.e2e-spec.ts`

**Interfaces — Consumes:** `buildManifestSnapshot` (`rfq/manifest.ts`), `loadLegForRfq` (`rfq/leg-context.ts`), `StatusService.fire`, `PrismaChangeLog`, the Task 9 notifier. **Produces:** on confirm, applies the edit + refreshes pending manifests + snapshots invalidated pricing + writes `ChangeLog` (one tx), then fires `INVALIDATE`/`REOPEN`, then notifies.

- [ ] **Step 1: Failing test** (the core cascade) — Query+Leg(distributed)+FF-A(`QUOTED` w/ pricing)+FF-B(`RFQ_SENT`); apply a cargo `grossWt` change-order **with** `reason`. Assert: FF-A `INVALID`; FF-B `manifestSnapshot` reflects the new weight; leg `READY_FOR_RFQ`; a `ChangeLog` row with `payload.reason`, `payload.invalidatedQuotes[0].grandTotal`; FF-A's `QuoteCargoLine` rows still exist (kept).

- [ ] **Step 2: Implement `apply`**:

```ts
private async apply(
  req: ChangeRequest, decision: ImpactDecision, uow: UnitOfWork,
  invalidating: { quoteId: string; freightForwarderId: string }[],
  refreshing: { quoteId: string; freightForwarderId: string }[],
): Promise<ChangeResult> {
  const legIds = decision.scope.filter((s) => s.type === "leg").map((s) => s.id);

  // snapshot invalidated pricing BEFORE anything changes (for the ChangeLog history)
  const invalidatedSnaps = await this.prisma.quote.findMany({
    where: { id: { in: invalidating.map((q) => q.quoteId) } },
    select: { id: true, freightForwarderId: true, grandTotal: true, totalChargeableWeightT: true,
              rfq: { select: { currency: true } } },
  });

  await this.prisma.$transaction(async (tx) => {
    await uow(tx);                                   // apply the field edit
    for (const legId of legIds) {                    // re-freeze PENDING manifests from new data
      const ctx = await loadLegForRfq(tx, legId, req.queryId!);
      const query = await tx.query.findUnique({ where: { id: req.queryId! }, select: { incoterms: true } });
      const snap = buildManifestSnapshot(ctx, query!, new Date());
      await tx.quote.updateMany({
        where: { legId, id: { in: refreshing.map((q) => q.quoteId) } },
        data: { manifestSnapshot: snap as unknown as Prisma.InputJsonValue },
      });
    }
    await this.changeLog.record({
      queryId: req.queryId!, entity: req.entity, entityId: req.id,
      changeType: "change-order", actorId: req.actorId,
      payload: {
        field: req.field ?? null, action: req.action ?? null, impactClass: decision.class,
        reason: req.reason, affectedScope: decision.scope,
        invalidatedQuotes: invalidatedSnaps.map((q) => ({
          quoteId: q.id, freightForwarderId: q.freightForwarderId,
          grandTotal: q.grandTotal?.toString() ?? null,
          totalChargeableWeightT: q.totalChargeableWeightT?.toString() ?? null,
          currency: q.rfq?.currency ?? null,
        })),
        refreshedQuotes: refreshing,
      },
    });
  });

  for (const q of invalidating) await this.status.fire("quote", q.quoteId, QuoteEvent.INVALIDATE, { queryId: req.queryId, actorId: req.actorId });
  for (const legId of legIds) await this.status.fire("leg", legId, LegEvent.REOPEN, { queryId: req.queryId, actorId: req.actorId });

  await this.notifier.legReopened(req.queryId!, legIds, invalidating.map((q) => q.freightForwarderId), req.reason ?? "");
  return { path: "change-order", class: decision.class, scope: decision.scope, findings: [] };
}
```

- [ ] **Step 3: Run** → PASS. Add edge tests: query-wide `incoterms` reopens all legs; a Corrective post-RFQ edit stays free (never enters this strategy).

- [ ] **Step 4: `tsc --noEmit` + `pnpm run lint` + commit** — `git commit -am "feat(sb6): change-order apply saga (invalidate/refresh/reopen/record)"`

---

## Task 9: `rfq.leg.reopened` notification

**Files:**
- Create: `apps/api/src/modules/rfq/rfq-notifications.service.ts` (thin wrapper over `NotificationDispatcher`)
- Modify: `apps/api/src/seed/message-templates.seed.ts`
- Test: `apps/api/test/rfq-reopen-notification.e2e-spec.ts`

**Interfaces — Produces:** `RfqNotificationsService.legReopened(queryId, legIds, ffIds, reason)` → dispatches `"rfq.leg.reopened"` (EMAIL to each invalidated FF's primary contact, IN_APP to the query's Executive).

- [ ] **Step 1: Seed the template** — add to `message-templates.seed.ts` an EMAIL + IN_APP `MessageTemplate` with `eventKey:"rfq.leg.reopened"`, tokens `{{rfqNumber}} {{legCode}} {{origin}} {{destination}} {{reason}}`.

- [ ] **Step 2: Failing test** — call `legReopened(...)` for a leg with an invalidated FF; assert a `MessageLog` row (`eventKey:"rfq.leg.reopened"`, `toAddress` = the FF contact) and a `Notification` for the Executive.

- [ ] **Step 3: Implement** the service — look up the FFs' primary contact emails + the query's `assignedUserId`, resolve `rfqNumber`/`legCode`/endpoints, call `dispatcher.dispatch("rfq.leg.reopened", { scope:{entityType:"QUERY", entityId:queryId}, tokens, recipients:{ EMAIL: ffEmails, IN_APP: [execId] } })`.

- [ ] **Step 4: Run → PASS. `tsc` + lint. Commit** — `git commit -am "feat(sb6): rfq.leg.reopened compose-&-log notification"`

---

## Task 10: Surface the preview as `409` + plumb `reason`

**Files:**
- Modify: the `legs`/`cargo`/`points`/`queries` services + controllers (mediated PATCH sites)
- Modify: shared PATCH schemas to accept optional `reason`
- Test: `apps/api/test/change-order-http.e2e-spec.ts`

**Interfaces — Produces:** a mediated PATCH that resolves to a change-order **without** `reason` returns HTTP `409 { message, needsChangeOrder:true, preview }`; **with** `reason` it applies (returns the normal shape).

- [ ] **Step 1: Failing test** — PATCH a distributed leg's `mode` without `reason` → `409` with `preview`; repeat with `reason` → `200` and the mediator applied + FF invalidated.

- [ ] **Step 2: Implement** — in each mediated service method, inspect the `ChangeResult`: if `result.needsConfirmation`, throw `new ConflictException({ message: "Change requires confirmation", needsChangeOrder: true, preview: result.preview })`. Add optional `reason` to the mediated `ChangeRequest` from the request body (add `reason?: string` to the PATCH zod schemas in `@svyft/shared`; build shared).

- [ ] **Step 3: Run → PASS. `tsc` + lint. Commit** — `git commit -am "feat(sb6): 409 change-order preview + reason plumbing"`

---

## Task 11: Re-distribute reactivates `INVALID` quotes

**Files:**
- Modify: `apps/api/src/modules/rfq/rfq.service.ts` (`performDistribution` / `distributeLeg`)
- Modify: `apps/api/src/modules/rfq/leg-context.ts` (include `INVALID` in the redistributable set)
- Test: `apps/api/test/redistribute-reactivate.e2e-spec.ts`

**Interfaces — Produces:** distributing a reopened leg fires `SEND` on its `INVALID` quotes (`INVALID→RFQ_SENT`), re-freezes their manifest, resets the deadline.

- [ ] **Step 1: Failing test** — a leg with one `INVALID` quote (post-change-order) is re-distributed → that quote returns to `RFQ_SENT`, `manifestSnapshot` refreshed, `Rfq.submissionDeadline` reset; a new `MessageLog` invitation is composed.

- [ ] **Step 2: Implement** — extend the distribution to treat `INVALID` quotes on a `READY_FOR_RFQ` leg as re-sendable: fire `QuoteEvent.SEND` (the Task 5 edge), rebuild the manifest, reset deadline via the existing `resolveDeadline`. Reuse `performDistribution`'s grouping.

- [ ] **Step 3: Run → PASS. `tsc` + lint. Commit** — `git commit -am "feat(sb6): re-distribute reactivates INVALID quotes"`

---

## Task 12: Remove-FF (`quotes.@delete`) mediated change-order

**Files:**
- Modify: `apps/api/src/modules/rfq/rfq.service.ts` + controller (a mediated remove-FF path)
- Test: `apps/api/test/remove-ff-change-order.e2e-spec.ts`

**Interfaces — Produces:** removing an FF from a sent leg routes through the mediator as `{entity:"quotes", action:"@delete", id:quoteId}` → Structural → change-order (preview/confirm) → the FF's quote `INVALID`, leg coverage recomputed, `ChangeLog` written, FF notified "RFQ withdrawn".

- [ ] **Step 1: Failing test** — remove FF-A (whose quote is `QUOTED`) from a leg without reason → `409`; with reason → FF-A `INVALID` (row **not** deleted — assert it still exists), leg stays `RFQ_SENT` if another FF remains, `ChangeLog` row present.

- [ ] **Step 2: Implement** — a `removeFf(queryId, legId, ffId, reason?, user)` that builds the mediated `@delete` request; the `uow` marks intent (no row delete — the invalidation is via `fire`); reuse the strategy. Add a `MessageTemplate` `"rfq.withdrawn"` (or reuse `rfq.leg.reopened` with a variant token).

- [ ] **Step 3: Run → PASS. `tsc` + lint. Commit** — `git commit -am "feat(sb6): remove-FF structural change-order"`

---

## Task 13: Full-flow e2e + docs alignment

**Files:**
- Create: `apps/api/test/change-order-cascade.e2e-spec.ts`
- Modify: `docs/Stage 4 - Technical Design.md` (§7.1 reopen edges now real; §7.2 classifier fan-out)

**Interfaces — Consumes:** everything above.

- [ ] **Step 1: End-to-end scenario test** (boots `AppModule`, `await moduleRef.close()` in `afterAll`, `seedReferenceData` + seed templates in `beforeAll`): create query → build legs/cargo → distribute L1 to two FFs → one submits → PATCH C1 grossWt (409 preview) → PATCH with reason (cascade) → assert statuses + ChangeLog + MessageLog → re-distribute (reactivation) → assert `RFQ_SENT` + deadline reset. Assert **minimal blast radius**: a sibling distributed leg L2 is untouched.

- [ ] **Step 2: Run the full api suite** — `pnpm --filter @svyft/api test` → all green (no hang → confirm teardown). `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web typecheck`.

- [ ] **Step 3: Align the TD** — one paragraph each: §7.1 "reopen edges are contributed by SB6 (were absent)"; §7.2 "the classifier fans point/query/quote → legs."

- [ ] **Step 4: Full gate + commit** — `pnpm run lint && pnpm run ci` (or the api/shared/web equivalents) green. `git commit -am "test(sb6): full change-order cascade e2e + TD alignment"`

---

## Self-review

**Spec coverage (Design §-by-§):** §3 seams → Tasks 3,6,7,8; §4 impact maps → Task 4 (+ existing maps re-confirmed in Task 13 review); §5 scope fan-out + downstream → Tasks 2,3; §7 saga → Tasks 7,8; §8 status edges → Task 5; §10 generic ChangeLog → Tasks 1,6; §11 in-payload snapshot → Task 8; §14 409 + reason → Task 10; §15 notify → Task 9; re-distribute reactivation → Task 11; remove-FF → Task 12. **Covered.**

**Placeholder scan:** the `Query` fixture in Task 1 references "copy the minimal valid fixture" — acceptable (points to a concrete source file); no `TODO`/`handle edge cases`/`add validation`. Code steps carry real code.

**Type consistency:** `ChangeLogEntry` (Task 6) fields match `PrismaChangeLog.record` (Task 6) and the strategy's `changeLog.record` call (Task 8). `ChangeOrderPreview` (Task 7) matches the `409` body (Task 10). `downstreamWork` leg-typed scope (Task 3) matches the classifier output (Task 2). Status events (`LegEvent.REOPEN`, `QuoteEvent.SEND/INVALIDATE`) match Task 5 edges + Task 8/11 fires.

**Open risks flagged for the implementer:** (a) the `Query`/`Leg`/`Quote` fixtures are verbose — reuse `queries.e2e-spec.ts`/`legs.e2e-spec.ts`/`rfq.e2e-spec.ts` helpers, don't hand-roll; (b) `buildManifestSnapshot` needs the full `LegRfqContext` include — reuse `loadLegForRfq`; (c) watch the split-tx window (Design §7) — fires are after the data tx by design.
