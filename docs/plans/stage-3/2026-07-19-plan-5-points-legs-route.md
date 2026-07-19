# Plan 5 — Points/Legs/Route Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the reusable `Point` graph + `Leg`/`LegCargo` entities, the isomorphic pure `validateRoute` engine (full functional-spec §10 catalogue), and full route-gated Create Query — wiring the six reserved Plan-3/4 seams so a query's legs drive its status and every edit re-validates the route.

**Architecture:** Three new NestJS modules (`points`, `legs`, `routing`) mirror the Plan-4 `queries`/`cargo` template. `RoutingService` assembles the query graph by reading Prisma directly (so `RoutingModule → Prisma only`, breaking a `Legs→Changes→Routing→Legs` cycle) and runs the shared `validateRoute(graph, phase)` engine from `@svyft/shared`. Point and leg mutations flow through the existing `ChangeMediator` (Free path → route revalidation); leg status flows through `StatusService.fire` with a new column-backed state store; query status is projected from real leg statuses. Create Query runs the full catalogue and, on pass, fires each leg to `READY_FOR_RFQ` which rolls up to `RFQ_READY`.

**Tech Stack:** pnpm monorepo · NestJS 10 + Prisma 5 (Postgres) · `@svyft/shared` (isomorphic Zod + pure logic) · Jest e2e (`*.e2e-spec.ts`) + Vitest (shared). TypeScript throughout.

## Global Constraints

*(Every task's requirements implicitly include this section. Copy the binding items into each reviewer's attention lens.)*

- **Zod binding:** validate at **param level** — `@Body(new ZodValidationPipe(schema)) body: T`. NEVER method-level `@UsePipes`. There is no global ValidationPipe. Global prefix is `api` (all routes `/api/...`).
- **Prisma errors:** the global `PrismaExceptionFilter` maps `P2025→404`, `P2023→400`, `P2002→409`. **`P2003` (FK violation) is NOT mapped** (→500) → services MUST pre-verify referenced ids (point ids, `assignedCargoIds`, `queryId`) and throw `BadRequestException`, mirroring `QueriesService.assertRefsExist`.
- **Shared enums:** `const`-object + `export type X = (typeof X)[keyof typeof X]` union + companion `export const X_VALUES = Object.values(X) as [X, ...X[]]`, **pinned by a `toEqual` test**. Values match the Prisma enum EXACTLY. NEVER a TS `enum`.
- **Impact maps:** type each as `Record<keyof …Input | "@create" | "@delete", ImpactClass>` for **compile-time completeness** (like `queryImpactMap`/`cargoImpactMap`). Declared in the owning module's `onModuleInit` via `ImpactRegistry.declare(entity, map)`.
- **Status:** never hand-write a status. Owned leg status → `StatusService.fire("leg", legId, event, ctx)`. Derived query status → `QueryStatusProjector.recompute`. Never raw-write a user-editable field → route through `ChangeMediator.apply(req, uow)`.
- **Schema conventions:** every table has `id String @id @default(uuid()) @db.Uuid`, nullable `tenantId String? @db.Uuid` + `@@index([tenantId])`, `createdAt DateTime @default(now())` + `updatedAt DateTime @updatedAt`. Soft user refs = nullable `@db.Uuid`, NO relation. Real FKs get relations.
- **Env timing:** read env inside methods, not top-level consts.
- **Tests:** CI DB is **migrated-but-UNSEEDED**. Every spec seed-independent (`seedReferenceData` + own rows) + self-cleaning by a unique per-file prefix (`deleteMany({ where: { <field>: { startsWith: PFX } } })` in `beforeAll` AND `afterAll`). JWT `sub` MUST be a UUID (lands in `@db.Uuid actorId`). `@svyft/shared` resolves to TS source in API jest (`moduleNameMapper`) — no rebuild needed.
- **Verification:** before pushing, run `pnpm --filter @svyft/api exec prisma migrate reset --schema ../../prisma/schema.prisma --force --skip-seed` then `pnpm run ci` (lint + typecheck + test + build), then `gh run watch`. Prisma CLI needs env first: `set -a; . apps/api/.env; set +a` (local Postgres `:5433`; CI `:5432`).
- **Scope boundaries (do NOT build):** wizard/route-diagram UI = Plan 6; notifications/escalations/emails = Plan 7; freight-density/chargeable-weight compute, the `manifestSnapshot` RFQ freeze, and the ChangeOrder cascade = Stage 4+. Leave `NoopChangeLog` and the `ChangeOrderStrategy` throw UNTOUCHED. `ScopeResolver.downstreamWork` stays `≡ false`.

---

## File Structure

**`packages/shared/src/`** (isomorphic; consumed by both apps)
- Create `points.ts` — `PointType`, `WAREHOUSE_TYPES`, `pointSaveSchema`, `PointSaveInput`, `POINT_REQUIRED_FIELDS`.
- Create `legs.ts` — `LegExecutionStatus`, `legSaveSchema`, `LegSaveInput`, `formatLegCode`.
- Create `route.ts` — `RouteGraph`/`RoutePoint`/`RouteLeg`/`RouteCargo` types, `RoutePhase`, pure `validateRoute`, `checkModeEndpoints` helper.
- Modify `status.ts` — reconcile `deriveQueryStatus` (consistent `rfqReady` gate; emergent `CREATED`; `DELIVERED→CLOSED`).
- Modify `index.ts` — export `./points`, `./legs`, `./route`.
- Modify `status.test.ts` — update the `READY_FOR_RFQ` milestone-gate expectation.

**`prisma/`**
- Modify `schema.prisma` — add enums `PointType`, `LegStatus`, `LegExecutionStatus`; models `Point`, `Leg`, `LegCargo`; `Query` back-relations `points`/`legs`.
- Create `prisma/migrations/<ts>_points_legs_route/migration.sql` (migration #5).

**`apps/api/src/modules/points/`** (new) — `points.service.ts`, `points.controller.ts`, `point.impact.ts`, `points.module.ts`.
**`apps/api/src/modules/legs/`** (new) — `legs.service.ts`, `legs.controller.ts`, `leg.impact.ts`, `legs.module.ts`.
**`apps/api/src/modules/routing/`** (new) — `routing.service.ts`, `route-graph.ts` (graph loader), `routing.route-validator.ts`, `routing.controller.ts`, `routing.module.ts`.

**Modify (seam wiring)**
- `apps/api/src/modules/status/state-store.ts` — add `save()` to the interface; replace `LogBackedStateStore` binding with a key-aware `DispatchingStateStore`.
- `apps/api/src/modules/status/status.service.ts` — `fire` calls `store.save(...)` in-tx.
- `apps/api/src/modules/status/query-status.projector.ts` — load real leg statuses; pass `{ rfqReady }`.
- `apps/api/src/modules/status/status.module.ts` — stop registering `legMachine` (legs module owns it); bind the new store.
- `apps/api/src/modules/changes/impact.classifier.ts` — async `classify`; cargo→leg fan-out.
- `apps/api/src/modules/changes/change-mediator.ts` — `await this.classifier.classify(req)`.
- `apps/api/src/modules/changes/changes.module.ts` — import `RoutingModule`; drop `NoopRouteValidator` binding + the provisional `leg` declaration.
- `apps/api/src/modules/changes/leg.impact.ts` — DELETE (moves to `legs/leg.impact.ts`).
- `apps/api/src/modules/queries/queries.service.ts` — Create Query runs full catalogue + fires legs; GET returns derived-on-read fields.
- `apps/api/src/modules/queries/queries.module.ts` — import `LegsModule`, `RoutingModule`.
- `apps/api/src/app.module.ts` — register `PointsModule`, `LegsModule`, `RoutingModule`.

**Tests (new e2e in `apps/api/test/`)** — `points-legs-model.e2e-spec.ts`, `points.e2e-spec.ts`, `legs.e2e-spec.ts`, `routing.e2e-spec.ts`, `create-query-route.e2e-spec.ts`. **Modify** — `change-mediator.e2e-spec.ts`, `status-machine.e2e-spec.ts`.

---

## Task 1: Shared — point/leg schemas, enums & the `deriveQueryStatus` reconciliation

**Files:**
- Create: `packages/shared/src/points.ts`
- Create: `packages/shared/src/legs.ts`
- Create: `packages/shared/src/points.test.ts`
- Create: `packages/shared/src/legs.test.ts`
- Modify: `packages/shared/src/status.ts` (the `deriveQueryStatus` function only)
- Modify: `packages/shared/src/status.test.ts` (one expectation)
- Modify: `packages/shared/src/index.ts` (add exports)

**Interfaces:**
- Consumes: `Finding`/`Severity`/`FindingScope` from `./findings`; `FreightMode`/`FREIGHT_MODES` from `./config`; the isoDate pattern from `./query`; `LegStatus`/`QueryStatus`/`QueryMilestones`/`deriveQueryStatus` from `./status`.
- Produces (later tasks rely on these exact names/types):
  - `PointType` (const-object union: `PICKUP·DELIVERY·WAREHOUSE·AIRPORT·SEAPORT`) + `POINT_TYPES`.
  - `WAREHOUSE_TYPES` (`CONSOLIDATION·CROSS_DOCK·TEMPORARY_STORAGE·OTHER`).
  - `pointSaveSchema` (Zod; `type` required, all other fields optional + format-validated) + `PointSaveInput = z.infer<...>`.
  - `POINT_REQUIRED_FIELDS: Record<PointType, (keyof PointSaveInput)[]>`.
  - `LegExecutionStatus` (`PENDING·IN_TRANSIT·COMPLETED`) + `LEG_EXECUTION_STATUSES`.
  - `legSaveSchema` (Zod; all optional) + `LegSaveInput = z.infer<...>` with keys `legName, originPointId, destinationPointId, mode, readyDate, targetDelivery, assignedCargoIds`.
  - `formatLegCode(seq: number): string` → `` `L${seq}` ``.

- [ ] **Step 1: Write `points.ts`**

```ts
// packages/shared/src/points.ts
import { z } from "zod";

// Five reusable point types (D2). Single-table inheritance in the DB;
// per-type required fields enforced in the route engine (R8), not DB nullability.
export const PointType = {
  PICKUP: "PICKUP",
  DELIVERY: "DELIVERY",
  WAREHOUSE: "WAREHOUSE",
  AIRPORT: "AIRPORT",
  SEAPORT: "SEAPORT",
} as const;
export type PointType = (typeof PointType)[keyof typeof PointType];
export const POINT_TYPES = Object.values(PointType) as [PointType, ...PointType[]];

export const WarehouseType = {
  CONSOLIDATION: "CONSOLIDATION",
  CROSS_DOCK: "CROSS_DOCK",
  TEMPORARY_STORAGE: "TEMPORARY_STORAGE",
  OTHER: "OTHER",
} as const;
export type WarehouseType = (typeof WarehouseType)[keyof typeof WarehouseType];
export const WAREHOUSE_TYPES = Object.values(WarehouseType) as [WarehouseType, ...WarehouseType[]];

// Format validators (F2). Applied only when the field is present — a Draft point
// may be partial; per-type PRESENCE is gated at Create Query by the engine (R8).
const iata = z.string().regex(/^[A-Z]{3}$/, "IATA must be 3 uppercase letters");
const icao = z.string().regex(/^[A-Z]{4}$/, "ICAO must be 4 uppercase letters");
const unLocode = z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}$/, "UN/LOCODE must be 5 characters");
const phone = z.string().regex(/^\+?[1-9]\d{6,14}$/, "Phone must be E.164");

// `type` is the required discriminant (you pick a point type up front); every other
// field is optional here so drafts persist (matches querySaveSchema.partial()).
export const pointSaveSchema = z.object({
  type: z.enum(POINT_TYPES),
  name: z.string().min(1).max(200).optional(),
  streetAddress: z.string().min(1).max(300).optional(),
  city: z.string().min(1).max(120).optional(),
  postalCode: z.string().min(1).max(30).optional(),
  country: z.string().min(1).max(80).optional(),
  contactName: z.string().min(1).max(120).optional(),
  contactPhone: phone.optional(),
  contactEmail: z.string().email().optional(),
  warehouseType: z.enum(WAREHOUSE_TYPES).optional(),
  iataCode: iata.optional(),
  icaoCode: icao.optional(),
  unLocode: unLocode.optional(),
  terminal: z.string().min(1).max(120).optional(),
});
export type PointSaveInput = z.infer<typeof pointSaveSchema>;

// PATCH reuses the same shape, fully optional (type need not be resent on an edit).
export const pointUpdateSchema = pointSaveSchema.partial();
export type PointUpdateInput = z.infer<typeof pointUpdateSchema>;

// Per-type mandatory fields (functional spec §7.4.1 A–E). The engine's R8 uses this at
// Create Query; DELIVERY email is optional; hubs need their code + city/postal/country.
export const POINT_REQUIRED_FIELDS: Record<PointType, (keyof PointSaveInput)[]> = {
  PICKUP: ["name", "streetAddress", "city", "postalCode", "country", "contactName", "contactPhone", "contactEmail"],
  DELIVERY: ["name", "streetAddress", "city", "postalCode", "country", "contactName", "contactPhone"],
  WAREHOUSE: ["name", "streetAddress", "city", "postalCode", "country"],
  AIRPORT: ["name", "iataCode", "city", "postalCode", "country"],
  SEAPORT: ["name", "unLocode", "city", "postalCode", "country"],
};
```

- [ ] **Step 2: Write `legs.ts`**

```ts
// packages/shared/src/legs.ts
import { z } from "zod";
import { FREIGHT_MODES } from "./config";

// Tracking model only (spec §12); UI is Stage 8–9. Stored column, no transitions in Stage 3.
export const LegExecutionStatus = {
  PENDING: "PENDING",
  IN_TRANSIT: "IN_TRANSIT",
  COMPLETED: "COMPLETED",
} as const;
export type LegExecutionStatus = (typeof LegExecutionStatus)[keyof typeof LegExecutionStatus];
export const LEG_EXECUTION_STATUSES = Object.values(LegExecutionStatus) as [
  LegExecutionStatus,
  ...LegExecutionStatus[],
];

const isoDate = z.string().datetime({ offset: true });

// All optional — legs are saved individually and may be partial/draft (D8, spec §7.4.3).
// legCode is minted server-side (never client-supplied). mode reuses FreightMode (D3).
// assignedCargoIds are the D7 tick → LegCargo rows.
export const legSaveSchema = z.object({
  legName: z.string().max(120).optional(),
  originPointId: z.string().uuid().optional(),
  destinationPointId: z.string().uuid().optional(),
  mode: z.enum(FREIGHT_MODES).optional(),
  readyDate: isoDate.optional(),
  targetDelivery: isoDate.optional(),
  assignedCargoIds: z.array(z.string().uuid()).optional(),
});
export type LegSaveInput = z.infer<typeof legSaveSchema>;

// Stable, never reused within a query (spec §7.4.2). Minted from a per-query counter.
export function formatLegCode(seq: number): string {
  return `L${seq}`;
}
```

- [ ] **Step 3: Reconcile `deriveQueryStatus` in `status.ts`**

Replace the existing `deriveQueryStatus` function body (keep `LEG_RANK`/`leastAdvanced` above it unchanged) with:

```ts
// Derived query status: query-level milestones win; otherwise the least-advanced leg
// gates the rollup (the query only advances when ALL legs have, §9.1). Plan 5: RFQ_READY
// is gated on the `rfqReady` milestone in BOTH branches (was inconsistently `created` in
// the leg branch); CREATED now EMERGES from the leg rollup (all legs READY_FOR_RFQ, no
// rfqReady milestone) so `created` is no longer aliased to rfqReadyAt.
export function deriveQueryStatus(
  legStatuses: LegStatus[],
  milestones: QueryMilestones = {},
): QueryStatus {
  if (milestones.closed) return QueryStatus.CLOSED;
  if (milestones.lost) return QueryStatus.LOST;
  if (milestones.won) return QueryStatus.WON;
  if (milestones.awaitingClientDecision) return QueryStatus.AWAITING_CLIENT_DECISION;

  if (legStatuses.length === 0) {
    // No legs (legacy Plan-4 drafts / pre-leg queries): query-level milestones only.
    if (milestones.rfqReady) return QueryStatus.RFQ_READY;
    if (milestones.created) return QueryStatus.CREATED;
    return QueryStatus.DRAFT;
  }

  switch (leastAdvanced(legStatuses)) {
    case LegStatus.DRAFT:
      return QueryStatus.DRAFT;
    case LegStatus.READY_FOR_RFQ:
      // All legs valid & ready ⇒ CREATED; RFQ_READY only once Create Query set the milestone.
      return milestones.rfqReady ? QueryStatus.RFQ_READY : QueryStatus.CREATED;
    case LegStatus.RFQ_SENT:
    case LegStatus.PARTIALLY_QUOTED:
      return QueryStatus.RFQ_SENT;
    case LegStatus.FULLY_QUOTED:
      return QueryStatus.QUOTED;
    case LegStatus.DELIVERED:
      return QueryStatus.CLOSED; // all legs delivered (§9.1)
    case LegStatus.CLOSED:
      return QueryStatus.CLOSED;
    default:
      // AWARDED / IN_TRANSIT: no query-level rollup status until Stage 5+/8–9 (advance via
      // milestones — WON on PO, CLOSED on closure). Documented placeholder, unreachable in
      // Stage 3 (no edges reach those states).
      return QueryStatus.QUOTED;
  }
}
```

- [ ] **Step 4: Update the pinned expectation in `status.test.ts`**

Find the assertion that all-`READY_FOR_RFQ` legs with `{ created: true }` derive `RFQ_READY`, and change it so the `rfqReady` milestone (not `created`) gates `RFQ_READY`:

```ts
// All legs ready but no rfqReady milestone ⇒ CREATED (emergent).
expect(deriveQueryStatus([LegStatus.READY_FOR_RFQ, LegStatus.READY_FOR_RFQ], {})).toBe(
  QueryStatus.CREATED,
);
// The rfqReady milestone promotes it to RFQ_READY.
expect(
  deriveQueryStatus([LegStatus.READY_FOR_RFQ, LegStatus.READY_FOR_RFQ], { rfqReady: true }),
).toBe(QueryStatus.RFQ_READY);
// A single DELIVERED-least rollup closes the query.
expect(deriveQueryStatus([LegStatus.DELIVERED, LegStatus.DELIVERED])).toBe(QueryStatus.CLOSED);
```

Leave the zero-leg expectations (`[]`→DRAFT, `[],{created}`→CREATED, `[],{rfqReady}`→RFQ_READY, override cases) unchanged.

- [ ] **Step 5: Export from `index.ts`**

Append after the existing exports (NOT `./route` yet — that file is created in Task 2, which adds its own export line; adding it now would break `typecheck`/`build` between tasks):

```ts
export * from "./points";
export * from "./legs";
```

- [ ] **Step 6: Write `points.test.ts`**

```ts
// packages/shared/src/points.test.ts
import { describe, it, expect } from "vitest";
import { PointType, POINT_TYPES, WAREHOUSE_TYPES, pointSaveSchema, POINT_REQUIRED_FIELDS } from "./points";

describe("point vocabularies", () => {
  it("pins POINT_TYPES order (feeds Zod + Prisma enum)", () => {
    expect(POINT_TYPES).toEqual(["PICKUP", "DELIVERY", "WAREHOUSE", "AIRPORT", "SEAPORT"]);
  });
  it("pins WAREHOUSE_TYPES", () => {
    expect(WAREHOUSE_TYPES).toEqual(["CONSOLIDATION", "CROSS_DOCK", "TEMPORARY_STORAGE", "OTHER"]);
  });
});

describe("pointSaveSchema", () => {
  it("requires type", () => {
    expect(pointSaveSchema.safeParse({}).success).toBe(false);
  });
  it("accepts a partial draft point (type only)", () => {
    expect(pointSaveSchema.safeParse({ type: PointType.PICKUP }).success).toBe(true);
  });
  it("validates IATA format when present", () => {
    expect(pointSaveSchema.safeParse({ type: PointType.AIRPORT, iataCode: "bom" }).success).toBe(false);
    expect(pointSaveSchema.safeParse({ type: PointType.AIRPORT, iataCode: "BOM" }).success).toBe(true);
  });
  it("validates UN/LOCODE format when present", () => {
    expect(pointSaveSchema.safeParse({ type: PointType.SEAPORT, unLocode: "INNSA" }).success).toBe(true);
    expect(pointSaveSchema.safeParse({ type: PointType.SEAPORT, unLocode: "TOOLONG" }).success).toBe(false);
  });
});

describe("POINT_REQUIRED_FIELDS", () => {
  it("makes DELIVERY email optional but PICKUP email required", () => {
    expect(POINT_REQUIRED_FIELDS.PICKUP).toContain("contactEmail");
    expect(POINT_REQUIRED_FIELDS.DELIVERY).not.toContain("contactEmail");
  });
  it("requires the hub code for AIRPORT/SEAPORT", () => {
    expect(POINT_REQUIRED_FIELDS.AIRPORT).toContain("iataCode");
    expect(POINT_REQUIRED_FIELDS.SEAPORT).toContain("unLocode");
  });
});
```

- [ ] **Step 7: Write `legs.test.ts`**

```ts
// packages/shared/src/legs.test.ts
import { describe, it, expect } from "vitest";
import { LEG_EXECUTION_STATUSES, legSaveSchema, formatLegCode } from "./legs";

describe("leg vocabularies", () => {
  it("pins LEG_EXECUTION_STATUSES", () => {
    expect(LEG_EXECUTION_STATUSES).toEqual(["PENDING", "IN_TRANSIT", "COMPLETED"]);
  });
});

describe("legSaveSchema", () => {
  it("accepts an empty partial leg", () => {
    expect(legSaveSchema.safeParse({}).success).toBe(true);
  });
  it("rejects a non-mode value", () => {
    expect(legSaveSchema.safeParse({ mode: "TRAIN" }).success).toBe(false);
  });
  it("accepts assignedCargoIds as uuids", () => {
    expect(
      legSaveSchema.safeParse({ assignedCargoIds: ["11111111-1111-1111-1111-111111111111"] }).success,
    ).toBe(true);
  });
});

describe("formatLegCode", () => {
  it("formats L1, L2, …", () => {
    expect(formatLegCode(1)).toBe("L1");
    expect(formatLegCode(12)).toBe("L12");
  });
});
```

- [ ] **Step 8: Run the shared tests**

Run: `pnpm --filter @svyft/shared test`
Expected: PASS (points, legs, status suites green; the updated `status.test.ts` expectations pass).

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/points.ts packages/shared/src/legs.ts packages/shared/src/points.test.ts packages/shared/src/legs.test.ts packages/shared/src/status.ts packages/shared/src/status.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): point/leg schemas + enums; reconcile deriveQueryStatus for the leg rollup"
```

## Task 2: Shared — the `validateRoute` route engine (`packages/shared/src/route.ts`)

The isomorphic, pure engine implementing the full functional-spec §10 catalogue. No Nest/DB deps. `phase='draft'` emits everything as **warnings except V-M1** (the always-blocking leg-save rule); `phase='create'` emits everything **blocking**. Per-cargo-row subgraph checks (R1/R2/R4/R6/C2/T1/T2/R9) run alongside whole-graph checks (R3/R5/R7/R8/V-M1/T3/C1/C3).

**Files:**
- Create: `packages/shared/src/route.ts`
- Create: `packages/shared/src/route.test.ts`

**Interfaces:**
- Consumes: `Finding`/`Severity`/`FindingScope` from `./findings`; `PointType`/`POINT_REQUIRED_FIELDS`/`PointSaveInput` from `./points`; `FreightMode` from `./config`.
- Produces (Task 6's graph loader + validator, Task 9's Create Query rely on these):
  - `RouteGraphQuery`, `RoutePoint`, `RouteLeg`, `RouteCargo`, `RouteGraph` interfaces (the exact shapes the API graph loader must build).
  - `RoutePhase = "draft" | "create"`.
  - `validateRoute(graph: RouteGraph, phase: RoutePhase): Finding[]`.
  - `checkModeEndpoints(mode, originType, destType): boolean` (V-M1 predicate; reused by `LegsService` for pre-write leg-save rejection).

- [ ] **Step 1: Write the failing tests (`route.test.ts`)**

```ts
// packages/shared/src/route.test.ts
import { describe, it, expect } from "vitest";
import { validateRoute, checkModeEndpoints, type RouteGraph } from "./route";

// ── fixtures ────────────────────────────────────────────────────────────────
const READY = "2026-08-01T00:00:00.000Z";
const MID = "2026-08-05T00:00:00.000Z";
const TARGET = "2026-08-10T00:00:00.000Z";

// A fully-valid 2-leg ROAD route through a warehouse hub for one cargo row:
// Pickup -> Warehouse -> Delivery. All-ROAD so V-M1 passes (SEA/AIR need matching hubs).
function validGraph(): RouteGraph {
  return {
    query: { id: "q1", readyDate: READY, targetDelivery: TARGET },
    points: [
      { id: "pu", type: "PICKUP", name: "Shipper", streetAddress: "1 St", city: "Mumbai", postalCode: "400001", country: "IN", contactName: "A", contactPhone: "+911234567", contactEmail: "a@x.com", warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null },
      { id: "wh", type: "WAREHOUSE", name: "Hub", streetAddress: "5 Rd", city: "Delhi", postalCode: "110001", country: "IN", contactName: null, contactPhone: null, contactEmail: null, warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null },
      { id: "de", type: "DELIVERY", name: "Consignee", streetAddress: "9 Rd", city: "Hamburg", postalCode: "20095", country: "DE", contactName: "B", contactPhone: "+491234567", contactEmail: null, warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null },
    ],
    legs: [
      { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "pu", destinationPointId: "wh", readyDate: READY, targetDelivery: MID },
      { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "wh", destinationPointId: "de", readyDate: MID, targetDelivery: TARGET },
    ],
    cargo: [{ id: "c1", poReference: "PO-1", isDangerous: false, msdsFileId: null, grossWt: 100, volumeCbm: 1 }],
    legCargo: [
      { legId: "l1", cargoItemId: "c1" },
      { legId: "l2", cargoItemId: "c1" },
    ],
  };
}
const rules = (g: RouteGraph, phase: "draft" | "create") => validateRoute(g, phase).map((f) => f.rule);

describe("validateRoute — valid route", () => {
  it("returns no findings for a complete valid route at create phase", () => {
    expect(validateRoute(validGraph(), "create")).toEqual([]);
  });
});

describe("checkModeEndpoints (V-M1)", () => {
  it("AIR needs both airport endpoints", () => {
    expect(checkModeEndpoints("AIR", "AIRPORT", "AIRPORT")).toBe(true);
    expect(checkModeEndpoints("AIR", "AIRPORT", "DELIVERY")).toBe(false);
  });
  it("SEA needs both seaport endpoints", () => {
    expect(checkModeEndpoints("SEA", "SEAPORT", "SEAPORT")).toBe(true);
    expect(checkModeEndpoints("SEA", "PICKUP", "SEAPORT")).toBe(false);
  });
  it("ROAD accepts any endpoints (incl. port drayage)", () => {
    expect(checkModeEndpoints("ROAD", "PICKUP", "SEAPORT")).toBe(true);
    expect(checkModeEndpoints("ROAD", "PICKUP", "DELIVERY")).toBe(true);
  });
});

describe("V-M1 is always blocking (both phases)", () => {
  it("blocks a SEA leg between non-seaports even in draft", () => {
    const g = validGraph();
    g.legs[1].mode = "SEA"; // wh(WAREHOUSE) -> de(DELIVERY) is invalid for SEA
    const draft = validateRoute(g, "draft").filter((f) => f.rule === "V-M1");
    expect(draft.length).toBe(1);
    expect(draft[0].severity).toBe("blocking");
  });
});

describe("R5 — need a pickup and a delivery", () => {
  it("flags a graph with no delivery point", () => {
    const g = validGraph();
    g.points = g.points.filter((p) => p.type !== "DELIVERY");
    g.legs = [g.legs[0]];
    g.legCargo = [{ legId: "l1", cargoItemId: "c1" }];
    expect(rules(g, "create")).toContain("R5");
  });
});

describe("R3 — orphans", () => {
  it("flags a leg with no cargo", () => {
    const g = validGraph();
    g.legCargo = g.legCargo.filter((lc) => lc.legId !== "l2");
    expect(rules(g, "create")).toContain("R3");
  });
  it("flags a cargo row with no legs", () => {
    const g = validGraph();
    g.cargo.push({ id: "c2", poReference: "PO-2", isDangerous: false, msdsFileId: null, grossWt: 5, volumeCbm: 0.1 });
    expect(rules(g, "create")).toContain("R3");
  });
  it("flags an unused point", () => {
    const g = validGraph();
    g.points.push({ id: "wh2", type: "WAREHOUSE", name: "WH2", streetAddress: "x", city: "c", postalCode: "1", country: "IN", contactName: null, contactPhone: null, contactEmail: null, warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null });
    expect(rules(g, "create")).toContain("R3");
  });
});

describe("R1/R2 — continuity & endpoints", () => {
  it("flags a broken chain (leg dest != next origin)", () => {
    const g = validGraph();
    g.legs[1].originPointId = "pu"; // l2 no longer starts where l1 ends (wh)
    expect(rules(g, "create")).toContain("R1");
  });
  it("flags a chain not starting at a pickup", () => {
    const g = validGraph();
    g.points[0].type = "WAREHOUSE"; // starts at a warehouse
    expect(rules(g, "create")).toContain("R2");
  });
});

describe("R4 — no cycles", () => {
  it("flags a cycle", () => {
    const g = validGraph();
    // pu->wh, wh->pu forms a cycle with no pickup source / delivery sink
    g.legs = [
      { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "pu", destinationPointId: "wh", readyDate: READY, targetDelivery: MID },
      { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "wh", destinationPointId: "pu", readyDate: MID, targetDelivery: TARGET },
    ];
    g.legCargo = [
      { legId: "l1", cargoItemId: "c1" },
      { legId: "l2", cargoItemId: "c1" },
    ];
    const r = rules(g, "create");
    expect(r.some((x) => x === "R4" || x === "R1" || x === "R6")).toBe(true);
  });
});

describe("R6 — mass balance", () => {
  it("flags cargo stuck at an intermediate hub (enters, never leaves)", () => {
    const g = validGraph();
    g.legs = [g.legs[0]]; // pu->sp only; c1 enters sp but never leaves
    g.legCargo = [{ legId: "l1", cargoItemId: "c1" }];
    const r = rules(g, "create");
    expect(r.some((x) => x === "R2" || x === "R6")).toBe(true); // ends at a seaport, not a delivery
  });
});

describe("R7/R8 — downstream readiness", () => {
  it("flags a missing country on an endpoint", () => {
    const g = validGraph();
    g.points[1].country = null;
    expect(rules(g, "create")).toContain("R7");
  });
  it("flags a pickup missing mandatory fields", () => {
    const g = validGraph();
    g.points[0].contactEmail = null; // pickup requires email
    expect(rules(g, "create")).toContain("R8");
  });
  it("does NOT flag R8 for a delivery missing email (email optional)", () => {
    const g = validGraph();
    g.points[2].contactEmail = null;
    expect(rules(g, "create")).not.toContain("R8");
  });
});

describe("R9 — DG needs MSDS on every carrying leg", () => {
  it("flags DG cargo without an MSDS", () => {
    const g = validGraph();
    g.cargo[0].isDangerous = true;
    g.cargo[0].msdsFileId = null;
    expect(rules(g, "create")).toContain("R9");
  });
});

describe("T1/T2/T3 — temporal", () => {
  it("T1: warns in draft, blocks in create when a leg departs before the prior arrives", () => {
    const g = validGraph();
    g.legs[1].readyDate = "2026-08-03T00:00:00.000Z"; // before l1 target (MID = 08-05)
    const draftT1 = validateRoute(g, "draft").filter((f) => f.rule === "T1");
    expect(draftT1.length).toBeGreaterThan(0);
    expect(draftT1[0].severity).toBe("warning");
    const createT1 = validateRoute(g, "create").filter((f) => f.rule === "T1");
    expect(createT1[0].severity).toBe("blocking");
  });
  it("T2: flags first leg readyDate != query readyDate", () => {
    const g = validGraph();
    g.legs[0].readyDate = "2026-08-02T00:00:00.000Z";
    expect(rules(g, "create")).toContain("T2");
  });
  it("T3: flags an onward hub leg departing before the max feeding arrival", () => {
    const g = validGraph();
    // add a second feeding leg into sp with a later target than l1
    g.points.push({ id: "pu2", type: "PICKUP", name: "S2", streetAddress: "2", city: "Pune", postalCode: "411001", country: "IN", contactName: "C", contactPhone: "+915555555", contactEmail: "c@x.com", warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null });
    g.cargo.push({ id: "c2", poReference: "PO-2", isDangerous: false, msdsFileId: null, grossWt: 50, volumeCbm: 0.5 });
    g.legs.push({ id: "l3", legCode: "L3", mode: "ROAD", originPointId: "pu2", destinationPointId: "wh", readyDate: READY, targetDelivery: "2026-08-07T00:00:00.000Z" });
    g.legCargo.push({ legId: "l3", cargoItemId: "c2" }, { legId: "l2", cargoItemId: "c2" });
    // l2 departs wh at MID (08-05) < max feeding target (08-07)
    expect(rules(g, "create")).toContain("T3");
  });
});

describe("C1/C3 — completeness", () => {
  it("C1: flags a leg missing its mode", () => {
    const g = validGraph();
    g.legs[0].mode = null;
    expect(rules(g, "create")).toContain("C1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @svyft/shared test route`
Expected: FAIL (`validateRoute` / `checkModeEndpoints` not defined).

- [ ] **Step 3: Write `route.ts` (the engine)**

```ts
// packages/shared/src/route.ts
import type { Finding, Severity } from "./findings";
import type { FreightMode } from "./config";
import { PointType, POINT_REQUIRED_FIELDS } from "./points";

export interface RouteGraphQuery {
  id: string;
  readyDate: Date | string | null;
  targetDelivery: Date | string | null;
}
export interface RoutePoint {
  id: string;
  type: PointType;
  name: string | null;
  streetAddress: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  warehouseType: string | null;
  iataCode: string | null;
  icaoCode: string | null;
  unLocode: string | null;
  terminal: string | null;
}
export interface RouteLeg {
  id: string;
  legCode: string;
  mode: FreightMode | null;
  originPointId: string | null;
  destinationPointId: string | null;
  readyDate: Date | string | null;
  targetDelivery: Date | string | null;
}
export interface RouteCargo {
  id: string;
  poReference: string;
  isDangerous: boolean;
  msdsFileId: string | null;
  grossWt: number | string | null;
  volumeCbm: number | string | null;
}
export interface RouteGraph {
  query: RouteGraphQuery;
  points: RoutePoint[];
  legs: RouteLeg[];
  cargo: RouteCargo[];
  legCargo: { legId: string; cargoItemId: string }[];
}
export type RoutePhase = "draft" | "create";

// V-M1 predicate (spec §10.4): AIR ⇒ both airports; SEA ⇒ both seaports; ROAD ⇒ any
// (pickup/delivery/warehouse/port-drayage). Reused by LegsService for pre-write rejection.
export function checkModeEndpoints(mode: FreightMode, originType: PointType, destType: PointType): boolean {
  if (mode === "AIR") return originType === PointType.AIRPORT && destType === PointType.AIRPORT;
  if (mode === "SEA") return originType === PointType.SEAPORT && destType === PointType.SEAPORT;
  return true; // ROAD
}

function pushToMap<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}
function toTime(d: Date | string | null): number | null {
  if (d === null || d === undefined) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
}
function sameInstant(a: Date | string | null, b: Date | string | null): boolean {
  const ta = toTime(a);
  const tb = toTime(b);
  return ta !== null && tb !== null && ta === tb;
}

export function validateRoute(graph: RouteGraph, phase: RoutePhase): Finding[] {
  const findings: Finding[] = [];
  const block = phase === "create";
  const sev = (alwaysBlocking = false): Severity => (block || alwaysBlocking ? "blocking" : "warning");

  const pointById = new Map(graph.points.map((p) => [p.id, p] as const));
  const cargoById = new Map(graph.cargo.map((c) => [c.id, c] as const));
  const legById = new Map(graph.legs.map((l) => [l.id, l] as const));
  const nameOf = (pid: string): string => pointById.get(pid)?.name ?? pid;

  const legsByCargo = new Map<string, string[]>();
  const cargosByLeg = new Map<string, string[]>();
  for (const lc of graph.legCargo) {
    pushToMap(legsByCargo, lc.cargoItemId, lc.legId);
    pushToMap(cargosByLeg, lc.legId, lc.cargoItemId);
  }

  // R5 — at least one pickup and one delivery for the query.
  if (!graph.points.some((p) => p.type === PointType.PICKUP))
    findings.push({ rule: "R5", severity: sev(), scope: { type: "query", id: graph.query.id }, message: "At least one Pickup point is required" });
  if (!graph.points.some((p) => p.type === PointType.DELIVERY))
    findings.push({ rule: "R5", severity: sev(), scope: { type: "query", id: graph.query.id }, message: "At least one Delivery point is required" });

  // R3 — no orphans.
  for (const leg of graph.legs) {
    if (!(cargosByLeg.get(leg.id)?.length))
      findings.push({ rule: "R3", severity: sev(), scope: { type: "leg", id: leg.id }, message: `Leg ${leg.legCode} carries no cargo` });
  }
  for (const c of graph.cargo) {
    if (!(legsByCargo.get(c.id)?.length))
      findings.push({ rule: "R3", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference} is not assigned to any leg` });
  }
  const usedPoints = new Set<string>();
  for (const leg of graph.legs) {
    if (leg.originPointId) usedPoints.add(leg.originPointId);
    if (leg.destinationPointId) usedPoints.add(leg.destinationPointId);
  }
  for (const p of graph.points) {
    if (!usedPoints.has(p.id))
      findings.push({ rule: "R3", severity: sev(), scope: { type: "point", id: p.id }, message: `Point ${p.name ?? p.id} is not used by any leg` });
  }

  // C1 — leg completeness.
  for (const leg of graph.legs) {
    const missing: string[] = [];
    if (!leg.originPointId) missing.push("origin");
    if (!leg.destinationPointId) missing.push("destination");
    if (!leg.mode) missing.push("mode");
    if (!(cargosByLeg.get(leg.id)?.length)) missing.push("cargo");
    if (!leg.readyDate) missing.push("ready date");
    if (!leg.targetDelivery) missing.push("target delivery");
    if (missing.length)
      findings.push({ rule: "C1", severity: sev(), scope: { type: "leg", id: leg.id }, message: `Leg ${leg.legCode} is missing: ${missing.join(", ")}` });
  }

  // C3 — per-leg CBM + gross roll-up computes.
  for (const leg of graph.legs) {
    const cs = (cargosByLeg.get(leg.id) ?? []).map((id) => cargoById.get(id)).filter((c): c is RouteCargo => !!c);
    if (cs.length && cs.some((c) => c.grossWt == null || c.volumeCbm == null))
      findings.push({ rule: "C3", severity: sev(), scope: { type: "leg", id: leg.id }, message: `Leg ${leg.legCode} cannot compute its weight/volume roll-up` });
  }

  // V-M1 — mode ↔ endpoint (ALWAYS blocking).
  for (const leg of graph.legs) {
    if (!leg.mode || !leg.originPointId || !leg.destinationPointId) continue;
    const o = pointById.get(leg.originPointId);
    const d = pointById.get(leg.destinationPointId);
    if (o && d && !checkModeEndpoints(leg.mode, o.type, d.type))
      findings.push({ rule: "V-M1", severity: sev(true), scope: { type: "leg", id: leg.id }, message: `Leg ${leg.legCode} (${leg.mode}) endpoints are incompatible with its mode` });
  }

  // R7 — both endpoints carry a country.
  for (const leg of graph.legs) {
    for (const [role, pid] of [["origin", leg.originPointId], ["destination", leg.destinationPointId]] as const) {
      if (!pid) continue;
      const p = pointById.get(pid);
      if (p && !p.country)
        findings.push({ rule: "R7", severity: sev(), scope: { type: "point", id: p.id }, message: `Leg ${leg.legCode} ${role} point needs a Country` });
    }
  }

  // R8 — per-type mandatory point fields present.
  for (const p of graph.points) {
    const missing = POINT_REQUIRED_FIELDS[p.type].filter((f) => !p[f as keyof RoutePoint]);
    if (missing.length)
      findings.push({ rule: "R8", severity: sev(), scope: { type: "point", id: p.id }, message: `Point ${p.name ?? p.id} (${p.type}) is missing: ${missing.join(", ")}` });
  }

  // T3 — hub convergence (cross-cargo, §8.5): onward readyDate ≥ MAX feeding targetDelivery.
  const incomingByPoint = new Map<string, RouteLeg[]>();
  const outgoingByPoint = new Map<string, RouteLeg[]>();
  for (const l of graph.legs) {
    if (l.destinationPointId) pushToMap(incomingByPoint, l.destinationPointId, l);
    if (l.originPointId) pushToMap(outgoingByPoint, l.originPointId, l);
  }
  for (const [pid, incoming] of incomingByPoint) {
    const outgoing = outgoingByPoint.get(pid) ?? [];
    if (!outgoing.length) continue;
    const maxIn = incoming.reduce<number | null>((m, l) => {
      const t = toTime(l.targetDelivery);
      return t !== null && (m === null || t > m) ? t : m;
    }, null);
    if (maxIn === null) continue;
    for (const out of outgoing) {
      const rd = toTime(out.readyDate);
      if (rd !== null && rd < maxIn)
        findings.push({ rule: "T3", severity: sev(), scope: { type: "leg", id: out.id }, message: `Leg ${out.legCode} departs ${nameOf(pid)} before all feeding legs arrive (hub effective date)` });
    }
  }

  // Per cargo-row subgraph — R1/R2/R4/R6/C2/T1/T2/R9.
  for (const c of graph.cargo) {
    const legs = (legsByCargo.get(c.id) ?? []).map((id) => legById.get(id)).filter((l): l is RouteLeg => !!l);
    if (legs.length === 0) continue; // R3 already flagged

    // R9 — DG cargo ⇒ MSDS present on every carrying leg.
    if (c.isDangerous && !c.msdsFileId) {
      for (const l of legs)
        findings.push({ rule: "R9", severity: sev(), scope: { type: "leg", id: l.id }, message: `Leg ${l.legCode} carries dangerous cargo ${c.poReference} without an MSDS` });
    }

    const edges = legs.filter((l) => l.originPointId && l.destinationPointId);
    if (edges.length === 0) continue; // C1 flags missing endpoints

    const indeg = new Map<string, number>();
    const outdeg = new Map<string, number>();
    const outEdges = new Map<string, RouteLeg[]>();
    const nodes = new Set<string>();
    for (const e of edges) {
      outdeg.set(e.originPointId!, (outdeg.get(e.originPointId!) ?? 0) + 1);
      indeg.set(e.destinationPointId!, (indeg.get(e.destinationPointId!) ?? 0) + 1);
      pushToMap(outEdges, e.originPointId!, e);
      nodes.add(e.originPointId!);
      nodes.add(e.destinationPointId!);
    }

    // R6 — mass balance: every node in==out except one source (out−in=1) and one sink (in−out=1).
    const sources: string[] = [];
    const sinks: string[] = [];
    let imbalanced = false;
    for (const n of nodes) {
      const di = indeg.get(n) ?? 0;
      const dor = outdeg.get(n) ?? 0;
      if (di === dor) continue;
      if (dor - di === 1) sources.push(n);
      else if (di - dor === 1) sinks.push(n);
      else imbalanced = true;
    }
    if (imbalanced)
      findings.push({ rule: "R6", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: a point does not balance (what enters must leave)` });

    if (sources.length !== 1 || sinks.length !== 1) {
      findings.push({ rule: "R1", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: its legs do not form a single continuous Pickup→Delivery chain` });
      continue;
    }
    const start = sources[0];
    const end = sinks[0];
    const startP = pointById.get(start);
    const endP = pointById.get(end);
    if (startP && startP.type !== PointType.PICKUP)
      findings.push({ rule: "R2", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: chain must start at a Pickup (starts at ${startP.type})` });
    if (endP && endP.type !== PointType.DELIVERY)
      findings.push({ rule: "R2", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: chain must end at a Delivery (ends at ${endP.type})` });

    // R1/R4/T1 — walk the unique chain start→end.
    const visited = new Set<string>();
    let cur = start;
    let steps = 0;
    let prevLeg: RouteLeg | null = null;
    let firstLeg: RouteLeg | null = null;
    let lastLeg: RouteLeg | null = null;
    let broke = false;
    while (cur !== end) {
      if (visited.has(cur)) {
        findings.push({ rule: "R4", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: route revisits ${nameOf(cur)} (cycle)` });
        broke = true;
        break;
      }
      visited.add(cur);
      const outs = outEdges.get(cur) ?? [];
      if (outs.length !== 1) {
        findings.push({ rule: "R1", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: broken or forking chain at ${nameOf(cur)}` });
        broke = true;
        break;
      }
      const leg = outs[0];
      if (!firstLeg) firstLeg = leg;
      lastLeg = leg;
      if (prevLeg) {
        const prevArr = toTime(prevLeg.targetDelivery);
        const dep = toTime(leg.readyDate);
        if (prevArr !== null && dep !== null && dep < prevArr)
          findings.push({ rule: "T1", severity: sev(), scope: { type: "leg", id: leg.id }, message: `Leg ${leg.legCode} departs before the previous leg arrives` });
      }
      prevLeg = leg;
      cur = leg.destinationPointId!;
      steps++;
      if (steps > edges.length) {
        findings.push({ rule: "R4", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: route does not terminate (cycle)` });
        broke = true;
        break;
      }
    }

    // C2 — all of this row's legs consumed by the single chain.
    if (!broke && steps !== edges.length)
      findings.push({ rule: "C2", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: not all its legs form one continuous chain` });

    // T2 — first leg readyDate = query readyDate; last leg targetDelivery = query targetDelivery.
    if (!broke && firstLeg && !sameInstant(firstLeg.readyDate, graph.query.readyDate))
      findings.push({ rule: "T2", severity: sev(), scope: { type: "leg", id: firstLeg.id }, message: `First leg ${firstLeg.legCode} Ready Date must equal the query Ready Date` });
    if (!broke && lastLeg && !sameInstant(lastLeg.targetDelivery, graph.query.targetDelivery))
      findings.push({ rule: "T2", severity: sev(), scope: { type: "leg", id: lastLeg.id }, message: `Last leg ${lastLeg.legCode} Target Delivery must equal the query Target Delivery` });
  }

  return findings;
}
```

- [ ] **Step 3b: Export `./route` from `index.ts`**

Add the line (after the `./legs` export added in Task 1):

```ts
export * from "./route";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @svyft/shared test route`
Expected: PASS (all rule cases green; valid graph → `[]` at create).

- [ ] **Step 5: Run the whole shared suite (no regressions)**

Run: `pnpm --filter @svyft/shared test && pnpm --filter @svyft/shared typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/route.ts packages/shared/src/route.test.ts
git commit -m "feat(shared): pure isomorphic validateRoute engine (full §10 catalogue)"
```

## Task 3: Prisma — `Point`/`Leg`/`LegCargo` models + migration #5

**Files:**
- Modify: `prisma/schema.prisma` (add 3 enums, 3 models, Query/CargoItem back-relations)
- Create: `prisma/migrations/<timestamp>_points_legs_route/migration.sql` (generated by `migrate dev`)
- Create: `apps/api/test/points-legs-model.e2e-spec.ts`

**Interfaces:**
- Consumes: the `@svyft/shared` enum VALUES (`POINT_TYPES`, `LEG_STATUSES`, `LEG_EXECUTION_STATUSES`) must match these Prisma enums exactly.
- Produces: Prisma models `Point`, `Leg`, `LegCargo` with the columns Task 6's graph loader reads; `Leg.status LegStatus @default(DRAFT)`, `Leg.executionStatus LegExecutionStatus @default(PENDING)`; `@@unique([queryId, legCode])`, `@@unique([legId, cargoItemId])`.

- [ ] **Step 1: Add enums to `schema.prisma`** (after the existing `FileKind` enum)

```prisma
enum PointType {
  PICKUP
  DELIVERY
  WAREHOUSE
  AIRPORT
  SEAPORT
}

enum LegStatus {
  DRAFT
  READY_FOR_RFQ
  RFQ_SENT
  PARTIALLY_QUOTED
  FULLY_QUOTED
  AWARDED
  IN_TRANSIT
  DELIVERED
  CLOSED
}

enum LegExecutionStatus {
  PENDING
  IN_TRANSIT
  COMPLETED
}
```

- [ ] **Step 2: Add models to `schema.prisma`** (after the `CargoItem` model)

```prisma
model Point {
  id            String    @id @default(uuid()) @db.Uuid
  tenantId      String?   @db.Uuid
  queryId       String    @db.Uuid
  query         Query     @relation(fields: [queryId], references: [id], onDelete: Cascade)
  type          PointType
  name          String?
  streetAddress String?
  city          String?
  postalCode    String?
  country       String?
  contactName   String?
  contactPhone  String?
  contactEmail  String?
  warehouseType String?
  iataCode      String?
  icaoCode      String?
  unLocode      String?
  terminal      String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  // Deleting a shared point nulls its referencing legs' endpoints; the route engine then
  // flags the broken chain (spec §7.4.3 "re-validates and flags broken chains").
  originLegs      Leg[] @relation("LegOrigin")
  destinationLegs Leg[] @relation("LegDestination")

  @@index([queryId])
  @@index([tenantId])
}

model Leg {
  id                    String             @id @default(uuid()) @db.Uuid
  tenantId              String?            @db.Uuid
  queryId               String             @db.Uuid
  query                 Query              @relation(fields: [queryId], references: [id], onDelete: Cascade)
  legCode               String
  legName               String?
  originPointId         String?            @db.Uuid
  originPoint           Point?             @relation("LegOrigin", fields: [originPointId], references: [id], onDelete: SetNull)
  destinationPointId    String?            @db.Uuid
  destinationPoint      Point?             @relation("LegDestination", fields: [destinationPointId], references: [id], onDelete: SetNull)
  mode                  FreightMode?
  readyDate             DateTime?
  targetDelivery        DateTime?
  status                LegStatus          @default(DRAFT)
  executionStatus       LegExecutionStatus @default(PENDING)
  totalChargeableWeight Decimal?           @db.Decimal(12, 3)
  createdAt             DateTime           @default(now())
  updatedAt             DateTime           @updatedAt

  legCargo LegCargo[]

  @@unique([queryId, legCode])
  @@index([queryId])
  @@index([tenantId])
  @@index([originPointId])
  @@index([destinationPointId])
}

model LegCargo {
  id               String    @id @default(uuid()) @db.Uuid
  tenantId         String?   @db.Uuid
  legId            String    @db.Uuid
  leg              Leg       @relation(fields: [legId], references: [id], onDelete: Cascade)
  cargoItemId      String    @db.Uuid
  cargoItem        CargoItem @relation(fields: [cargoItemId], references: [id], onDelete: Cascade)
  manifestSnapshot Json?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  @@unique([legId, cargoItemId])
  @@index([legId])
  @@index([cargoItemId])
  @@index([tenantId])
}
```

- [ ] **Step 3: Add back-relations to existing models**

In `model Query`, alongside the existing `cargo`/`checklist`/`files` relations, add:

```prisma
  points Point[]
  legs   Leg[]
```

In `model CargoItem`, alongside the existing relations, add:

```prisma
  legCargo LegCargo[]
```

- [ ] **Step 4: Generate the migration** (local Postgres `:5433`)

```bash
set -a; . apps/api/.env; set +a
pnpm --filter @svyft/api exec prisma migrate dev --schema ../../prisma/schema.prisma --name points_legs_route
```
Expected: a new folder `prisma/migrations/<timestamp>_points_legs_route/` with `migration.sql` creating the 3 enum types, 3 tables, their indexes and FK constraints. No generated columns → no hand-edit.

- [ ] **Step 5: Verify zero drift**

```bash
set -a; . apps/api/.env; set +a
pnpm --filter @svyft/api exec prisma migrate diff \
  --from-schema-datasource ../../prisma/schema.prisma \
  --to-schema-datamodel ../../prisma/schema.prisma --script
```
Expected: prints `-- This is an empty migration.` (schema and DB agree).

- [ ] **Step 6: Write the model test (`apps/api/test/points-legs-model.e2e-spec.ts`)**

```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const PFX = "p5-model-";

describe("Point/Leg/LegCargo model (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  async function makeQuery() {
    return prisma.query.create({ data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}q` } });
  }

  it("cascades points/legs/legCargo when the query is deleted", async () => {
    const q = await makeQuery();
    const pu = await prisma.point.create({ data: { queryId: q.id, type: "PICKUP", name: "PU" } });
    const de = await prisma.point.create({ data: { queryId: q.id, type: "DELIVERY", name: "DE" } });
    const cargo = await prisma.cargoItem.create({
      data: { queryId: q.id, rowIndex: 1, poReference: "PO", productName: "P", packageType: "Box", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 },
    });
    const leg = await prisma.leg.create({
      data: { queryId: q.id, legCode: "L1", originPointId: pu.id, destinationPointId: de.id, mode: "ROAD" },
    });
    await prisma.legCargo.create({ data: { legId: leg.id, cargoItemId: cargo.id } });

    expect(leg.status).toBe("DRAFT");
    expect(leg.executionStatus).toBe("PENDING");

    await prisma.query.delete({ where: { id: q.id } });
    expect(await prisma.point.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.leg.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.legCargo.count({ where: { legId: leg.id } })).toBe(0);
  });

  it("enforces unique legCode per query and unique (legId, cargoItemId)", async () => {
    const q = await makeQuery();
    await prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "ROAD" } });
    await expect(prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "SEA" } })).rejects.toThrow();

    const cargo = await prisma.cargoItem.create({
      data: { queryId: q.id, rowIndex: 1, poReference: "PO", productName: "P", packageType: "Box", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 },
    });
    const leg = await prisma.leg.create({ data: { queryId: q.id, legCode: "L2", mode: "ROAD" } });
    await prisma.legCargo.create({ data: { legId: leg.id, cargoItemId: cargo.id } });
    await expect(prisma.legCargo.create({ data: { legId: leg.id, cargoItemId: cargo.id } })).rejects.toThrow();
  });

  it("nulls a leg endpoint when its point is deleted (SetNull)", async () => {
    const q = await makeQuery();
    const pu = await prisma.point.create({ data: { queryId: q.id, type: "PICKUP", name: "PU" } });
    const de = await prisma.point.create({ data: { queryId: q.id, type: "DELIVERY", name: "DE" } });
    const leg = await prisma.leg.create({
      data: { queryId: q.id, legCode: "L1", originPointId: pu.id, destinationPointId: de.id, mode: "ROAD" },
    });
    await prisma.point.delete({ where: { id: pu.id } });
    const reloaded = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(reloaded?.originPointId).toBeNull();
  });
});
```

- [ ] **Step 7: Run the model test**

Run: `pnpm --filter @svyft/api exec prisma generate --schema ../../prisma/schema.prisma && pnpm --filter @svyft/api test points-legs-model`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations apps/api/test/points-legs-model.e2e-spec.ts
git commit -m "feat(prisma): Point/Leg/LegCargo models + migration #5"
```

---

## Task 4: `points` module — reusable point CRUD through the mediator

**Files:**
- Create: `apps/api/src/modules/points/point.impact.ts`
- Create: `apps/api/src/modules/points/points.service.ts`
- Create: `apps/api/src/modules/points/points.controller.ts`
- Create: `apps/api/src/modules/points/points.module.ts`
- Modify: `apps/api/src/app.module.ts` (register `PointsModule`)
- Create: `apps/api/test/points.e2e-spec.ts`

**Interfaces:**
- Consumes: `pointSaveSchema`/`pointUpdateSchema`/`PointSaveInput`/`PointUpdateInput` (Task 1); `ChangeMediator`/`ImpactRegistry` (`changes`); `ZodValidationPipe`, `@CurrentUser()`/`RequestUser`, `PrismaService`.
- Produces: `PointsService` with `create(queryId, input, user)`, `update(queryId, pointId, input, user)`, `remove(queryId, pointId, user)`; routes `POST/PATCH/DELETE /queries/:id/points`.

- [ ] **Step 1: Write `point.impact.ts`**

```ts
// apps/api/src/modules/points/point.impact.ts
import { ImpactClass, type PointSaveInput } from "@svyft/shared";
import type { EntityImpactMap } from "../changes/impact.registry";

// Point field impact classes (§11.1: address + country are RfqDefining; contact is Corrective).
// Typed Record<keyof PointSaveInput | "@create" | "@delete"> for compile-time completeness.
export const pointImpactMap: Record<keyof PointSaveInput | "@create" | "@delete", ImpactClass> = {
  type: ImpactClass.RfqDefining,
  name: ImpactClass.Corrective,
  streetAddress: ImpactClass.RfqDefining,
  city: ImpactClass.RfqDefining,
  postalCode: ImpactClass.RfqDefining,
  country: ImpactClass.RfqDefining,
  contactName: ImpactClass.Corrective,
  contactPhone: ImpactClass.Corrective,
  contactEmail: ImpactClass.Corrective,
  warehouseType: ImpactClass.Corrective,
  iataCode: ImpactClass.RfqDefining,
  icaoCode: ImpactClass.Corrective,
  unLocode: ImpactClass.RfqDefining,
  terminal: ImpactClass.Corrective,
  "@create": ImpactClass.Structural,
  "@delete": ImpactClass.Structural,
};
```

- [ ] **Step 2: Write `points.service.ts`**

```ts
// apps/api/src/modules/points/points.service.ts
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { PointSaveInput, PointUpdateInput } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import type { RequestUser } from "../auth/types";

@Injectable()
export class PointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
  ) {}

  private async assertQueryExists(queryId: string): Promise<void> {
    const q = await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } });
    if (!q) throw new NotFoundException("Query not found");
  }

  private async load(queryId: string, pointId: string) {
    const p = await this.prisma.point.findFirst({ where: { id: pointId, queryId } });
    if (!p) throw new NotFoundException("Point not found");
    return p;
  }

  async create(queryId: string, input: PointSaveInput, user: RequestUser) {
    await this.assertQueryExists(queryId);
    const id = randomUUID();
    let created: unknown;
    await this.mediator.apply(
      { entity: "point", id, action: "@create", queryId, actorId: user.userId },
      async (tx) => {
        created = await tx.point.create({
          data: { id, queryId, tenantId: user.tenantId, ...input } as Prisma.PointUncheckedCreateInput,
        });
      },
    );
    return created;
  }

  async update(queryId: string, pointId: string, input: PointUpdateInput, user: RequestUser) {
    await this.load(queryId, pointId);
    const fields = Object.keys(input);
    if (fields.length === 0) return this.load(queryId, pointId);
    let updated: unknown;
    await this.mediator.apply(
      {
        entity: "point",
        id: pointId,
        field: this.impacts.highestImpactField("point", fields),
        patch: input,
        queryId,
        actorId: user.userId,
      },
      async (tx) => {
        updated = await tx.point.update({
          where: { id: pointId },
          data: input as Prisma.PointUncheckedUpdateInput,
        });
      },
    );
    return updated;
  }

  async remove(queryId: string, pointId: string, user: RequestUser) {
    await this.load(queryId, pointId);
    await this.mediator.apply(
      { entity: "point", id: pointId, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        // Referencing legs' endpoints are nulled by the SetNull FK; revalidation flags them.
        await tx.point.delete({ where: { id: pointId } });
      },
    );
  }
}
```

- [ ] **Step 3: Write `points.controller.ts`**

```ts
// apps/api/src/modules/points/points.controller.ts
import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { pointSaveSchema, pointUpdateSchema, type PointSaveInput, type PointUpdateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { PointsService } from "./points.service";

@Controller("queries/:id/points")
export class PointsController {
  constructor(private readonly points: PointsService) {}

  @Post()
  create(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(pointSaveSchema)) body: PointSaveInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.points.create(id, body, user);
  }

  @Patch(":pointId")
  update(
    @Param("id") id: string,
    @Param("pointId") pointId: string,
    @Body(new ZodValidationPipe(pointUpdateSchema)) body: PointUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.points.update(id, pointId, body, user);
  }

  @Delete(":pointId")
  @HttpCode(204)
  remove(@Param("id") id: string, @Param("pointId") pointId: string, @CurrentUser() user: RequestUser) {
    return this.points.remove(id, pointId, user);
  }
}
```

- [ ] **Step 4: Write `points.module.ts`**

```ts
// apps/api/src/modules/points/points.module.ts
import { Module, type OnModuleInit } from "@nestjs/common";
import { ChangesModule } from "../changes/changes.module";
import { ImpactRegistry } from "../changes/impact.registry";
import { PointsController } from "./points.controller";
import { PointsService } from "./points.service";
import { pointImpactMap } from "./point.impact";

@Module({
  imports: [ChangesModule],
  controllers: [PointsController],
  providers: [PointsService],
  exports: [PointsService],
})
export class PointsModule implements OnModuleInit {
  constructor(private readonly impacts: ImpactRegistry) {}
  onModuleInit(): void {
    this.impacts.declare("point", pointImpactMap);
  }
}
```

- [ ] **Step 5: Register `PointsModule` in `app.module.ts`**

Add the import and place `PointsModule` in the `imports` array after `CargoModule`:

```ts
import { PointsModule } from "./modules/points/points.module";
// … imports: [ …, CargoModule, PointsModule, HealthModule ]
```

- [ ] **Step 6: Write `apps/api/test/points.e2e-spec.ts`**

```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as cookieParser from "cookie-parser";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
const PFX = "p5-points-";
const EXEC_ID = "11111111-1111-1111-1111-111111111111";

describe("Points (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let queryId: string;
  const cookie = () => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: EXEC_ID, role: Role.EXECUTIVE, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    const q = await prisma.query.create({ data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}q` } });
    queryId = q.id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("creates a pickup point", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/points`)
      .set("Cookie", cookie())
      .send({ type: "PICKUP", name: "Shipper", country: "IN" })
      .expect(201);
    expect(res.body.type).toBe("PICKUP");
    expect(res.body.id).toBeDefined();
  });

  it("rejects a bad IATA code (Zod 400)", async () => {
    await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/points`)
      .set("Cookie", cookie())
      .send({ type: "AIRPORT", iataCode: "toolong" })
      .expect(400);
  });

  it("404s a point create under a missing query", async () => {
    await request(app.getHttpServer())
      .post(`/api/queries/${EXEC_ID}/points`)
      .set("Cookie", cookie())
      .send({ type: "PICKUP" })
      .expect(404);
  });

  it("patches and deletes a point", async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/points`)
      .set("Cookie", cookie())
      .send({ type: "WAREHOUSE", name: "WH" })
      .expect(201);
    const pid = created.body.id;
    await request(app.getHttpServer())
      .patch(`/api/queries/${queryId}/points/${pid}`)
      .set("Cookie", cookie())
      .send({ city: "Mumbai" })
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/api/queries/${queryId}/points/${pid}`)
      .set("Cookie", cookie())
      .expect(204);
  });
});
```

- [ ] **Step 7: Run the points test**

Run: `pnpm --filter @svyft/api test points`
Expected: PASS (points-legs-model + points suites).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/points apps/api/src/app.module.ts apps/api/test/points.e2e-spec.ts
git commit -m "feat(points): reusable point CRUD through the change mediator"
```

## Task 5: `legs` module — leg CRUD, legCode minting, LegCargo, V-M1 pre-write

**Files:**
- Create: `apps/api/src/modules/legs/leg.impact.ts`
- Create: `apps/api/src/modules/legs/legs.service.ts`
- Create: `apps/api/src/modules/legs/legs.controller.ts`
- Create: `apps/api/src/modules/legs/legs.module.ts`
- Modify: `apps/api/src/modules/changes/changes.module.ts` (drop the provisional `leg` declaration)
- Delete: `apps/api/src/modules/changes/leg.impact.ts`
- Modify: `apps/api/src/modules/status/status.module.ts` (drop the provisional `legMachine` registration)
- Modify: `apps/api/src/app.module.ts` (register `LegsModule` after `PointsModule`)
- Create: `apps/api/test/legs.e2e-spec.ts`

**Interfaces:**
- Consumes: `legSaveSchema`/`LegSaveInput`, `formatLegCode`, `checkModeEndpoints`, `LegEvent` (`@svyft/shared`); `ChangeMediator`/`ImpactRegistry`; `StatusService`/`StatusRegistry`, `legMachine`, `StatusMachine`.
- Produces: `LegsService` with `create(queryId, input, user)`, `update(queryId, legId, input, user)`, `remove(queryId, legId, user)`, and **`markReadyForRfq(legId, ctx)`** (fires `validate.pass` → `READY_FOR_RFQ`; consumed by Create Query in Task 9). Routes `POST /queries/:id/legs`, `PATCH/DELETE …/legs/:legId`.

- [ ] **Step 1: Write `leg.impact.ts`** (the rekeyed, typed map — supersedes `changes/leg.impact.ts`)

```ts
// apps/api/src/modules/legs/leg.impact.ts
import { ImpactClass, type LegSaveInput } from "@svyft/shared";

// Leg field impact classes (§11.1). Keys match the leg SAVE schema field names (originPointId,
// destinationPointId, …), not the abstract "origin"/"destination" of the old provisional map.
// Reassigning cargo recomputes coverage → Structural.
export const legImpactMap: Record<keyof LegSaveInput | "@create" | "@delete", ImpactClass> = {
  legName: ImpactClass.Corrective,
  originPointId: ImpactClass.RfqDefining,
  destinationPointId: ImpactClass.RfqDefining,
  mode: ImpactClass.RfqDefining,
  readyDate: ImpactClass.RfqDefining,
  targetDelivery: ImpactClass.RfqDefining,
  assignedCargoIds: ImpactClass.Structural,
  "@create": ImpactClass.Structural,
  "@delete": ImpactClass.Structural,
};
```

- [ ] **Step 2: Write `legs.service.ts`**

```ts
// apps/api/src/modules/legs/legs.service.ts
import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { checkModeEndpoints, formatLegCode, LegEvent, type Finding, type FreightMode, type LegSaveInput } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { StatusService } from "../status/status.service";
import type { RequestUser } from "../auth/types";

@Injectable()
export class LegsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly status: StatusService,
  ) {}

  private async assertQueryExists(queryId: string): Promise<void> {
    const q = await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } });
    if (!q) throw new NotFoundException("Query not found");
  }

  private load(queryId: string, legId: string) {
    return this.prisma.leg
      .findFirst({ where: { id: legId, queryId }, include: { legCargo: { select: { cargoItemId: true } } } })
      .then((l) => {
        if (!l) throw new NotFoundException("Leg not found");
        return l;
      });
  }

  private async assertPointRef(queryId: string, pointId: string | null | undefined): Promise<void> {
    if (!pointId) return;
    const p = await this.prisma.point.findFirst({ where: { id: pointId, queryId }, select: { id: true } });
    if (!p) throw new BadRequestException(`Point ${pointId} does not belong to this query`);
  }

  private async assertCargoRefs(queryId: string, cargoIds: string[]): Promise<void> {
    if (!cargoIds.length) return;
    const found = await this.prisma.cargoItem.count({ where: { queryId, id: { in: cargoIds } } });
    if (found !== new Set(cargoIds).size)
      throw new BadRequestException("One or more assigned cargo rows do not belong to this query");
  }

  // V-M1 (spec §10.4) blocks a leg save with an impossible mode↔endpoint. Only checkable when
  // mode + both endpoints are present; partial legs are allowed (draft).
  private async assertModeEndpoints(
    queryId: string,
    mode: FreightMode | null | undefined,
    originId: string | null | undefined,
    destId: string | null | undefined,
    legId?: string,
  ): Promise<void> {
    if (!mode || !originId || !destId) return;
    const [o, d] = await Promise.all([
      this.prisma.point.findFirst({ where: { id: originId, queryId }, select: { type: true } }),
      this.prisma.point.findFirst({ where: { id: destId, queryId }, select: { type: true } }),
    ]);
    if (o && d && !checkModeEndpoints(mode, o.type, d.type)) {
      const finding: Finding = {
        rule: "V-M1",
        severity: "blocking",
        scope: { type: "leg", ...(legId ? { id: legId } : {}) },
        message: `Leg mode ${mode} is incompatible with its endpoint types`,
      };
      throw new HttpException({ findings: [finding] }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
  }

  async create(queryId: string, input: LegSaveInput, user: RequestUser) {
    await this.assertQueryExists(queryId);
    await this.assertPointRef(queryId, input.originPointId);
    await this.assertPointRef(queryId, input.destinationPointId);
    const cargoIds = input.assignedCargoIds ?? [];
    await this.assertCargoRefs(queryId, cargoIds);
    await this.assertModeEndpoints(queryId, input.mode, input.originPointId, input.destinationPointId);

    const id = randomUUID();
    await this.mediator.apply(
      { entity: "leg", id, action: "@create", queryId, actorId: user.userId },
      async (tx) => {
        const seq = await tx.codeSequence.upsert({
          where: { key: `LEG:${queryId}` },
          create: { key: `LEG:${queryId}`, lastNumber: 1 },
          update: { lastNumber: { increment: 1 } },
        });
        await tx.leg.create({
          data: {
            id,
            queryId,
            tenantId: user.tenantId,
            legCode: formatLegCode(seq.lastNumber),
            legName: input.legName ?? null,
            originPointId: input.originPointId ?? null,
            destinationPointId: input.destinationPointId ?? null,
            mode: input.mode ?? null,
            readyDate: input.readyDate ? new Date(input.readyDate) : null,
            targetDelivery: input.targetDelivery ? new Date(input.targetDelivery) : null,
          },
        });
        if (cargoIds.length)
          await tx.legCargo.createMany({
            data: cargoIds.map((cid) => ({ legId: id, cargoItemId: cid, tenantId: user.tenantId })),
          });
      },
    );
    return this.load(queryId, id);
  }

  async update(queryId: string, legId: string, input: LegSaveInput, user: RequestUser) {
    const existing = await this.load(queryId, legId);
    if (input.originPointId !== undefined) await this.assertPointRef(queryId, input.originPointId);
    if (input.destinationPointId !== undefined) await this.assertPointRef(queryId, input.destinationPointId);
    if (input.assignedCargoIds !== undefined) await this.assertCargoRefs(queryId, input.assignedCargoIds);

    const effMode = input.mode !== undefined ? input.mode : existing.mode;
    const effOrigin = input.originPointId !== undefined ? input.originPointId : existing.originPointId;
    const effDest = input.destinationPointId !== undefined ? input.destinationPointId : existing.destinationPointId;
    await this.assertModeEndpoints(queryId, effMode, effOrigin, effDest, legId);

    const fields = Object.keys(input);
    if (fields.length === 0) return this.load(queryId, legId);

    const { assignedCargoIds, readyDate, targetDelivery, ...rest } = input;
    await this.mediator.apply(
      {
        entity: "leg",
        id: legId,
        field: this.impacts.highestImpactField("leg", fields),
        patch: input,
        queryId,
        actorId: user.userId,
      },
      async (tx) => {
        await tx.leg.update({
          where: { id: legId },
          data: {
            ...rest,
            ...(readyDate !== undefined ? { readyDate: readyDate ? new Date(readyDate) : null } : {}),
            ...(targetDelivery !== undefined ? { targetDelivery: targetDelivery ? new Date(targetDelivery) : null } : {}),
          } as Prisma.LegUncheckedUpdateInput,
        });
        if (assignedCargoIds !== undefined) {
          await tx.legCargo.deleteMany({ where: { legId } });
          if (assignedCargoIds.length)
            await tx.legCargo.createMany({
              data: assignedCargoIds.map((cid) => ({ legId, cargoItemId: cid, tenantId: user.tenantId })),
            });
        }
      },
    );
    return this.load(queryId, legId);
  }

  async remove(queryId: string, legId: string, user: RequestUser) {
    await this.load(queryId, legId);
    await this.mediator.apply(
      { entity: "leg", id: legId, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        await tx.leg.delete({ where: { id: legId } }); // legCargo cascades
      },
    );
  }

  // Fire the leg machine forward. THE caller (Create Query) must have validated the whole route
  // first (validateRoute phase='create' clean) — we pass routeValid:true so the guard passes.
  async markReadyForRfq(legId: string, ctx: { queryId: string; actorId?: string | null; tenantId?: string | null }) {
    await this.status.fire("leg", legId, LegEvent.VALIDATE_PASS, {
      routeValid: true,
      queryId: ctx.queryId,
      actorId: ctx.actorId ?? null,
      tenantId: ctx.tenantId ?? null,
    });
  }
}
```

- [ ] **Step 3: Write `legs.controller.ts`**

```ts
// apps/api/src/modules/legs/legs.controller.ts
import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { legSaveSchema, type LegSaveInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { LegsService } from "./legs.service";

@Controller("queries/:id/legs")
export class LegsController {
  constructor(private readonly legs: LegsService) {}

  @Post()
  create(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(legSaveSchema)) body: LegSaveInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.legs.create(id, body, user);
  }

  @Patch(":legId")
  update(
    @Param("id") id: string,
    @Param("legId") legId: string,
    @Body(new ZodValidationPipe(legSaveSchema)) body: LegSaveInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.legs.update(id, legId, body, user);
  }

  @Delete(":legId")
  @HttpCode(204)
  remove(@Param("id") id: string, @Param("legId") legId: string, @CurrentUser() user: RequestUser) {
    return this.legs.remove(id, legId, user);
  }
}
```

- [ ] **Step 4: Write `legs.module.ts`** (takes over the leg impact map + machine registration)

```ts
// apps/api/src/modules/legs/legs.module.ts
import { Module, type OnModuleInit } from "@nestjs/common";
import { ChangesModule } from "../changes/changes.module";
import { ImpactRegistry } from "../changes/impact.registry";
import { StatusModule } from "../status/status.module";
import { StatusRegistry } from "../status/status.registry";
import { legMachine } from "../status/leg.machine";
import type { StatusMachine } from "../status/status.types";
import { LegsController } from "./legs.controller";
import { LegsService } from "./legs.service";
import { legImpactMap } from "./leg.impact";

@Module({
  imports: [ChangesModule, StatusModule],
  controllers: [LegsController],
  providers: [LegsService],
  exports: [LegsService],
})
export class LegsModule implements OnModuleInit {
  constructor(
    private readonly impacts: ImpactRegistry,
    private readonly registry: StatusRegistry,
  ) {}
  onModuleInit(): void {
    this.impacts.declare("leg", legImpactMap);
    this.registry.register(legMachine as StatusMachine);
  }
}
```

- [ ] **Step 5: Remove the provisional `leg` declaration from `changes.module.ts`**

Delete the `import { legImpactMap } from "./leg.impact";` line, and delete the `onModuleInit` body's `this.registry.declare("leg", legImpactMap);` line. If `onModuleInit` is now empty, remove `implements OnModuleInit`, the constructor, and the `onModuleInit` method entirely. Then delete the file `apps/api/src/modules/changes/leg.impact.ts`.

- [ ] **Step 6: Remove the provisional `legMachine` registration from `status.module.ts`**

Delete the `import { legMachine } from "./leg.machine";` and `import type { StatusMachine } from "./status.types";` lines (keep `leg.machine.ts` itself — `LegsModule` imports it). Delete the `this.registry.register(legMachine as StatusMachine);` line. If `onModuleInit` is now empty, remove `implements OnModuleInit`, the constructor, and the method.

- [ ] **Step 7: Register `LegsModule` in `app.module.ts`**

```ts
import { LegsModule } from "./modules/legs/legs.module";
// … imports: [ …, PointsModule, LegsModule, HealthModule ]
```

- [ ] **Step 8: Write `apps/api/test/legs.e2e-spec.ts`**

```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as cookieParser from "cookie-parser";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
const PFX = "p5-legs-";
const EXEC_ID = "11111111-1111-1111-1111-111111111111";

describe("Legs (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let queryId: string;
  let pickupId: string;
  let deliveryId: string;
  let seaportId: string;
  let cargoId: string;
  const cookie = () => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: EXEC_ID, role: Role.EXECUTIVE, tenantId: null })}`;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    const q = await prisma.query.create({ data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}q` } });
    queryId = q.id;
    pickupId = (await prisma.point.create({ data: { queryId, type: "PICKUP", name: "PU", country: "IN" } })).id;
    deliveryId = (await prisma.point.create({ data: { queryId, type: "DELIVERY", name: "DE", country: "DE" } })).id;
    seaportId = (await prisma.point.create({ data: { queryId, type: "SEAPORT", name: "SP", country: "IN" } })).id;
    cargoId = (await prisma.cargoItem.create({ data: { queryId, rowIndex: 1, poReference: "PO", productName: "P", packageType: "Box", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 } })).id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("mints sequential legCodes L1, L2 and stores LegCargo", async () => {
    const l1 = await api()
      .post(`/api/queries/${queryId}/legs`)
      .set("Cookie", cookie())
      .send({ mode: "ROAD", originPointId: pickupId, destinationPointId: seaportId, assignedCargoIds: [cargoId] })
      .expect(201);
    expect(l1.body.legCode).toBe("L1");
    expect(l1.body.legCargo).toHaveLength(1);

    const l2 = await api()
      .post(`/api/queries/${queryId}/legs`)
      .set("Cookie", cookie())
      .send({ mode: "SEA", originPointId: seaportId, destinationPointId: seaportId })
      .expect(201);
    expect(l2.body.legCode).toBe("L2");
  });

  it("blocks an impossible mode↔endpoint at save (V-M1, 422)", async () => {
    const res = await api()
      .post(`/api/queries/${queryId}/legs`)
      .set("Cookie", cookie())
      .send({ mode: "SEA", originPointId: pickupId, destinationPointId: deliveryId })
      .expect(422);
    expect(res.body.findings[0].rule).toBe("V-M1");
  });

  it("400s an assignedCargoId from another query", async () => {
    await api()
      .post(`/api/queries/${queryId}/legs`)
      .set("Cookie", cookie())
      .send({ mode: "ROAD", assignedCargoIds: [EXEC_ID] })
      .expect(400);
  });

  it("patches cargo assignment and deletes the leg", async () => {
    const leg = await api()
      .post(`/api/queries/${queryId}/legs`)
      .set("Cookie", cookie())
      .send({ mode: "ROAD", originPointId: pickupId, destinationPointId: deliveryId })
      .expect(201);
    const legId = leg.body.id;
    const patched = await api()
      .patch(`/api/queries/${queryId}/legs/${legId}`)
      .set("Cookie", cookie())
      .send({ assignedCargoIds: [cargoId] })
      .expect(200);
    expect(patched.body.legCargo).toHaveLength(1);
    await api().delete(`/api/queries/${queryId}/legs/${legId}`).set("Cookie", cookie()).expect(204);
  });
});
```

- [ ] **Step 9: Run the legs test + the existing status/change suites (no regression from the registration moves)**

Run: `pnpm --filter @svyft/api test legs && pnpm --filter @svyft/api test change-mediator && pnpm --filter @svyft/api test status`
Expected: PASS. (The `change-mediator` `classOf("leg", …)` completeness assertions still pass — the map moved but the classes are unchanged; `LegsModule` re-declares them under `AppModule`.)

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/modules/legs apps/api/src/modules/changes/changes.module.ts apps/api/src/modules/status/status.module.ts apps/api/src/app.module.ts apps/api/test/legs.e2e-spec.ts
git rm apps/api/src/modules/changes/leg.impact.ts
git commit -m "feat(legs): leg CRUD, legCode minting, LegCargo, V-M1 pre-write; own the leg machine + impact map"
```

## Task 6: `routing` module — graph loader, real `RouteValidator`, validate endpoint

**Files:**
- Create: `apps/api/src/modules/routing/routing.service.ts`
- Create: `apps/api/src/modules/routing/routing.route-validator.ts`
- Create: `apps/api/src/modules/routing/routing.controller.ts`
- Create: `apps/api/src/modules/routing/routing.module.ts`
- Modify: `apps/api/src/modules/changes/changes.module.ts` (import `RoutingModule`; drop the `NoopRouteValidator` binding)
- Modify: `apps/api/src/app.module.ts` (register `RoutingModule`)
- Modify: `apps/api/test/change-mediator.e2e-spec.ts` (real validator now runs at draft phase)
- Create: `apps/api/test/routing.e2e-spec.ts`

**Interfaces:**
- Consumes: `RouteGraph`/`RoutePhase`/`validateRoute` + `Finding` (`@svyft/shared`); `ROUTE_VALIDATOR`/`RouteValidator` (`../changes/route-validator`); `PrismaService`.
- Produces: `RoutingService.validate(queryId, phase, client?)`, `RoutingService.buildGraph(queryId, client?)`, `RoutingService.legsCarryingCargo(cargoId, client?)` (Task 8 fan-out uses the last); `ROUTE_VALIDATOR` bound to the real validator; `POST /queries/:id/validate?phase=draft|create`.

- [ ] **Step 1: Write `routing.service.ts`** (graph loader reads Prisma directly — keeps `RoutingModule → Prisma only`)

```ts
// apps/api/src/modules/routing/routing.service.ts
import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  validateRoute,
  type Finding,
  type RouteCargo,
  type RouteGraph,
  type RouteLeg,
  type RoutePhase,
  type RoutePoint,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

type Db = Prisma.TransactionClient | PrismaService;

@Injectable()
export class RoutingService {
  constructor(private readonly prisma: PrismaService) {}

  async buildGraph(queryId: string, client: Db = this.prisma): Promise<RouteGraph> {
    const query = await client.query.findUnique({
      where: { id: queryId },
      select: { id: true, readyDate: true, targetDelivery: true },
    });
    if (!query) throw new NotFoundException("Query not found");
    const [points, legs, cargo, legCargo] = await Promise.all([
      client.point.findMany({ where: { queryId } }),
      client.leg.findMany({ where: { queryId } }),
      client.cargoItem.findMany({
        where: { queryId },
        select: { id: true, poReference: true, isDangerous: true, msdsFileId: true, grossWt: true, volumeCbm: true },
      }),
      client.legCargo.findMany({ where: { leg: { queryId } }, select: { legId: true, cargoItemId: true } }),
    ]);
    return {
      query: { id: query.id, readyDate: query.readyDate, targetDelivery: query.targetDelivery },
      points: points.map(
        (p): RoutePoint => ({
          id: p.id,
          type: p.type,
          name: p.name,
          streetAddress: p.streetAddress,
          city: p.city,
          postalCode: p.postalCode,
          country: p.country,
          contactName: p.contactName,
          contactPhone: p.contactPhone,
          contactEmail: p.contactEmail,
          warehouseType: p.warehouseType,
          iataCode: p.iataCode,
          icaoCode: p.icaoCode,
          unLocode: p.unLocode,
          terminal: p.terminal,
        }),
      ),
      legs: legs.map(
        (l): RouteLeg => ({
          id: l.id,
          legCode: l.legCode,
          mode: l.mode,
          originPointId: l.originPointId,
          destinationPointId: l.destinationPointId,
          readyDate: l.readyDate,
          targetDelivery: l.targetDelivery,
        }),
      ),
      cargo: cargo.map(
        (c): RouteCargo => ({
          id: c.id,
          poReference: c.poReference,
          isDangerous: c.isDangerous,
          msdsFileId: c.msdsFileId,
          grossWt: c.grossWt == null ? null : Number(c.grossWt),
          volumeCbm: c.volumeCbm == null ? null : Number(c.volumeCbm),
        }),
      ),
      legCargo,
    };
  }

  async validate(queryId: string, phase: RoutePhase, client: Db = this.prisma): Promise<Finding[]> {
    const graph = await this.buildGraph(queryId, client);
    return validateRoute(graph, phase);
  }

  // The legs carrying a cargo row — used by the ImpactClassifier's cargo→leg fan-out (Task 8).
  async legsCarryingCargo(cargoId: string, client: Db = this.prisma): Promise<string[]> {
    const rows = await client.legCargo.findMany({ where: { cargoItemId: cargoId }, select: { legId: true } });
    return rows.map((r) => r.legId);
  }
}
```

- [ ] **Step 2: Write `routing.route-validator.ts`** (the real `RouteValidator` — Free-path revalidation is draft-phase/advisory)

```ts
// apps/api/src/modules/routing/routing.route-validator.ts
import { Injectable } from "@nestjs/common";
import type { Finding } from "@svyft/shared";
import type { Prisma } from "@prisma/client";
import type { RouteValidator } from "../changes/route-validator";
import { RoutingService } from "./routing.service";

// Replaces NoopRouteValidator. Runs validateRoute at DRAFT phase after a Free-path apply, in the
// SAME tx (reads the just-written state). Resilient to a missing/absent query → [] (no findings).
@Injectable()
export class RoutingRouteValidator implements RouteValidator {
  constructor(private readonly routing: RoutingService) {}

  async revalidate(queryId: string | undefined, tx: Prisma.TransactionClient): Promise<Finding[]> {
    if (!queryId) return [];
    const q = await tx.query.findUnique({ where: { id: queryId }, select: { id: true } });
    if (!q) return [];
    return this.routing.validate(queryId, "draft", tx);
  }
}
```

- [ ] **Step 3: Write `routing.controller.ts`**

```ts
// apps/api/src/modules/routing/routing.controller.ts
import { Controller, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { RoutePhase } from "@svyft/shared";
import { RoutingService } from "./routing.service";

@Controller("queries/:id/validate")
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Post()
  @HttpCode(200)
  async validate(@Param("id") id: string, @Query("phase") phase?: string) {
    const p: RoutePhase = phase === "create" ? "create" : "draft";
    return { findings: await this.routing.validate(id, p) };
  }
}
```

- [ ] **Step 4: Write `routing.module.ts`**

```ts
// apps/api/src/modules/routing/routing.module.ts
import { Module } from "@nestjs/common";
import { ROUTE_VALIDATOR } from "../changes/route-validator";
import { RoutingController } from "./routing.controller";
import { RoutingService } from "./routing.service";
import { RoutingRouteValidator } from "./routing.route-validator";

@Module({
  controllers: [RoutingController],
  providers: [RoutingService, { provide: ROUTE_VALIDATOR, useClass: RoutingRouteValidator }],
  exports: [RoutingService, ROUTE_VALIDATOR],
})
export class RoutingModule {}
```

- [ ] **Step 5: Rewire `changes.module.ts`**

Add `import { RoutingModule } from "../routing/routing.module";`. Add `imports: [RoutingModule]` to the `@Module`. Remove the `import { ROUTE_VALIDATOR, NoopRouteValidator } from "./route-validator";` line **and** the `{ provide: ROUTE_VALIDATOR, useClass: NoopRouteValidator }` provider (the real one now comes from `RoutingModule`). Keep the `CHANGE_LOG`/`NoopChangeLog` binding. Leave `route-validator.ts` (symbol + interface + the now-unused `NoopRouteValidator` class) in place — `FreePathStrategy` and `RoutingRouteValidator` import the symbol/interface from it.

- [ ] **Step 6: Register `RoutingModule` in `app.module.ts`**

```ts
import { RoutingModule } from "./modules/routing/routing.module";
// … imports: [ …, LegsModule, RoutingModule, HealthModule ]
```

- [ ] **Step 7: Update `change-mediator.e2e-spec.ts`**

Read the spec. Its Free-path leg-edit case asserts `res.findings` equals `[]` (the old Noop validator). The real validator now runs at **draft phase** over the edited query's graph. Update that assertion so it accepts draft findings: replace `expect(res.findings).toEqual([]);` with `expect(res.findings.every((f) => f.severity === "warning")).toBe(true);` (draft-phase revalidation never hard-blocks a Free-path edit). Leave the `res.scope` self-scope assertion for the leg edit unchanged. If the test uses a non-existent `queryId`, the resilient `revalidate` returns `[]`, so that case still passes.

- [ ] **Step 8: Write `apps/api/test/routing.e2e-spec.ts`**

```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as cookieParser from "cookie-parser";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
const PFX = "p5-routing-";
const EXEC_ID = "11111111-1111-1111-1111-111111111111";
const READY = "2026-09-01T00:00:00.000Z";
const TARGET = "2026-09-10T00:00:00.000Z";

describe("Routing validate (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = () => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: EXEC_ID, role: Role.EXECUTIVE, tenantId: null })}`;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  // Build a complete, valid single-leg road route Pickup->Delivery for one cargo row.
  async function validQuery() {
    const q = await prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}-${Math.floor(Math.random() * 1e6)}`, shipmentDescription: `${PFX}q`, readyDate: READY, targetDelivery: TARGET },
    });
    const pu = await prisma.point.create({ data: { queryId: q.id, type: "PICKUP", name: "PU", streetAddress: "1", city: "Mumbai", postalCode: "400001", country: "IN", contactName: "A", contactPhone: "+911234567", contactEmail: "a@x.com" } });
    const de = await prisma.point.create({ data: { queryId: q.id, type: "DELIVERY", name: "DE", streetAddress: "9", city: "Pune", postalCode: "411001", country: "IN", contactName: "B", contactPhone: "+915555555" } });
    const cargo = await prisma.cargoItem.create({ data: { queryId: q.id, rowIndex: 1, poReference: "PO", productName: "P", packageType: "Box", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 } });
    const leg = await prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "ROAD", originPointId: pu.id, destinationPointId: de.id, readyDate: READY, targetDelivery: TARGET } });
    await prisma.legCargo.create({ data: { legId: leg.id, cargoItemId: cargo.id } });
    return q.id;
  }

  it("returns no findings for a complete valid route at create phase", async () => {
    const id = await validQuery();
    const res = await api().post(`/api/queries/${id}/validate?phase=create`).set("Cookie", cookie()).expect(200);
    expect(res.body.findings).toEqual([]);
  });

  it("draft-warns but does not create-block a query with no legs", async () => {
    const q = await prisma.query.create({ data: { queryCode: `${PFX}${Date.now()}-empty`, shipmentDescription: `${PFX}q` } });
    const draft = await api().post(`/api/queries/${q.id}/validate?phase=draft`).set("Cookie", cookie()).expect(200);
    expect(draft.body.findings.length).toBeGreaterThan(0);
    expect(draft.body.findings.every((f: { severity: string }) => f.severity === "warning")).toBe(true);
    const create = await api().post(`/api/queries/${q.id}/validate?phase=create`).set("Cookie", cookie()).expect(200);
    expect(create.body.findings.some((f: { rule: string }) => f.rule === "R5")).toBe(true);
    expect(create.body.findings.every((f: { severity: string }) => f.severity === "blocking")).toBe(true);
  });
});
```

- [ ] **Step 9: Run routing + change-mediator + legs suites**

Run: `pnpm --filter @svyft/api test routing && pnpm --filter @svyft/api test change-mediator && pnpm --filter @svyft/api test legs`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/modules/routing apps/api/src/modules/changes/changes.module.ts apps/api/src/app.module.ts apps/api/test/routing.e2e-spec.ts apps/api/test/change-mediator.e2e-spec.ts
git commit -m "feat(routing): query-graph loader + real RouteValidator (Free-path revalidation) + validate endpoint"
```

## Task 7: Status seam — column-backed `Leg.status` store + projector leg rollup

**Files:**
- Modify: `apps/api/src/modules/status/state-store.ts` (add `save`; add `DispatchingStateStore`)
- Modify: `apps/api/src/modules/status/status.service.ts` (`fire` calls `store.save` in-tx)
- Modify: `apps/api/src/modules/status/status.module.ts` (bind `DispatchingStateStore`)
- Modify: `apps/api/src/modules/status/query-status.projector.ts` (load real leg statuses)
- Modify: `apps/api/test/status-machine.e2e-spec.ts` (if it fires `leg`, seed a real `Leg` row)
- Create: `apps/api/test/leg-status.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `LegStatus`/`LegEvent`/`deriveQueryStatus` (`@svyft/shared`); `StatusService.fire`.
- Produces: `StatusStateStore.save(entity, entityId, to, tx)`; a key-aware `DispatchingStateStore` (leg → `Leg.status` column, others → log); `fire` persists `Leg.status` in the same tx as the log append; `QueryStatusProjector.recompute` derives from real leg statuses.

- [ ] **Step 1: Extend the store interface + add the dispatching store (`state-store.ts`)**

```ts
// apps/api/src/modules/status/state-store.ts
import { Injectable } from "@nestjs/common";
import type { LegStatus } from "@svyft/shared";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

// How fire reads AND writes an entity's current state (§7.2). Owned statuses (leg) live in a
// column; log-only machines keep the StatusTransition log as their state.
export interface StatusStateStore {
  load(entity: string, entityId: string, tx: Prisma.TransactionClient): Promise<string | null>;
  save(entity: string, entityId: string, to: string, tx: Prisma.TransactionClient): Promise<void>;
}

export const STATUS_STATE_STORE = Symbol("STATUS_STATE_STORE");

@Injectable()
export class LogBackedStateStore implements StatusStateStore {
  async load(entity: string, entityId: string, tx: Prisma.TransactionClient): Promise<string | null> {
    const last = await tx.statusTransition.findFirst({
      where: { entity, entityId },
      orderBy: { seq: "desc" },
      select: { to: true },
    });
    return last?.to ?? null;
  }
  // The StatusTransition row IS the state — nothing else to persist.
  async save(): Promise<void> {
    /* no-op */
  }
}

// Key-aware store (§7.2). `leg` is an OWNED column-backed status; everything else stays
// log-backed. fire always appends a StatusTransition row too (history / the Stage-4 cascade).
@Injectable()
export class DispatchingStateStore implements StatusStateStore {
  private readonly log = new LogBackedStateStore();

  async load(entity: string, entityId: string, tx: Prisma.TransactionClient): Promise<string | null> {
    if (entity === "leg") {
      const leg = await tx.leg.findUnique({ where: { id: entityId }, select: { status: true } });
      return leg?.status ?? null;
    }
    return this.log.load(entity, entityId, tx);
  }

  async save(entity: string, entityId: string, to: string, tx: Prisma.TransactionClient): Promise<void> {
    if (entity === "leg") {
      await tx.leg.update({ where: { id: entityId }, data: { status: to as LegStatus } });
      return;
    }
    return this.log.save(entity, entityId, to, tx);
  }
}
```

- [ ] **Step 2: Persist the column in `fire` (`status.service.ts`)**

In the `$transaction` block, immediately after the `tx.statusTransition.create({ … })` call (which assigns `row`), and **before** the `if (transition.effect)` line, add:

```ts
      // Owned statuses persist their column in the SAME tx (log-backed keys → no-op).
      await this.store.save(key, entityId, transition.to, tx);
```

- [ ] **Step 3: Bind the new store (`status.module.ts`)**

Change the provider binding from `{ provide: STATUS_STATE_STORE, useClass: LogBackedStateStore }` to `{ provide: STATUS_STATE_STORE, useClass: DispatchingStateStore }`, and update the import to bring in `DispatchingStateStore` (keep `STATUS_STATE_STORE`; `LogBackedStateStore` is still imported by `state-store.ts` internally, not needed in the module).

- [ ] **Step 4: Load real leg statuses in the projector (`query-status.projector.ts`)**

Replace the body of `recompute` (keep the signature + the `@OnEvent` handler) with:

```ts
  async recompute(
    queryId?: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    if (!queryId) return;
    const q = await client.query.findUnique({ where: { id: queryId }, select: { rfqReadyAt: true } });
    if (!q) return;
    const legs = await client.leg.findMany({ where: { queryId }, select: { status: true } });
    const legStatuses = legs.map((l) => l.status) as LegStatus[];
    // `created` is emergent from the leg rollup now — only the rfqReady milestone is passed.
    const status = this.project(legStatuses, { rfqReady: !!q.rfqReadyAt });
    await client.query.update({ where: { id: queryId }, data: { status } });
  }
```

(`LegStatus` is already imported as a type at the top of the file.)

- [ ] **Step 5: Reconcile `status-machine.e2e-spec.ts`**

Read the spec. If any test fires the real `leg` machine (`statusService.fire("leg", …)`), the column store now writes `Leg.status`, so the fired id must be a real `Leg` row — create a `Query` + `Leg` in `beforeAll` (prefix-scoped) and fire against `leg.id`, then assert `Leg.status` moved. If the spec exercises the machine via a synthetic non-`leg` key, no change is needed (that path stays log-backed). Keep it self-cleaning by prefix.

- [ ] **Step 6: Write `apps/api/test/leg-status.e2e-spec.ts`**

```ts
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
```

- [ ] **Step 7: Run the status suites**

Run: `pnpm --filter @svyft/api test leg-status && pnpm --filter @svyft/api test status`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/status apps/api/test/leg-status.e2e-spec.ts apps/api/test/status-machine.e2e-spec.ts
git commit -m "feat(status): column-backed Leg.status store; fire persists it in-tx; projector loads real leg statuses"
```

---

## Task 8: Changes seam — cargo→leg scope fan-out in the classifier

**Files:**
- Modify: `apps/api/src/modules/changes/impact.classifier.ts` (async `classify`; cargo→leg fan-out)
- Modify: `apps/api/src/modules/changes/change-mediator.ts` (`await` the async classify)
- Modify: `apps/api/test/change-mediator.e2e-spec.ts` (add a cargo→leg fan-out scope case)

**Interfaces:**
- Consumes: `RoutingService.legsCarryingCargo` (Task 6); `ChangeRequest`/`FindingScope`/`ImpactClass` (`@svyft/shared`); `ImpactRegistry`.
- Produces: `ImpactClassifier.classify(req): Promise<Classification>` — a `cargo` edit's `scope` fans out to the legs carrying it via `LegCargo`.

- [ ] **Step 1: Make `classify` async + fan out (`impact.classifier.ts`)**

```ts
// apps/api/src/modules/changes/impact.classifier.ts
import { Injectable } from "@nestjs/common";
import type { ChangeRequest, FindingScope, ImpactClass } from "@svyft/shared";
import { ImpactRegistry } from "./impact.registry";
import { RoutingService } from "../routing/routing.service";

export interface Classification {
  class: ImpactClass;
  scope: FindingScope[];
}

// Maps (entity, field|action) → impact class + the minimal touched scope (§11.3). A cargo edit
// fans out to the legs carrying that row (via LegCargo) — that is the scope the Stage-4
// change-order cascade will reopen. Every other entity is self-scope.
@Injectable()
export class ImpactClassifier {
  constructor(
    private readonly registry: ImpactRegistry,
    private readonly routing: RoutingService,
  ) {}

  async classify(req: ChangeRequest): Promise<Classification> {
    const key = req.action ?? req.field;
    if (!key) throw new Error("ChangeRequest must carry a `field` or an `action`");

    const impactClass = this.registry.classOf(req.entity, key);
    if (!impactClass) throw new Error(`No impact class declared for ${req.entity}.${key}`);

    let scope: FindingScope[];
    if (req.entity === "cargo") {
      const legIds = await this.routing.legsCarryingCargo(req.id);
      scope =
        legIds.length > 0
          ? legIds.map((id) => ({ type: "leg", id }))
          : [{ type: "cargo", id: req.id }]; // unassigned cargo → self-scope
    } else {
      scope = [{ type: req.entity as FindingScope["type"], id: req.id }];
    }
    return { class: impactClass, scope };
  }
}
```

- [ ] **Step 2: Await the async classify (`change-mediator.ts`)**

Change the classify line in `apply` from `const { class: impactClass, scope } = this.classifier.classify(req);` to:

```ts
    const { class: impactClass, scope } = await this.classifier.classify(req);
```

(No other change — `ChangesModule` already imports `RoutingModule` from Task 6, so `RoutingService` injects into the classifier.)

- [ ] **Step 3: Add a fan-out case to `change-mediator.e2e-spec.ts`**

Read the spec's setup. Add a test: create a query with a cargo row and two legs both carrying it (via `LegCargo`), then `mediator.apply` a `cargo` field edit (e.g. `{ entity: "cargo", id: cargoId, field: "grossWt", patch: { grossWt: 200 }, queryId }`, uow updating the cargo). Assert the returned `scope` lists BOTH carrying leg ids (order-insensitive):

```ts
const legIdSet = new Set(res.scope.map((s: { type: string; id?: string }) => s.id));
expect(res.scope.every((s: { type: string }) => s.type === "leg")).toBe(true);
expect(legIdSet).toEqual(new Set([legA.id, legB.id]));
```

Also add an unassigned-cargo case: a cargo row on no legs → `res.scope` is `[{ type: "cargo", id }]`. Keep the existing leg-edit self-scope and change-order-throw assertions intact.

- [ ] **Step 4: Run the change suite**

Run: `pnpm --filter @svyft/api test change-mediator && pnpm --filter @svyft/api test cargo`
Expected: PASS (cargo CRUD still works; a cargo edit now returns fanned-out leg scope).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/changes/impact.classifier.ts apps/api/src/modules/changes/change-mediator.ts apps/api/test/change-mediator.e2e-spec.ts
git commit -m "feat(changes): cargo→leg scope fan-out in the impact classifier"
```

## Task 9: Full route-gated Create Query + derived-on-read fields

**Files:**
- Modify: `apps/api/src/modules/queries/queries.service.ts` (Create Query full catalogue + fire legs; `getWithin` shapes derived fields)
- Modify: `apps/api/src/modules/queries/queries.module.ts` (import `LegsModule`, `RoutingModule`)
- Create: `apps/api/test/create-query-route.e2e-spec.ts`

**Interfaces:**
- Consumes: `RoutingService.validate` (Task 6); `LegsService.markReadyForRfq` (Task 5); `collectCreateFindings`/`FreightMode` (`@svyft/shared`); `QueryStatusProjector.recompute`.
- Produces: `POST /queries/:id/create` runs F1/F6 + the full R1–R9/T/C route catalogue at `phase='create'`; on pass fires each leg → `READY_FOR_RFQ` and rolls the query up to `RFQ_READY`. `GET /queries/:id` returns derived `freightMode`, `origin`, `destination`, and per-leg `rollup`.

- [ ] **Step 1: Inject `LegsService` + `RoutingService` (`queries.service.ts` constructor)**

Add two constructor params after the existing ones:

```ts
    private readonly legs: LegsService,
    private readonly routing: RoutingService,
```

Add imports at the top (`Prisma` is already imported for the existing `Prisma.Query*` casts):

```ts
import { LegsService } from "../legs/legs.service";
import { RoutingService } from "../routing/routing.service";
```

- [ ] **Step 2: Replace `createQuery` (full route gating + fire legs)**

```ts
  // Create Query (§13): field catalogue (F1/F6) + the full route catalogue (R1–R9, V-M1, T1–T3,
  // C1–C3) at create phase. On pass: fire every leg to READY_FOR_RFQ, then set the rfqReadyAt
  // milestone and let the projector roll the query up to RFQ_READY (never hand-write status).
  async createQuery(id: string, user: RequestUser) {
    const q = await this.prisma.query.findUnique({
      where: { id },
      include: { cargo: { select: { id: true, isDangerous: true, msdsFileId: true, poReference: true } } },
    });
    if (!q) throw new NotFoundException("Query not found");

    const fieldFindings = collectCreateFindings(
      {
        id: q.id,
        clientId: q.clientId,
        contactName: q.contactName,
        contactEmail: q.contactEmail,
        contactPhone: q.contactPhone,
        readyDate: q.readyDate,
        targetDelivery: q.targetDelivery,
        incoterms: q.incoterms,
      },
      q.cargo,
    );
    const routeFindings = await this.routing.validate(id, "create");
    const findings = [...fieldFindings, ...routeFindings];
    if (findings.some((f) => f.severity === "blocking"))
      throw new HttpException({ findings }, HttpStatus.UNPROCESSABLE_ENTITY);

    // Fire each leg forward (own tx per fire — the route already validated, §8.5 last-write-wins).
    const legs = await this.prisma.leg.findMany({ where: { queryId: id }, select: { id: true } });
    for (const leg of legs) {
      await this.legs.markReadyForRfq(leg.id, { queryId: id, actorId: user.userId, tenantId: user.tenantId });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.query.update({ where: { id }, data: { rfqReadyAt: new Date() } });
      await this.projector.recompute(id, tx); // all legs READY_FOR_RFQ + rfqReady ⇒ RFQ_READY
    });

    const updated = await this.prisma.query.findUnique({ where: { id }, select: { id: true, status: true } });
    return updated!;
  }
```

(Ensure `HttpException`, `HttpStatus`, `NotFoundException`, `collectCreateFindings` remain imported — they already are.)

- [ ] **Step 3: Add the derived-on-read shaper + expand `getWithin` (`queries.service.ts`)**

At module scope (below the imports, above the `@Injectable()` class), add ONE reusable args object via `Prisma.validator` (this gives the correct literal `SortOrder` typing so `QueryGetPayload` resolves — a plain `satisfies` can widen `"asc"` to `string` and break the payload type). It is reused by both the query and the payload type (DRY + type-safe — the payload type is what makes `shapeQuery` typecheck against a real Prisma result):

```ts
const QUERY_GRAPH_ARGS = Prisma.validator<Prisma.QueryDefaultArgs>()({
  include: {
    cargo: { orderBy: [{ rowIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
    checklist: { orderBy: { itemKey: "asc" } },
    files: { select: { id: true, kind: true, filename: true, mime: true, sizeBytes: true, uploadedById: true, createdAt: true } },
    points: true,
    legs: { include: { legCargo: { select: { cargoItemId: true } } }, orderBy: { createdAt: "asc" } },
  },
});
type QueryWithGraph = Prisma.QueryGetPayload<typeof QUERY_GRAPH_ARGS>;
```

Then replace `getWithin` and add the private `shapeQuery` helper next to it (uses the args + payload type above):

```ts
  async getWithin(client: Prisma.TransactionClient | PrismaService, id: string) {
    const row = await client.query.findUnique({ where: { id }, ...QUERY_GRAPH_ARGS });
    if (!row) throw new NotFoundException("Query not found");
    return this.shapeQuery(row);
  }

  // Derived-on-read (§4.5), never stored: freightMode (distinct leg modes), origin/destination
  // (pickup/delivery points), and per-leg roll-ups (packages/CBM/gross/net). Zero drift.
  private shapeQuery(row: QueryWithGraph) {
    const num = (d: Prisma.Decimal | null): number => (d == null ? 0 : Number(d));
    const cargoById = new Map(row.cargo.map((c) => [c.id, c] as const));
    const MODE_ORDER: Record<string, number> = { ROAD: 0, AIR: 1, SEA: 2 };
    const freightMode = [...new Set(row.legs.map((l) => l.mode).filter((m): m is NonNullable<typeof m> => !!m))].sort(
      (a, b) => MODE_ORDER[a] - MODE_ORDER[b],
    );
    const pick = (t: string) =>
      row.points.filter((p) => p.type === t).map((p) => ({ id: p.id, name: p.name, city: p.city, country: p.country }));
    const legs = row.legs.map((l) => {
      const { legCargo, ...rest } = l;
      const attached = legCargo.map((lc) => cargoById.get(lc.cargoItemId)).filter((c): c is NonNullable<typeof c> => !!c);
      return {
        ...rest,
        assignedCargoIds: legCargo.map((lc) => lc.cargoItemId),
        rollup: {
          totalPackages: attached.reduce((s, c) => s + c.qty, 0),
          totalCbm: attached.reduce((s, c) => s + num(c.volumeCbm), 0),
          totalGrossWt: attached.reduce((s, c) => s + num(c.grossWt), 0),
          totalNetWt: attached.reduce((s, c) => s + num(c.netWt), 0),
        },
      };
    });
    return { ...row, freightMode, origin: pick("PICKUP"), destination: pick("DELIVERY"), legs };
  }
```

- [ ] **Step 4: Import `LegsModule` + `RoutingModule` (`queries.module.ts`)**

```ts
import { LegsModule } from "../legs/legs.module";
import { RoutingModule } from "../routing/routing.module";
// … @Module imports: [ChangesModule, StatusModule, LegsModule, RoutingModule]
```

- [ ] **Step 5: Write `apps/api/test/create-query-route.e2e-spec.ts`**

```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as cookieParser from "cookie-parser";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE, LegStatus, QueryStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
const PFX = "p5-createq-";
const EXEC_ID = "11111111-1111-1111-1111-111111111111";
const READY = "2026-10-01T00:00:00.000Z";
const TARGET = "2026-10-10T00:00:00.000Z";

describe("Create Query route gating (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let clientId: string;
  const cookie = () => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: EXEC_ID, role: Role.EXECUTIVE, tenantId: null })}`;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(prisma);
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: PFX } } });
    const client = await prisma.client.create({ data: { clientCode: `${PFX}CL`, companyName: `${PFX}Client`, country: "IN" } });
    clientId = client.id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: PFX } } });
    await app.close();
  });

  async function validQuery() {
    const q = await prisma.query.create({
      data: {
        queryCode: `${PFX}${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        shipmentDescription: `${PFX}q`,
        contactName: "A",
        contactEmail: "a@x.com",
        contactPhone: "+911234567",
        incoterms: "FOB",
        readyDate: READY,
        targetDelivery: TARGET,
        clientId,
      },
    });
    const pu = await prisma.point.create({ data: { queryId: q.id, type: "PICKUP", name: "PU", streetAddress: "1", city: "Mumbai", postalCode: "400001", country: "IN", contactName: "A", contactPhone: "+911234567", contactEmail: "a@x.com" } });
    const de = await prisma.point.create({ data: { queryId: q.id, type: "DELIVERY", name: "DE", streetAddress: "9", city: "Pune", postalCode: "411001", country: "IN", contactName: "B", contactPhone: "+915555555" } });
    const cargo = await prisma.cargoItem.create({ data: { queryId: q.id, rowIndex: 1, poReference: "PO", productName: "P", packageType: "Box", qty: 3, dimL: 100, dimW: 100, dimH: 100, grossWt: 50 } });
    const leg = await prisma.leg.create({ data: { queryId: q.id, legCode: "L1", mode: "ROAD", originPointId: pu.id, destinationPointId: de.id, readyDate: READY, targetDelivery: TARGET } });
    await prisma.legCargo.create({ data: { legId: leg.id, cargoItemId: cargo.id } });
    return { queryId: q.id, legId: leg.id };
  }

  it("gates on the full catalogue then rolls up to RFQ_READY, firing each leg", async () => {
    const { queryId, legId } = await validQuery();
    const res = await api().post(`/api/queries/${queryId}/create`).set("Cookie", cookie()).expect(201);
    expect(res.body.status).toBe(QueryStatus.RFQ_READY);
    const leg = await prisma.leg.findUnique({ where: { id: legId } });
    expect(leg?.status).toBe(LegStatus.READY_FOR_RFQ);
  });

  it("hard-blocks with 422 findings when the route is broken (no delivery)", async () => {
    const { queryId } = await validQuery();
    // Break it: delete the delivery point so R5/R2 fail.
    await prisma.point.deleteMany({ where: { queryId, type: "DELIVERY" } });
    const res = await api().post(`/api/queries/${queryId}/create`).set("Cookie", cookie()).expect(422);
    expect(res.body.findings.some((f: { rule: string }) => f.rule === "R5" || f.rule === "R2")).toBe(true);
    const q = await prisma.query.findUnique({ where: { id: queryId }, select: { status: true } });
    expect(q?.status).toBe(QueryStatus.DRAFT);
  });

  it("returns derived freightMode/origin/destination + leg roll-ups on GET", async () => {
    const { queryId } = await validQuery();
    const res = await api().get(`/api/queries/${queryId}`).set("Cookie", cookie()).expect(200);
    expect(res.body.freightMode).toEqual(["ROAD"]);
    expect(res.body.origin[0].city).toBe("Mumbai");
    expect(res.body.destination[0].city).toBe("Pune");
    expect(res.body.legs[0].rollup.totalPackages).toBe(3);
    expect(res.body.legs[0].rollup.totalCbm).toBeCloseTo(3); // (1×1×1 m³)×3
    expect(res.body.legs[0].assignedCargoIds).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run Create Query + queries suites**

Run: `pnpm --filter @svyft/api test create-query-route && pnpm --filter @svyft/api test queries`
Expected: PASS. (If a prior `queries.e2e-spec.ts` assertion does an exact `toEqual` on the whole GET body, relax it to field assertions — the body now carries the extra derived fields.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/queries apps/api/test/create-query-route.e2e-spec.ts
git commit -m "feat(queries): full route-gated Create Query (fire legs → RFQ_READY) + derived-on-read fields"
```

---

## Task 10: Final integration — wiring check + full-suite verification

**Files:**
- Verify: `apps/api/src/app.module.ts` imports `PointsModule`, `LegsModule`, `RoutingModule`.
- No new production code; this task is the whole-branch green gate.

- [ ] **Step 1: Confirm module registration**

Read `apps/api/src/app.module.ts`; confirm the `imports` array contains `PointsModule`, `LegsModule`, `RoutingModule` (added in Tasks 4/5/6) and `ChangesModule` still precedes them. If any is missing, add it.

- [ ] **Step 2: Reset the DB to CI-equivalent (unseeded) + regenerate the client**

```bash
set -a; . apps/api/.env; set +a
pnpm --filter @svyft/api exec prisma migrate reset --schema ../../prisma/schema.prisma --force --skip-seed
```
Expected: all 5 migrations applied cleanly against a fresh DB; no seed.

- [ ] **Step 3: Run the full CI pipeline locally**

```bash
pnpm run ci
```
Expected: `lint`, `typecheck`, `test` (shared Vitest + API Jest), and `build` all PASS against the unseeded DB. Every Plan-5 spec seeds what it needs and self-cleans by prefix.

- [ ] **Step 4: Fix any failures, re-run, commit**

If anything fails, fix it (a real regression, not a test relaxation), re-run `pnpm run ci` until green. Commit any fixes:

```bash
git add -A
git commit -m "chore(plan-5): integration fixes; full CI green on a fresh unseeded DB"
```

- [ ] **Step 5: Push + watch CI**

```bash
git push -u origin feat/plan-5-points-legs-route
gh run watch
```
Expected: the GitHub Actions CI run is green.

---

## Self-Review Notes (for the plan author + final reviewer)

- **Spec coverage:** F1/F6 (Task 9 via `collectCreateFindings`); F2–F5 (Zod schemas, Tasks 1/existing); R1–R9, V-M1, T1–T3, C1–C3, E1 (Task 2 engine; E1 = the mediator re-running `validateRoute` on every edit, Tasks 6/8); §7.4.1 point types (Tasks 1/3/4); §7.4.2 leg spec incl. `legCode`/`executionStatus`/`totalChargeableWeight` null (Tasks 1/3/5); §8.5 hub MAX = T3 (Task 2); §9.1/§9.2 leg + query status (Tasks 1/5/7/9); §10 phases (Task 2); §11.3 cargo→leg scope (Task 8); §4.5 derived-on-read (Task 9); §5.2 all endpoints (Tasks 4/5/6/9).
- **Deferred (out of scope, untouched):** `manifestSnapshot`/`totalChargeableWeight` stay null; `NoopChangeLog` + `ChangeOrderStrategy` throw untouched; `ScopeResolver.downstreamWork ≡ false`; no UI/notifications.
- **Type consistency:** `LegSaveInput` keys (`originPointId`/`destinationPointId`/`assignedCargoIds`) match `legImpactMap` keys (Task 5) and the `legSaveSchema` (Task 1). `RouteGraph`/`RoutePoint`/`RouteLeg`/`RouteCargo` (Task 2) match `RoutingService.buildGraph`'s output (Task 6). `checkModeEndpoints` (Task 2) is reused by `LegsService.assertModeEndpoints` (Task 5). `deriveQueryStatus` milestone gate (`rfqReady`, Task 1) matches the projector's `{ rfqReady }` (Task 7).
