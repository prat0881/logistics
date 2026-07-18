# Stage 3 — Plan 3: Extensibility Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reusable **Extensibility Core** future stages plug into — the **Status Machine** (declarative transition registry + `StatusService.fire` with guards/effects, a `StatusTransition` log, and in-process domain events; derived query status as a pure projection) and the **Change-Impact mediator** (per-entity `ImpactRegistry` + the Free-path / Change-order fork + the `reopen` seam) — with generic types in `@svyft/shared` and the services + `StatusTransition` model in `apps/api`, wired to the Stage-3 slice: **leg `DRAFT ↔ READY_FOR_RFQ`**, **query status derived**, **Free path only**, and the **ChangeOrder strategy as a stub that can never fire**. Per Technical Design **§7** (Extensibility Core) and Functional Spec **§9** (status model) and **§11** (change model).

**Architecture:** Two new NestJS modules — `status` and `changes` — layered on the Plan 0–2 foundation (global `@Global` `PrismaModule`, global `JwtAuthGuard`+`RolesGuard`, `PrismaExceptionFilter`). The **pure, isomorphic core** (generic `Transition`/`Machine` types, status/event vocabularies, `deriveQueryStatus`, impact classes, `decidePath`) lives in `@svyft/shared`; the **stateful shell** (registries, `StatusService.fire`, the log-backed state store, the mediator + strategies, in-process events via `@nestjs/event-emitter`) lives in `apps/api`. `StatusService.fire` is the single door to any status change: it loads current state from the append-only `StatusTransition` log (authoritative, per §7.7), matches a declared transition, runs its guard/effect, appends the transition, and emits `${key}.status.changed`; a subscriber recomputes the derived query status. The `ChangeMediator` classifies every mutation, resolves whether downstream work exists (always **false** in Stage 3), and forks to the Free path (built) or the ChangeOrder stub (unreachable). Because the Leg/Query entities don't exist until Plan 5, the whole framework is proven now against **synthetic entity ids** through its public providers.

**Tech Stack:** NestJS 10 · Prisma 5 / PostgreSQL · `@nestjs/event-emitter` 2 (in-process domain events) · `zod` (shared, unchanged) · Vitest (shared units) / Jest + `@nestjs/testing` (api integration).

## Global Constraints

- Node `>=20 <21`; pnpm `9.x`; TypeScript `^5.6`, `strict`. Prettier: double quotes, semicolons, `trailingComma: all`, `printWidth: 100`.
- **API tests** use the `*.e2e-spec.ts` suffix (jest `testRegex`) and boot `AppModule` against the local dev Postgres (**port `5433`** on this machine; `apps/api/.env` already points there and holds `JWT_ACCESS_SECRET`). **Shared tests** are **Vitest** `*.test.ts` co-located in `packages/shared/src/`.
- **New dependency:** api only — `@nestjs/event-emitter@^2.0.4` (the NestJS-10-compatible 2.x line; pulls `eventemitter2` transitively). **No** new shared or web deps. **No web changes at all** in this plan.
- **Reuse, do not reinvent:** `PrismaService` is provided by the `@Global` `PrismaModule` (`apps/api/src/prisma/`) — new modules inject it **without** importing PrismaModule. `Finding` / `FindingScope` already exist in `@svyft/shared` ([findings.ts](packages/shared/src/findings.ts)) — the design's `Guard` returns `true | Finding[]`, so reuse them. Follow the `Role`/`MasterStatus` **const-object + string-union type + array** pattern for every new "enum" — **never** a TS `enum`.
- **Lint (tseslint recommended):** `@typescript-eslint/no-explicit-any` and `no-unused-vars` are **on**. Use typed generics (`Machine<string, string, FireContext>`), never `any`; prefix intentionally-unused params with `_` (e.g. `_scope`).
- **`@svyft/shared` resolution:** api **typecheck/build** resolve `@svyft/shared` from its **built `dist`** (its `package.json` `main`/`types`). After editing shared, run `pnpm --filter @svyft/shared build` **before** any api `typecheck`/`build`. api **jest** maps `@svyft/shared` → `packages/shared/src/index.ts` directly (no rebuild needed to run api tests).
- **No new HTTP endpoints or controllers** — there is no Query/Leg entity to mutate yet. The framework is exercised through its **public providers** (`StatusService`, `ChangeMediator`, and the registries) in integration `*.e2e-spec.ts` specs (the [masters-model.e2e-spec.ts](apps/api/test/masters-model.e2e-spec.ts) pattern: boot `AppModule`, `moduleRef.get(Provider)`), plus pure Vitest units in `@svyft/shared`.
- **Migrations:** third migration (`status_transition`). Run `prisma migrate dev` against **local** Postgres only; CI/prod apply via `prisma migrate deploy`. **Verify the whole branch against a fresh `prisma migrate reset --force --skip-seed` DB before pushing** (CI runs **unseeded**) — every new test MUST be seed-independent and self-cleaning (delete its own rows in `beforeAll`/`afterAll` by a unique prefix).
- **Scope boundaries (deferred, do NOT build):** real `Leg.status`/`Query.status` columns & a column-backed state store; cargo→leg scope fan-out; real `validateRoute` revalidation; the real ChangeOrder cascade + durable change-log sink; query-status **persistence**. All Plan 4/5. Ship the **ports/stubs** now so they drop in later without re-plumbing.
- Commit messages: Conventional Commits. Branch `feat/plan-3-extensibility` (off `main`); plan doc + implementation ship as one PR.

---

### Task 1: Prisma schema — `StatusTransition` model + migration #3

**Files:**
- Modify: `prisma/schema.prisma` (append; leave everything else untouched)
- Create: `prisma/migrations/<timestamp>_status_transition/migration.sql` (generated by `migrate dev`)
- Test: `apps/api/test/status-transition-model.e2e-spec.ts`

**Interfaces:**
- Produces the `StatusTransition` model: `id` (uuid PK), nullable `tenantId` (uuid), `seq` (auto-increment `Int`, `@unique` — monotonic append order), `entity` (String), `entityId` (String — polymorphic, **not** uuid-typed so synthetic ids work), `from` (nullable String), `to` (String), `event` (String), `actorId` (nullable uuid — null = system-authored), `at` (DateTime default now). Consumed by Task 4 (`LogBackedStateStore.load`, `StatusService.fire`).

- [ ] **Step 1: Write the failing test**

`apps/api/test/status-transition-model.e2e-spec.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const ENTITY_ID = "p3-model-leg-1";

describe("StatusTransition model (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.statusTransition.deleteMany({ where: { entityId: ENTITY_ID } });
  });

  afterAll(async () => {
    await prisma.statusTransition.deleteMany({ where: { entityId: ENTITY_ID } });
    await app.close();
  });

  it("appends rows with a monotonic seq and reads the latest by (entity, entityId)", async () => {
    const a = await prisma.statusTransition.create({
      data: { entity: "leg", entityId: ENTITY_ID, from: null, to: "DRAFT", event: "create" },
    });
    const b = await prisma.statusTransition.create({
      data: { entity: "leg", entityId: ENTITY_ID, from: "DRAFT", to: "READY_FOR_RFQ", event: "validate.pass" },
    });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(a.actorId).toBeNull(); // system-authored default

    const latest = await prisma.statusTransition.findFirst({
      where: { entity: "leg", entityId: ENTITY_ID },
      orderBy: { seq: "desc" },
    });
    expect(latest?.to).toBe("READY_FOR_RFQ");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @svyft/api test -- test/status-transition-model.e2e-spec.ts`
Expected: FAIL — `prisma.statusTransition` does not exist on the client.

- [ ] **Step 3: Append the model to `prisma/schema.prisma`**

Append at the end (do **not** touch existing `generator`/`datasource`/enums/models):
```prisma
model StatusTransition {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String?  @db.Uuid
  seq       Int      @unique @default(autoincrement())
  entity    String
  entityId  String
  from      String?
  to        String
  event     String
  actorId   String?  @db.Uuid
  at        DateTime @default(now())

  @@index([entity, entityId])
  @@index([tenantId])
}
```

- [ ] **Step 4: Generate the migration + Prisma client (local DB)**

Run (from repo root, with the dev Postgres up on `:5433` and `apps/api/.env` exporting the DB URLs):
```bash
set -a; . apps/api/.env; set +a
pnpm exec prisma migrate dev --name status_transition --schema prisma/schema.prisma
```
Expected: a new `prisma/migrations/<timestamp>_status_transition/` folder is created and applied; the client regenerates (now exposes `prisma.statusTransition`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @svyft/api test -- test/status-transition-model.e2e-spec.ts`
Expected: PASS (2 rows created, `b.seq > a.seq`, latest `to === "READY_FOR_RFQ"`).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations apps/api/test/status-transition-model.e2e-spec.ts
git commit -m "feat(status): add append-only StatusTransition model + migration"
```

---

### Task 2: `@svyft/shared` — Status Machine framework (generics, vocabularies, pure helpers)

**Files:**
- Create: `packages/shared/src/status.ts`
- Create: `packages/shared/src/status.test.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./status";`)

**Interfaces:**
- Consumes: `Finding` from `./findings`.
- Produces (all imported by Task 4):
  - Types: `Guard<C> = (ctx: C) => true | Finding[]`, `Effect<C> = (ctx: C) => Promise<void>`, `TransitionKind = "forward" | "reopen"`, `Transition<S extends string, E extends string, C>` (`{ from: S | S[]; on: E; to: S; guard?: Guard<C>; effect?: Effect<C>; kind?: TransitionKind }`), `Machine<S extends string, E extends string, C>` (`{ key: string; initial: S; transitions: Transition<S,E,C>[] }`).
  - Vocabularies (const-object + type + array): `LegStatus` (DRAFT, READY_FOR_RFQ, RFQ_SENT, PARTIALLY_QUOTED, FULLY_QUOTED, AWARDED, IN_TRANSIT, DELIVERED, CLOSED) + `LEG_STATUSES`; `LegEvent` (`VALIDATE_PASS="validate.pass"`, `REOPEN="reopen"`); `QueryStatus` (DRAFT, CREATED, RFQ_READY, RFQ_SENT, QUOTED, AWAITING_CLIENT_DECISION, WON, LOST, CLOSED); `QueryMilestones` interface.
  - Pure fns: `findTransition<S,E,C>(machine, current: S, event: E): Transition<S,E,C> | undefined`; `deriveQueryStatus(legStatuses: LegStatus[], milestones?: QueryMilestones): QueryStatus`.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/status.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  findTransition,
  deriveQueryStatus,
  LegStatus,
  LegEvent,
  QueryStatus,
  type Machine,
} from "./status";

interface Ctx {
  routeValid?: boolean;
}

const legMachine: Machine<LegStatus, LegEvent, Ctx> = {
  key: "leg",
  initial: LegStatus.DRAFT,
  transitions: [
    { from: LegStatus.DRAFT, on: LegEvent.VALIDATE_PASS, to: LegStatus.READY_FOR_RFQ, kind: "forward" },
    { from: LegStatus.READY_FOR_RFQ, on: LegEvent.REOPEN, to: LegStatus.DRAFT, kind: "reopen" },
  ],
};

describe("findTransition", () => {
  it("matches the forward edge from a scalar `from`", () => {
    expect(findTransition(legMachine, LegStatus.DRAFT, LegEvent.VALIDATE_PASS)?.to).toBe(
      LegStatus.READY_FOR_RFQ,
    );
  });

  it("matches the reopen reverse edge", () => {
    expect(findTransition(legMachine, LegStatus.READY_FOR_RFQ, LegEvent.REOPEN)?.to).toBe(
      LegStatus.DRAFT,
    );
  });

  it("returns undefined for an illegal (from,event) pair", () => {
    expect(findTransition(legMachine, LegStatus.DRAFT, LegEvent.REOPEN)).toBeUndefined();
  });

  it("matches an array `from` (multiple source states)", () => {
    const m: Machine<LegStatus, LegEvent, Ctx> = {
      key: "leg",
      initial: LegStatus.DRAFT,
      transitions: [
        {
          from: [LegStatus.RFQ_SENT, LegStatus.FULLY_QUOTED],
          on: LegEvent.REOPEN,
          to: LegStatus.READY_FOR_RFQ,
        },
      ],
    };
    expect(findTransition(m, LegStatus.FULLY_QUOTED, LegEvent.REOPEN)?.to).toBe(
      LegStatus.READY_FOR_RFQ,
    );
  });
});

describe("deriveQueryStatus (least-advanced gate + milestones, §9.1)", () => {
  it("is DRAFT with no legs", () => {
    expect(deriveQueryStatus([])).toBe(QueryStatus.DRAFT);
  });

  it("is gated by the least-advanced leg", () => {
    expect(deriveQueryStatus([LegStatus.DRAFT, LegStatus.READY_FOR_RFQ])).toBe(QueryStatus.DRAFT);
  });

  it("is CREATED when all legs are READY_FOR_RFQ and Create Query has not run", () => {
    expect(deriveQueryStatus([LegStatus.READY_FOR_RFQ, LegStatus.READY_FOR_RFQ])).toBe(
      QueryStatus.CREATED,
    );
  });

  it("is RFQ_READY when all legs are READY_FOR_RFQ and the created milestone is set", () => {
    expect(deriveQueryStatus([LegStatus.READY_FOR_RFQ], { created: true })).toBe(
      QueryStatus.RFQ_READY,
    );
  });

  it("is RFQ_SENT when the least leg is RFQ_SENT/PARTIALLY_QUOTED", () => {
    expect(deriveQueryStatus([LegStatus.RFQ_SENT, LegStatus.FULLY_QUOTED])).toBe(
      QueryStatus.RFQ_SENT,
    );
  });

  it("is QUOTED when all legs are FULLY_QUOTED", () => {
    expect(deriveQueryStatus([LegStatus.FULLY_QUOTED, LegStatus.FULLY_QUOTED])).toBe(
      QueryStatus.QUOTED,
    );
  });

  it("lets query-level milestones override the leg rollup", () => {
    expect(deriveQueryStatus([LegStatus.READY_FOR_RFQ], { closed: true })).toBe(QueryStatus.CLOSED);
    expect(deriveQueryStatus([LegStatus.FULLY_QUOTED], { won: true })).toBe(QueryStatus.WON);
    expect(deriveQueryStatus([LegStatus.RFQ_SENT], { lost: true })).toBe(QueryStatus.LOST);
    expect(deriveQueryStatus([LegStatus.RFQ_SENT], { awaitingClientDecision: true })).toBe(
      QueryStatus.AWAITING_CLIENT_DECISION,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @svyft/shared test -- status`
Expected: FAIL — cannot resolve `./status`.

- [ ] **Step 3: Implement `packages/shared/src/status.ts`**

```ts
import type { Finding } from "./findings";

// ── Generic state-machine primitives (Technical Design §7.2) ───────────────────
// A guard returns `true` to allow, or `Finding[]` explaining WHY it is blocked.
export type Guard<C> = (ctx: C) => true | Finding[];
export type Effect<C> = (ctx: C) => Promise<void>;
export type TransitionKind = "forward" | "reopen";

export interface Transition<S extends string, E extends string, C> {
  from: S | S[];
  on: E;
  to: S;
  guard?: Guard<C>;
  effect?: Effect<C>;
  kind?: TransitionKind;
}

export interface Machine<S extends string, E extends string, C> {
  key: string;
  initial: S;
  transitions: Transition<S, E, C>[];
}

// Pure matcher — the only place "which edge fires" is decided. Used by StatusService.fire.
export function findTransition<S extends string, E extends string, C>(
  machine: Machine<S, E, C>,
  current: S,
  event: E,
): Transition<S, E, C> | undefined {
  return machine.transitions.find(
    (t) => t.on === event && (Array.isArray(t.from) ? t.from.includes(current) : t.from === current),
  );
}

// ── Leg status vocabulary (§9.2) ───────────────────────────────────────────────
// Full vocabulary declared centrally; Stage 3 activates only DRAFT ↔ READY_FOR_RFQ.
export const LegStatus = {
  DRAFT: "DRAFT",
  READY_FOR_RFQ: "READY_FOR_RFQ",
  RFQ_SENT: "RFQ_SENT",
  PARTIALLY_QUOTED: "PARTIALLY_QUOTED",
  FULLY_QUOTED: "FULLY_QUOTED",
  AWARDED: "AWARDED",
  IN_TRANSIT: "IN_TRANSIT",
  DELIVERED: "DELIVERED",
  CLOSED: "CLOSED",
} as const;
export type LegStatus = (typeof LegStatus)[keyof typeof LegStatus];
export const LEG_STATUSES = Object.values(LegStatus) as [LegStatus, ...LegStatus[]];

export const LegEvent = {
  VALIDATE_PASS: "validate.pass",
  REOPEN: "reopen",
} as const;
export type LegEvent = (typeof LegEvent)[keyof typeof LegEvent];

// ── Query status vocabulary (§9.1) — derived/rollup, never hand-set ─────────────
export const QueryStatus = {
  DRAFT: "DRAFT",
  CREATED: "CREATED",
  RFQ_READY: "RFQ_READY",
  RFQ_SENT: "RFQ_SENT",
  QUOTED: "QUOTED",
  AWAITING_CLIENT_DECISION: "AWAITING_CLIENT_DECISION",
  WON: "WON",
  LOST: "LOST",
  CLOSED: "CLOSED",
} as const;
export type QueryStatus = (typeof QueryStatus)[keyof typeof QueryStatus];

// Query-level milestones layered on top of the leg rollup (client-facing events
// that legs never have): Created, Awaiting Client Decision, Won, Lost, Closed.
export interface QueryMilestones {
  created?: boolean;
  awaitingClientDecision?: boolean;
  won?: boolean;
  lost?: boolean;
  closed?: boolean;
}

const LEG_RANK: Record<LegStatus, number> = {
  DRAFT: 0,
  READY_FOR_RFQ: 1,
  RFQ_SENT: 2,
  PARTIALLY_QUOTED: 3,
  FULLY_QUOTED: 4,
  AWARDED: 5,
  IN_TRANSIT: 6,
  DELIVERED: 7,
  CLOSED: 8,
};

function leastAdvanced(legStatuses: LegStatus[]): LegStatus {
  return legStatuses.reduce((m, s) => (LEG_RANK[s] < LEG_RANK[m] ? s : m), legStatuses[0]);
}

// Derived query status: query-level milestones win; otherwise the least-advanced
// leg gates the rollup (the query only advances when ALL legs have, §9.1).
export function deriveQueryStatus(
  legStatuses: LegStatus[],
  milestones: QueryMilestones = {},
): QueryStatus {
  if (milestones.closed) return QueryStatus.CLOSED;
  if (milestones.lost) return QueryStatus.LOST;
  if (milestones.won) return QueryStatus.WON;
  if (milestones.awaitingClientDecision) return QueryStatus.AWAITING_CLIENT_DECISION;
  if (legStatuses.length === 0) return QueryStatus.DRAFT;

  switch (leastAdvanced(legStatuses)) {
    case LegStatus.DRAFT:
      return QueryStatus.DRAFT;
    case LegStatus.READY_FOR_RFQ:
      return milestones.created ? QueryStatus.RFQ_READY : QueryStatus.CREATED;
    case LegStatus.RFQ_SENT:
    case LegStatus.PARTIALLY_QUOTED:
      return QueryStatus.RFQ_SENT;
    case LegStatus.FULLY_QUOTED:
      return QueryStatus.QUOTED;
    case LegStatus.CLOSED:
      return QueryStatus.CLOSED;
    default:
      // AWARDED / IN_TRANSIT / DELIVERED — driven by milestones + later stages.
      return QueryStatus.QUOTED;
  }
}
```

- [ ] **Step 4: Add the barrel export**

Modify `packages/shared/src/index.ts` — add after the existing exports:
```ts
export * from "./status";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @svyft/shared test -- status`
Expected: PASS (all `findTransition` + `deriveQueryStatus` cases green).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/status.ts packages/shared/src/status.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): status machine generics, vocabularies, deriveQueryStatus"
```

---

### Task 3: `@svyft/shared` — Change-Impact framework (impact classes, `ChangeRequest`, `decidePath`)

**Files:**
- Create: `packages/shared/src/change.ts`
- Create: `packages/shared/src/change.test.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./change";`)

**Interfaces:**
- Consumes: `FindingScope` from `./findings`.
- Produces (imported by Task 5):
  - `ImpactClass` (const-object: `Internal, Corrective, RfqDefining, PricingAwardDefining, Structural`) + type; `IMPACT_RANK: Record<ImpactClass, number>` (0..4 in that order).
  - `ImpactPath = "free" | "change-order"`.
  - `ChangeRequest` (`{ entity: string; id: string; field?: string; action?: "@create" | "@delete"; patch?: Record<string, unknown>; queryId?: string; actorId?: string | null; reason?: string }`).
  - `ImpactDecision` (`{ class: ImpactClass; scope: FindingScope[]; path: ImpactPath }`).
  - `decidePath(impactClass: ImpactClass, hasDownstreamWork: boolean): ImpactPath`.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/change.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ImpactClass, IMPACT_RANK, decidePath } from "./change";

describe("IMPACT_RANK ordering (§11.1, by downstream cost)", () => {
  it("orders Internal < Corrective < RfqDefining < PricingAwardDefining < Structural", () => {
    expect(IMPACT_RANK.Internal).toBeLessThan(IMPACT_RANK.Corrective);
    expect(IMPACT_RANK.Corrective).toBeLessThan(IMPACT_RANK.RfqDefining);
    expect(IMPACT_RANK.RfqDefining).toBeLessThan(IMPACT_RANK.PricingAwardDefining);
    expect(IMPACT_RANK.PricingAwardDefining).toBeLessThan(IMPACT_RANK.Structural);
  });
});

describe("decidePath (§7.3 fork, §11.2/§11.4)", () => {
  it("takes the Free path whenever there is no downstream work — any class (pre-RFQ)", () => {
    expect(decidePath(ImpactClass.Internal, false)).toBe("free");
    expect(decidePath(ImpactClass.RfqDefining, false)).toBe("free");
    expect(decidePath(ImpactClass.Structural, false)).toBe("free");
  });

  it("takes the Change-order path only for RfqDefining-or-heavier WITH downstream work", () => {
    expect(decidePath(ImpactClass.RfqDefining, true)).toBe("change-order");
    expect(decidePath(ImpactClass.PricingAwardDefining, true)).toBe("change-order");
    expect(decidePath(ImpactClass.Structural, true)).toBe("change-order");
  });

  it("keeps Internal/Corrective on the Free path even WITH downstream work (class still gates, §7.5)", () => {
    expect(decidePath(ImpactClass.Internal, true)).toBe("free");
    expect(decidePath(ImpactClass.Corrective, true)).toBe("free"); // e.g. a legName typo post-RFQ
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @svyft/shared test -- change`
Expected: FAIL — cannot resolve `./change`.

- [ ] **Step 3: Implement `packages/shared/src/change.ts`**

```ts
import type { FindingScope } from "./findings";

// Impact classes (§11.1), ordered by downstream cost.
export const ImpactClass = {
  Internal: "Internal",
  Corrective: "Corrective",
  RfqDefining: "RfqDefining",
  PricingAwardDefining: "PricingAwardDefining",
  Structural: "Structural",
} as const;
export type ImpactClass = (typeof ImpactClass)[keyof typeof ImpactClass];

// Numeric rank so the fork can compare "RfqDefining-or-heavier".
export const IMPACT_RANK: Record<ImpactClass, number> = {
  Internal: 0,
  Corrective: 1,
  RfqDefining: 2,
  PricingAwardDefining: 3,
  Structural: 4,
};

export type ImpactPath = "free" | "change-order";

// A mutation flowing through the mediator. `field` for a field edit; `action`
// for structural add/remove. `queryId` names the owning query for revalidation.
export interface ChangeRequest {
  entity: string;
  id: string;
  field?: string;
  action?: "@create" | "@delete";
  patch?: Record<string, unknown>;
  queryId?: string;
  actorId?: string | null;
  reason?: string;
}

export interface ImpactDecision {
  class: ImpactClass;
  scope: FindingScope[];
  path: ImpactPath;
}

// The fork (§7.3, §11.2/§11.4): a change is FREE unless it is RfqDefining-or-heavier
// AND targets a scope that already has downstream work. Pre-RFQ (no downstream work)
// everything is Free; Internal/Corrective stay Free even post-RFQ (class still gates).
export function decidePath(impactClass: ImpactClass, hasDownstreamWork: boolean): ImpactPath {
  const rfqDefiningOrHeavier = IMPACT_RANK[impactClass] >= IMPACT_RANK.RfqDefining;
  return rfqDefiningOrHeavier && hasDownstreamWork ? "change-order" : "free";
}
```

- [ ] **Step 4: Add the barrel export**

Modify `packages/shared/src/index.ts` — add:
```ts
export * from "./change";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @svyft/shared test -- change`
Expected: PASS.

- [ ] **Step 6: Rebuild shared + full shared checks + commit**

```bash
pnpm --filter @svyft/shared build       # api typecheck later needs the fresh dist
pnpm --filter @svyft/shared test        # full shared suite green
pnpm --filter @svyft/shared typecheck
git add packages/shared/src/change.ts packages/shared/src/change.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): impact classes, ChangeRequest, decidePath fork"
```

---

### Task 4: `status` module — registry, leg machine, log-backed store, `StatusService.fire`, events, projector

**Files:**
- Create: `apps/api/src/modules/status/status.types.ts`
- Create: `apps/api/src/modules/status/errors.ts`
- Create: `apps/api/src/modules/status/leg.machine.ts`
- Create: `apps/api/src/modules/status/status.registry.ts`
- Create: `apps/api/src/modules/status/state-store.ts`
- Create: `apps/api/src/modules/status/status.service.ts`
- Create: `apps/api/src/modules/status/query-status.projector.ts`
- Create: `apps/api/src/modules/status/status.module.ts`
- Modify: `apps/api/package.json` (add `@nestjs/event-emitter`)
- Modify: `apps/api/src/app.module.ts` (register `EventEmitterModule.forRoot()` + `StatusModule`)
- Test: `apps/api/test/status-machine.e2e-spec.ts`

**Interfaces:**
- Consumes: `Machine`, `Transition`, `Finding`, `LegStatus`, `LegEvent`, `findTransition`, `deriveQueryStatus`, `QueryMilestones` from `@svyft/shared` (Tasks 2/1); `PrismaService`; `Prisma.TransactionClient` from `@prisma/client`; `EventEmitter2`/`OnEvent`/`EventEmitterModule` from `@nestjs/event-emitter`.
- Produces (exported by `StatusModule`, consumed by later plans):
  - `FireContext` (`status.types.ts`): `{ actorId?: string | null; tenantId?: string | null; queryId?: string; routeValid?: boolean; findings?: Finding[]; tx?: Prisma.TransactionClient; [k: string]: unknown }`; `StatusMachine = Machine<string, string, FireContext>`.
  - `IllegalTransitionError`, `TransitionBlockedError(findings: Finding[])` (`errors.ts`).
  - `legMachine: Machine<LegStatus, LegEvent, FireContext>` + `legTransitions` (`leg.machine.ts`).
  - `StatusRegistry` with `register(m: StatusMachine)`, `contribute(key: string, transitions: StatusMachine["transitions"])`, `get(key): StatusMachine`.
  - `STATUS_STATE_STORE` token + `StatusStateStore` interface (`load(entity, entityId, tx): Promise<string | null>`) + `LogBackedStateStore`.
  - `StatusService.fire(key: string, entityId: string, event: string, ctx?: FireContext): Promise<FireResult>` where `FireResult = { entity; entityId; from: string; to: string; event: string; transitionId: string }`; `StatusChangedEvent` payload type.
  - `QueryStatusProjector` (`@OnEvent("leg.status.changed")` → `recompute(queryId?)`; `project(legStatuses, milestones?)`).

- [ ] **Step 1: Add the `@nestjs/event-emitter` dependency**

Run:
```bash
pnpm --filter @svyft/api add @nestjs/event-emitter@^2.0.4
```
Expected: `apps/api/package.json` gains `"@nestjs/event-emitter": "^2.0.4"` (2.x is the NestJS-10-compatible line); `pnpm-lock.yaml` updates.

- [ ] **Step 2: Write the failing test**

`apps/api/test/status-machine.e2e-spec.ts`:
```ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Finding } from "@svyft/shared";
import { LegEvent, LegStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { StatusService } from "../src/modules/status/status.service";
import { QueryStatusProjector } from "../src/modules/status/query-status.projector";
import {
  IllegalTransitionError,
  TransitionBlockedError,
} from "../src/modules/status/errors";

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
      await status.fire("leg", id, LegEvent.VALIDATE_PASS, { routeValid: false, findings: [finding] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TransitionBlockedError);
    expect((err as TransitionBlockedError).findings).toEqual([finding]);
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @svyft/api test -- test/status-machine.e2e-spec.ts`
Expected: FAIL — `../src/modules/status/status.service` and siblings do not exist.

- [ ] **Step 4: Implement `status.types.ts`**

```ts
import type { Machine } from "@svyft/shared";
import type { Finding } from "@svyft/shared";
import type { Prisma } from "@prisma/client";

// Context handed to a transition's guard/effect during StatusService.fire.
// Guards are pure (they read routeValid/findings); `tx` is present so effects can
// run inside fire's transaction. The index signature keeps it open for future
// stages' domain data without editing this type.
export interface FireContext {
  actorId?: string | null;
  tenantId?: string | null;
  queryId?: string;
  routeValid?: boolean;
  findings?: Finding[];
  tx?: Prisma.TransactionClient;
  [k: string]: unknown;
}

// All machines share the fire context, so the registry can store them uniformly.
export type StatusMachine = Machine<string, string, FireContext>;
```

- [ ] **Step 5: Implement `errors.ts`**

```ts
import type { Finding } from "@svyft/shared";

export class IllegalTransitionError extends Error {
  constructor(
    public readonly key: string,
    public readonly from: string,
    public readonly event: string,
  ) {
    super(`No '${event}' transition from '${from}' on machine '${key}'`);
    this.name = "IllegalTransitionError";
  }
}

export class TransitionBlockedError extends Error {
  constructor(public readonly findings: Finding[]) {
    super(`Transition blocked by ${findings.length} finding(s)`);
    this.name = "TransitionBlockedError";
  }
}
```

- [ ] **Step 6: Implement `leg.machine.ts`**

```ts
import type { Machine, Transition } from "@svyft/shared";
import { LegEvent, LegStatus } from "@svyft/shared";
import type { FireContext } from "./status.types";

// Stage-3 leg slice (§7.2, §9.2). Full state vocabulary is declared in
// `@svyft/shared`; only these two edges are active now:
//   DRAFT --validate.pass [guard: route valid]--> READY_FOR_RFQ   (forward)
//   READY_FOR_RFQ --reopen--> DRAFT                                (reopen; the seam)
// The forward guard consumes ctx.routeValid (Plan 5 supplies it from validateRoute);
// when false it blocks with ctx.findings (or a default blocking finding).
export const legTransitions: Transition<LegStatus, LegEvent, FireContext>[] = [
  {
    from: LegStatus.DRAFT,
    on: LegEvent.VALIDATE_PASS,
    to: LegStatus.READY_FOR_RFQ,
    kind: "forward",
    guard: (ctx) =>
      ctx.routeValid === true
        ? true
        : (ctx.findings ?? [
            {
              rule: "C1",
              severity: "blocking",
              scope: { type: "leg" },
              message: "Leg is incomplete or its route is not valid",
            },
          ]),
  },
  {
    from: LegStatus.READY_FOR_RFQ,
    on: LegEvent.REOPEN,
    to: LegStatus.DRAFT,
    kind: "reopen",
  },
];

export const legMachine: Machine<LegStatus, LegEvent, FireContext> = {
  key: "leg",
  initial: LegStatus.DRAFT,
  transitions: legTransitions,
};
```

- [ ] **Step 7: Implement `status.registry.ts`**

```ts
import { Injectable } from "@nestjs/common";
import type { StatusMachine } from "./status.types";

// Holds one machine per key. The state vocabulary is central (shared); transition
// EDGES are contributed by the owning stage — Stage 4+ call `contribute(...)` to
// append forward/reopen edges without touching Stage 3.
@Injectable()
export class StatusRegistry {
  private readonly machines = new Map<string, StatusMachine>();

  register(machine: StatusMachine): void {
    this.machines.set(machine.key, machine);
  }

  contribute(key: string, transitions: StatusMachine["transitions"]): void {
    this.get(key).transitions.push(...transitions);
  }

  get(key: string): StatusMachine {
    const machine = this.machines.get(key);
    if (!machine) throw new Error(`No status machine registered for key '${key}'`);
    return machine;
  }
}
```

- [ ] **Step 8: Implement `state-store.ts`**

```ts
import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

// How fire learns an entity's current state. Stage 3 ships the log-backed default:
// the latest StatusTransition.to is authoritative (the Stage-4 cascade reads prior
// state from the log too, §7.7). Plan 5 may register a column-backed Leg store.
export interface StatusStateStore {
  load(entity: string, entityId: string, tx: Prisma.TransactionClient): Promise<string | null>;
}

export const STATUS_STATE_STORE = Symbol("STATUS_STATE_STORE");

@Injectable()
export class LogBackedStateStore implements StatusStateStore {
  async load(
    entity: string,
    entityId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const last = await tx.statusTransition.findFirst({
      where: { entity, entityId },
      orderBy: { seq: "desc" },
      select: { to: true },
    });
    return last?.to ?? null;
  }
}
```

- [ ] **Step 9: Implement `status.service.ts`**

```ts
import { Inject, Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { findTransition } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { StatusRegistry } from "./status.registry";
import { STATUS_STATE_STORE, type StatusStateStore } from "./state-store";
import { IllegalTransitionError, TransitionBlockedError } from "./errors";
import type { FireContext } from "./status.types";

export interface StatusChangedEvent {
  entity: string;
  entityId: string;
  from: string;
  to: string;
  event: string;
  actorId: string | null;
  queryId?: string;
}

export interface FireResult {
  entity: string;
  entityId: string;
  from: string;
  to: string;
  event: string;
  transitionId: string;
}

// THE ONE DOOR to any owned status change (§7.2). load → match → guard → append
// StatusTransition (same tx) → run effect (same tx) → emit after commit.
@Injectable()
export class StatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: StatusRegistry,
    @Inject(STATUS_STATE_STORE) private readonly store: StatusStateStore,
    private readonly events: EventEmitter2,
  ) {}

  async fire(
    key: string,
    entityId: string,
    event: string,
    ctx: FireContext = {},
  ): Promise<FireResult> {
    const machine = this.registry.get(key);

    const { from, to, transitionId } = await this.prisma.$transaction(async (tx) => {
      const current = (await this.store.load(key, entityId, tx)) ?? machine.initial;

      const transition = findTransition(machine, current, event);
      if (!transition) throw new IllegalTransitionError(key, current, event);

      const guardResult = transition.guard ? transition.guard({ ...ctx, tx }) : true;
      if (guardResult !== true) throw new TransitionBlockedError(guardResult);

      const row = await tx.statusTransition.create({
        data: {
          entity: key,
          entityId,
          from: current,
          to: transition.to,
          event,
          actorId: ctx.actorId ?? null,
          tenantId: ctx.tenantId ?? null,
        },
      });

      if (transition.effect) await transition.effect({ ...ctx, tx });

      return { from: current, to: transition.to, transitionId: row.id };
    });

    // Emit AFTER commit so subscribers observe committed state.
    const payload: StatusChangedEvent = {
      entity: key,
      entityId,
      from,
      to,
      event,
      actorId: ctx.actorId ?? null,
      queryId: ctx.queryId,
    };
    this.events.emit(`${key}.status.changed`, payload);

    return { entity: key, entityId, from, to, event, transitionId };
  }
}
```

- [ ] **Step 10: Implement `query-status.projector.ts`**

```ts
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { deriveQueryStatus } from "@svyft/shared";
import type { LegStatus, QueryMilestones, QueryStatus } from "@svyft/shared";
import type { StatusChangedEvent } from "./status.service";

// Derived/rollup query status is a PROJECTION, not a machine (§7.2). This subscriber
// recomputes it whenever a leg status changes. Plan 3 has no Query/Leg tables yet, so
// `recompute` records intent; Plan 5 loads the query's leg statuses + milestones and
// persists Query.status via `project()`.
@Injectable()
export class QueryStatusProjector {
  private readonly logger = new Logger(QueryStatusProjector.name);

  project(legStatuses: LegStatus[], milestones: QueryMilestones = {}): QueryStatus {
    return deriveQueryStatus(legStatuses, milestones);
  }

  @OnEvent("leg.status.changed")
  async onLegStatusChanged(event: StatusChangedEvent): Promise<void> {
    await this.recompute(event.queryId);
  }

  async recompute(queryId?: string): Promise<void> {
    if (!queryId) return;
    // Plan 5:
    //   const legs = await prisma.leg.findMany({ where: { queryId } });
    //   const status = this.project(legs.map((l) => l.status as LegStatus), milestones);
    //   await prisma.query.update({ where: { id: queryId }, data: { status } });
    this.logger.debug(`recompute query status for ${queryId} (persistence lands in Plan 5)`);
  }
}
```

- [ ] **Step 11: Implement `status.module.ts`**

```ts
import { Module, type OnModuleInit } from "@nestjs/common";
import { StatusRegistry } from "./status.registry";
import { StatusService } from "./status.service";
import { QueryStatusProjector } from "./query-status.projector";
import { STATUS_STATE_STORE, LogBackedStateStore } from "./state-store";
import { legMachine } from "./leg.machine";
import type { StatusMachine } from "./status.types";

@Module({
  providers: [
    StatusRegistry,
    StatusService,
    QueryStatusProjector,
    { provide: STATUS_STATE_STORE, useClass: LogBackedStateStore },
  ],
  exports: [StatusService, StatusRegistry],
})
export class StatusModule implements OnModuleInit {
  constructor(private readonly registry: StatusRegistry) {}

  onModuleInit(): void {
    // The legs module owns these edges; registered here until it lands (Plan 5).
    this.registry.register(legMachine as StatusMachine);
  }
}
```

- [ ] **Step 12: Wire `EventEmitterModule` + `StatusModule` into `AppModule`**

Modify `apps/api/src/app.module.ts` — add the imports and register both. The result:
```ts
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "node:path";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./modules/auth/auth.module";
import { HealthModule } from "./modules/health/health.module";
import { ClientsModule } from "./modules/clients/clients.module";
import { VesselsModule } from "./modules/vessels/vessels.module";
import { ConfigDataModule } from "./modules/config/config-data.module";
import { StatusModule } from "./modules/status/status.module";

const staticImports =
  process.env.SERVE_STATIC === "true"
    ? [
        ServeStaticModule.forRoot({
          rootPath: join(__dirname, "..", "client"),
          exclude: ["/api/(.*)"],
        }),
      ]
    : [];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ...staticImports,
    PrismaModule,
    AuthModule,
    ClientsModule,
    VesselsModule,
    ConfigDataModule,
    StatusModule,
    HealthModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 13: Run the test to verify it passes**

Run: `pnpm --filter @svyft/api test -- test/status-machine.e2e-spec.ts`
Expected: PASS (forward, guard-blocked, illegal, reopen, event→projector, pure projection).

- [ ] **Step 14: Typecheck the api (needs shared's dist) + commit**

```bash
pnpm --filter @svyft/shared build
pnpm --filter @svyft/api typecheck
git add apps/api/src/modules/status apps/api/src/app.module.ts apps/api/package.json pnpm-lock.yaml apps/api/test/status-machine.e2e-spec.ts
git commit -m "feat(status): StatusService.fire, registry, log-backed store, query projector"
```

---

### Task 5: `changes` module — ImpactRegistry, classifier, resolver, mediator, Free path + ChangeOrder stub

**Files:**
- Create: `apps/api/src/modules/changes/impact.registry.ts`
- Create: `apps/api/src/modules/changes/leg.impact.ts`
- Create: `apps/api/src/modules/changes/impact.classifier.ts`
- Create: `apps/api/src/modules/changes/scope.resolver.ts`
- Create: `apps/api/src/modules/changes/change-log.ts`
- Create: `apps/api/src/modules/changes/route-validator.ts`
- Create: `apps/api/src/modules/changes/errors.ts`
- Create: `apps/api/src/modules/changes/free-path.strategy.ts`
- Create: `apps/api/src/modules/changes/change-order.strategy.ts`
- Create: `apps/api/src/modules/changes/change-mediator.ts`
- Create: `apps/api/src/modules/changes/changes.module.ts`
- Modify: `apps/api/src/app.module.ts` (register `ChangesModule`)
- Test: `apps/api/test/change-mediator.e2e-spec.ts`

**Interfaces:**
- Consumes: `ImpactClass`, `IMPACT_RANK`, `decidePath`, `ChangeRequest`, `ImpactDecision`, `Finding`, `FindingScope` from `@svyft/shared` (Task 3); `PrismaService`; `Prisma.TransactionClient`.
- Produces (exported by `ChangesModule`):
  - `EntityImpactMap = Record<string, ImpactClass>`; `ImpactRegistry.declare(entity, map)`, `classOf(entity, key): ImpactClass | undefined`.
  - `legImpactMap: EntityImpactMap` (leg field classes, §7.3).
  - `ImpactClassifier.classify(req): { class: ImpactClass; scope: FindingScope[] }`.
  - `ScopeResolver.downstreamWork(scope: FindingScope[]): Promise<boolean>` (always `false` now).
  - `CHANGE_LOG` token + `ChangeLog` interface + `NoopChangeLog`; `ChangeLogEntry`.
  - `ROUTE_VALIDATOR` token + `RouteValidator` interface + `NoopRouteValidator`.
  - `ChangeOrderNotAvailableError`.
  - `UnitOfWork = (tx: Prisma.TransactionClient) => Promise<void>`; `ChangeResult = { path: ImpactPath; class: ImpactClass; scope: FindingScope[]; findings: Finding[] }`; `FreePathStrategy.run(req, decision, uow)`; `ChangeOrderStrategy.run(req, decision, uow)`.
  - `ChangeMediator.apply(req: ChangeRequest, uow: UnitOfWork): Promise<ChangeResult>`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/change-mediator.e2e-spec.ts`:
```ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { ChangeMediator } from "../src/modules/changes/change-mediator";
import { ScopeResolver } from "../src/modules/changes/scope.resolver";
import { ImpactRegistry } from "../src/modules/changes/impact.registry";
import { ChangeOrderNotAvailableError } from "../src/modules/changes/errors";

describe("Change Mediator (integration)", () => {
  let app: INestApplication;
  let mediator: ChangeMediator;
  let resolver: ScopeResolver;
  let registry: ImpactRegistry;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    mediator = moduleRef.get(ChangeMediator);
    resolver = moduleRef.get(ScopeResolver);
    registry = moduleRef.get(ImpactRegistry);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks(); // each test starts with the real ScopeResolver (returns false)
  });

  it("declares the leg impact classes at startup (§7.3)", () => {
    expect(registry.classOf("leg", "origin")).toBe("RfqDefining");
    expect(registry.classOf("leg", "legName")).toBe("Corrective");
    expect(registry.classOf("leg", "@create")).toBe("Structural");
  });

  it("routes an RfqDefining leg edit down the FREE path (no downstream work), running the uow", async () => {
    const applied: string[] = [];
    const res = await mediator.apply(
      { entity: "leg", id: "leg-a", field: "origin", queryId: "q-1", actorId: null },
      async () => {
        applied.push("applied");
      },
    );
    expect(res.path).toBe("free");
    expect(res.class).toBe("RfqDefining");
    expect(res.scope).toEqual([{ type: "leg", id: "leg-a" }]);
    expect(res.findings).toEqual([]); // no-op route validator
    expect(applied).toEqual(["applied"]);
  });

  it("routes a Structural @create down the FREE path pre-RFQ", async () => {
    const res = await mediator.apply(
      { entity: "leg", id: "leg-b", action: "@create", actorId: null },
      async () => {},
    );
    expect(res.class).toBe("Structural");
    expect(res.path).toBe("free");
  });

  it("keeps a Corrective edit on the FREE path even WITH downstream work (§7.5)", async () => {
    jest.spyOn(resolver, "downstreamWork").mockResolvedValueOnce(true);
    const res = await mediator.apply(
      { entity: "leg", id: "leg-c", field: "legName", actorId: null },
      async () => {},
    );
    expect(res.path).toBe("free");
  });

  it("forks to CHANGE-ORDER when downstream work exists, and the stub throws without applying", async () => {
    jest.spyOn(resolver, "downstreamWork").mockResolvedValueOnce(true);
    const uow = jest.fn(async () => {});
    await expect(
      mediator.apply({ entity: "leg", id: "leg-d", field: "origin", actorId: null }, uow),
    ).rejects.toBeInstanceOf(ChangeOrderNotAvailableError);
    expect(uow).not.toHaveBeenCalled(); // nothing applied on the change-order path in Stage 3
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @svyft/api test -- test/change-mediator.e2e-spec.ts`
Expected: FAIL — `../src/modules/changes/change-mediator` and siblings do not exist.

- [ ] **Step 3: Implement `impact.registry.ts`**

```ts
import { Injectable } from "@nestjs/common";
import type { ImpactClass } from "@svyft/shared";

// A field name, or the structural actions '@create' / '@delete'.
export type ImpactKey = string;
export type EntityImpactMap = Record<ImpactKey, ImpactClass>;

// Per-entity impact declarations (§7.3). Each owning module declares its own map;
// merged so later stages add fields without clobbering earlier ones.
@Injectable()
export class ImpactRegistry {
  private readonly maps = new Map<string, EntityImpactMap>();

  declare(entity: string, map: EntityImpactMap): void {
    this.maps.set(entity, { ...(this.maps.get(entity) ?? {}), ...map });
  }

  classOf(entity: string, key: ImpactKey): ImpactClass | undefined {
    return this.maps.get(entity)?.[key];
  }
}
```

- [ ] **Step 4: Implement `leg.impact.ts`**

```ts
import { ImpactClass } from "@svyft/shared";
import type { EntityImpactMap } from "./impact.registry";

// Leg field impact classes (§7.3 / §11.1). Owned by the legs module in Plan 5;
// declared here now so the classifier + fork are provable in Plan 3.
export const legImpactMap: EntityImpactMap = {
  origin: ImpactClass.RfqDefining,
  destination: ImpactClass.RfqDefining,
  mode: ImpactClass.RfqDefining,
  readyDate: ImpactClass.RfqDefining,
  targetDelivery: ImpactClass.RfqDefining,
  legName: ImpactClass.Corrective,
  "@create": ImpactClass.Structural,
  "@delete": ImpactClass.Structural,
};
```

- [ ] **Step 5: Implement `impact.classifier.ts`**

```ts
import { Injectable } from "@nestjs/common";
import type { ChangeRequest, FindingScope, ImpactClass } from "@svyft/shared";
import { ImpactRegistry } from "./impact.registry";

export interface Classification {
  class: ImpactClass;
  scope: FindingScope[];
}

// Maps (entity, field|action) → impact class + the minimal touched scope (§11.3).
// Stage-3 scope is the target entity itself; the cargo→legs fan-out lands in Plan 5.
@Injectable()
export class ImpactClassifier {
  constructor(private readonly registry: ImpactRegistry) {}

  classify(req: ChangeRequest): Classification {
    const key = req.action ?? req.field;
    if (!key) throw new Error("ChangeRequest must carry a `field` or an `action`");

    const impactClass = this.registry.classOf(req.entity, key);
    if (!impactClass) throw new Error(`No impact class declared for ${req.entity}.${key}`);

    const scope: FindingScope[] = [{ type: req.entity as FindingScope["type"], id: req.id }];
    return { class: impactClass, scope };
  }
}
```

- [ ] **Step 6: Implement `scope.resolver.ts`**

```ts
import { Injectable } from "@nestjs/common";
import type { FindingScope } from "@svyft/shared";

// "Does anything downstream (RFQs/quotes) depend on this scope?" (§7.3). Stage 3
// has no downstream artifacts, so this is ALWAYS false → every change is Free-path.
// Plan 4+ overrides with "which RFQs/quotes reference these legs".
@Injectable()
export class ScopeResolver {
  async downstreamWork(_scope: FindingScope[]): Promise<boolean> {
    return false;
  }
}
```

- [ ] **Step 7: Implement `change-log.ts`**

```ts
import { Injectable } from "@nestjs/common";
import type { FindingScope } from "@svyft/shared";

export interface ChangeLogEntry {
  entity: string;
  id: string;
  field?: string;
  action?: string;
  reason?: string;
  affected: FindingScope[];
  actorId?: string | null;
}

export const CHANGE_LOG = Symbol("CHANGE_LOG");

export interface ChangeLog {
  record(entry: ChangeLogEntry): Promise<void>;
}

// No-op sink now; the durable change-log lands with the Stage-4 cascade (§7.7).
@Injectable()
export class NoopChangeLog implements ChangeLog {
  async record(_entry: ChangeLogEntry): Promise<void> {
    /* reserved seam — no-op in Stage 3 */
  }
}
```

- [ ] **Step 8: Implement `route-validator.ts`**

```ts
import { Injectable } from "@nestjs/common";
import type { Finding } from "@svyft/shared";
import type { Prisma } from "@prisma/client";

export const ROUTE_VALIDATOR = Symbol("ROUTE_VALIDATOR");

export interface RouteValidator {
  // Re-run route validation for the touched query after a Free-path apply.
  revalidate(queryId: string | undefined, tx: Prisma.TransactionClient): Promise<Finding[]>;
}

// No-op now; Plan 5 implements this with validateRoute() over the query graph.
@Injectable()
export class NoopRouteValidator implements RouteValidator {
  async revalidate(
    _queryId: string | undefined,
    _tx: Prisma.TransactionClient,
  ): Promise<Finding[]> {
    return [];
  }
}
```

- [ ] **Step 9: Implement `errors.ts`**

```ts
export class ChangeOrderNotAvailableError extends Error {
  constructor() {
    super(
      "Change-order cascade is not available until Stage 4 (no downstream work exists in Stage 3)",
    );
    this.name = "ChangeOrderNotAvailableError";
  }
}
```

- [ ] **Step 10: Implement `free-path.strategy.ts`**

```ts
import { Inject, Injectable } from "@nestjs/common";
import type { ChangeRequest, Finding, FindingScope, ImpactClass, ImpactDecision, ImpactPath } from "@svyft/shared";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { CHANGE_LOG, type ChangeLog } from "./change-log";
import { ROUTE_VALIDATOR, type RouteValidator } from "./route-validator";

// The caller supplies HOW to persist the patch; the strategy owns the transaction
// boundary + revalidation + change-log. Plan 5's LegsService passes the real leg write.
export type UnitOfWork = (tx: Prisma.TransactionClient) => Promise<void>;

export interface ChangeResult {
  path: ImpactPath;
  class: ImpactClass;
  scope: FindingScope[];
  findings: Finding[];
}

// FreePath (§7.3): apply in a tx → re-run route validation → changeLog.record (no-op now).
@Injectable()
export class FreePathStrategy {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ROUTE_VALIDATOR) private readonly routes: RouteValidator,
    @Inject(CHANGE_LOG) private readonly changeLog: ChangeLog,
  ) {}

  async run(req: ChangeRequest, decision: ImpactDecision, uow: UnitOfWork): Promise<ChangeResult> {
    const findings = await this.prisma.$transaction(async (tx) => {
      await uow(tx);
      const f = await this.routes.revalidate(req.queryId, tx);
      await this.changeLog.record({
        entity: req.entity,
        id: req.id,
        field: req.field,
        action: req.action,
        reason: req.reason,
        affected: decision.scope,
        actorId: req.actorId,
      });
      return f;
    });
    return { path: "free", class: decision.class, scope: decision.scope, findings };
  }
}
```

- [ ] **Step 11: Implement `change-order.strategy.ts`**

```ts
import { Injectable } from "@nestjs/common";
import type { ChangeRequest, ImpactDecision } from "@svyft/shared";
import type { ChangeResult, UnitOfWork } from "./free-path.strategy";
import { ChangeOrderNotAvailableError } from "./errors";

// Stage 4+ cascade lands here: impact preview → confirm + reason → cascade to the
// minimal scope → drive `reopen` transitions (the seam) → invalidate quotes →
// durable change-log. Unreachable in Stage 3 (ScopeResolver.downstreamWork ≡ false),
// so it is a stub that can never fire — proven by change-mediator.e2e-spec.
@Injectable()
export class ChangeOrderStrategy {
  async run(
    _req: ChangeRequest,
    _decision: ImpactDecision,
    _uow: UnitOfWork,
  ): Promise<ChangeResult> {
    throw new ChangeOrderNotAvailableError();
  }
}
```

- [ ] **Step 12: Implement `change-mediator.ts`**

```ts
import { Injectable } from "@nestjs/common";
import { decidePath, type ChangeRequest, type ImpactDecision } from "@svyft/shared";
import { ImpactClassifier } from "./impact.classifier";
import { ScopeResolver } from "./scope.resolver";
import { FreePathStrategy, type ChangeResult, type UnitOfWork } from "./free-path.strategy";
import { ChangeOrderStrategy } from "./change-order.strategy";

// One mediator for every mutation (§7.3). classify → resolve downstream → fork.
@Injectable()
export class ChangeMediator {
  constructor(
    private readonly classifier: ImpactClassifier,
    private readonly scope: ScopeResolver,
    private readonly free: FreePathStrategy,
    private readonly changeOrder: ChangeOrderStrategy,
  ) {}

  async apply(req: ChangeRequest, uow: UnitOfWork): Promise<ChangeResult> {
    const { class: impactClass, scope } = this.classifier.classify(req);
    const hasDownstreamWork = await this.scope.downstreamWork(scope);
    const path = decidePath(impactClass, hasDownstreamWork);
    const decision: ImpactDecision = { class: impactClass, scope, path };

    return path === "free"
      ? this.free.run(req, decision, uow)
      : this.changeOrder.run(req, decision, uow);
  }
}
```

- [ ] **Step 13: Implement `changes.module.ts`**

```ts
import { Module, type OnModuleInit } from "@nestjs/common";
import { ImpactRegistry } from "./impact.registry";
import { ImpactClassifier } from "./impact.classifier";
import { ScopeResolver } from "./scope.resolver";
import { ChangeMediator } from "./change-mediator";
import { FreePathStrategy } from "./free-path.strategy";
import { ChangeOrderStrategy } from "./change-order.strategy";
import { CHANGE_LOG, NoopChangeLog } from "./change-log";
import { ROUTE_VALIDATOR, NoopRouteValidator } from "./route-validator";
import { legImpactMap } from "./leg.impact";

@Module({
  providers: [
    ImpactRegistry,
    ImpactClassifier,
    ScopeResolver,
    ChangeMediator,
    FreePathStrategy,
    ChangeOrderStrategy,
    { provide: CHANGE_LOG, useClass: NoopChangeLog },
    { provide: ROUTE_VALIDATOR, useClass: NoopRouteValidator },
  ],
  exports: [ChangeMediator, ImpactRegistry],
})
export class ChangesModule implements OnModuleInit {
  constructor(private readonly registry: ImpactRegistry) {}

  onModuleInit(): void {
    // The legs module owns these declarations; registered here until it lands (Plan 5).
    this.registry.declare("leg", legImpactMap);
  }
}
```

- [ ] **Step 14: Register `ChangesModule` in `AppModule`**

Modify `apps/api/src/app.module.ts` — add the import and list it after `StatusModule`:
```ts
import { ChangesModule } from "./modules/changes/changes.module";
```
and in the `imports` array (after `StatusModule`):
```ts
    StatusModule,
    ChangesModule,
    HealthModule,
```

- [ ] **Step 15: Run the test to verify it passes**

Run: `pnpm --filter @svyft/api test -- test/change-mediator.e2e-spec.ts`
Expected: PASS (leg declarations; Free path runs the uow; Structural pre-RFQ free; Corrective free with downstream; fork → ChangeOrder throws, uow untouched).

- [ ] **Step 16: Typecheck + commit**

```bash
pnpm --filter @svyft/shared build
pnpm --filter @svyft/api typecheck
git add apps/api/src/modules/changes apps/api/src/app.module.ts apps/api/test/change-mediator.e2e-spec.ts
git commit -m "feat(changes): ChangeMediator, impact classifier/registry, Free path + ChangeOrder stub"
```

---

### Task 6: Docs + full branch verification (fresh unseeded DB, CI mirror)

**Files:**
- Modify: `README.md` (add an "Extensibility Core" note)
- No new tests — this task proves the whole branch composes on a fresh, **unseeded** DB (CI parity).

- [ ] **Step 1: Update `README.md`**

Add a short section after the "Masters" section:
```markdown
## Extensibility Core

The framework future stages plug into (Technical Design §7). **Status Machine:** owned
statuses move only through `StatusService.fire` (guarded, declarative transitions in a
registry), which appends an operational `StatusTransition` log and emits in-process
`${key}.status.changed` events; derived query status is a pure projection
(`deriveQueryStatus`). **Change-Impact mediator:** every mutation flows through
`ChangeMediator.apply`, which classifies impact and forks Free-path (built) vs
Change-order (a stub that can never fire in Stage 3 — no downstream work exists). Generic
types live in `@svyft/shared`; the services + `StatusTransition` model live in `apps/api`.
Stage-3 slice: leg `DRAFT ↔ READY_FOR_RFQ`, query status derived, Free path only.
```

- [ ] **Step 2: Verify against a fresh, UNSEEDED database (CI parity)**

The handoff mandates this — CI runs unseeded. From repo root with the dev Postgres up:
```bash
set -a; . apps/api/.env; set +a
pnpm exec prisma migrate reset --force --skip-seed --schema prisma/schema.prisma
pnpm --filter @svyft/shared build
pnpm exec prisma generate --schema prisma/schema.prisma
pnpm --filter @svyft/api test
```
Expected: all api `*.e2e-spec.ts` pass on an empty schema (the new specs create + delete their own rows; no seed dependency). If any spec needs seed data, that is a bug — fix the spec, not the seed.

- [ ] **Step 3: Full CI mirror**

Run:
```bash
pnpm --filter @svyft/shared build && pnpm exec prisma generate --schema prisma/schema.prisma && pnpm run ci
```
Expected: `lint · typecheck · test · build` green across `@svyft/shared`, `@svyft/api`, `@svyft/web` (web untouched this plan).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the Extensibility Core (status machine + change mediator)"
```

---

## Self-Review (completed by plan author)

**Spec coverage (Technical Design §7; Functional Spec §9, §11):**
- §7.2 owned status — declarative `Transition`/`Machine` generics, `Guard` returning `true | Finding[]`, `Effect`, `kind: forward|reopen` → Task 2 (types) + Task 4 (leg machine, `fire`). ✓
- §7.2 leg Stage-3 slice `DRAFT --validate.pass[guard]--> READY_FOR_RFQ` + reserved `reopen` reverse edge → Task 4 (`leg.machine.ts`, tested both directions). ✓
- §7.2 `StatusService.fire` 7-step door (load → match → guard→block with `Finding[]` → persist → StatusTransition → emit → effect); `IllegalTransitionError` on no match → Task 4. ✓ (emit is **after commit** so subscribers see committed state; effect runs **inside** the tx — a deliberate, documented refinement of the numbered order.)
- §7.2 derived/rollup query status as a projection + `@OnEvent` subscriber; `deriveQueryStatus` (least-advanced gate + milestones) → Task 2 (pure) + Task 4 (`QueryStatusProjector`). ✓
- §7.2 extensibility: shared state **vocabulary** + `StatusRegistry.contribute` for stage-owned edges → Tasks 2, 4. ✓
- §7.3 `ChangeMediator`, `ImpactRegistry.declare`, `ImpactClass` (§11.1), classifier (class + minimal scope §11.3), `ScopeResolver.downstreamWork` (Stage 3 ≡ false), the Free/Change-order fork → Tasks 3, 5. ✓
- §7.3 FreePath **built** (apply→revalidate→changeLog no-op sink); ChangeOrder **stub that can never fire** → Task 5 (both, with the fork proven by forcing the resolver true). ✓
- §7.4 the seam — the `reopen` edge is live & tested in the status machine (status half); the change→status wiring is deferred to Plan 4 per the approved decision (ChangeOrder throws) → Tasks 4, 5. ✓
- §7.7 logging tiers — `StatusTransition` **in** (append-only, authoritative for prior state); change-log **reserved** (no-op sink); audit **deferred** → Tasks 1, 5. ✓
- §9.1/§9.2 status vocabularies (leg + query, full sets reserved, Stage-3 subset active) → Task 2. ✓
- §11.2/§11.4 two paths + "pre-RFQ everything Free"; §7.5 "class still gates" (Corrective free post-RFQ) → Task 3 (`decidePath`) + Task 5 (tested). ✓
- Data model §4.2 `StatusTransition (entity, entityId, from, to, event, actorId, at)` + nullable `tenantId` (§4.6) → Task 1 (adds `seq` for deterministic append order — the log-backed store's "latest"). ✓
- **Deferred, explicitly not built (Stage-3 scope table §10):** real `Leg.status`/`Query.status` columns + column-backed store; cargo→leg scope fan-out; real `validateRoute` revalidation; the ChangeOrder cascade + durable change-log; query-status persistence. Ports/stubs shipped so they drop in without re-plumbing → noted in Tasks 4, 5.

**Placeholder scan:** none — every step ships complete code. `<timestamp>` in Task 1 is Prisma-generated. The `// Plan 5:` comment blocks in `QueryStatusProjector`/ports are intentional forward-pointers, not missing implementation (the surrounding methods are complete + tested).

**Type consistency:** `LegStatus`/`LegEvent`/`QueryStatus` const-objects (Task 2) are the single source used by `leg.machine.ts`, `QueryStatusProjector`, and both e2e specs; `FireContext` (Task 4) is the `C` for `legMachine`, `Guard`, `Effect`, and the `StatusMachine` alias the registry stores; `findTransition`/`deriveQueryStatus` signatures (Task 2) match their call sites in `StatusService.fire`/`QueryStatusProjector`; `ChangeRequest`/`ImpactDecision`/`ImpactClass`/`decidePath` (Task 3) match `ImpactClassifier`, `FreePathStrategy`, `ChangeOrderStrategy`, and `ChangeMediator` (Task 5); `UnitOfWork`/`ChangeResult` are defined once in `free-path.strategy.ts` and imported by the mediator + change-order strategy; the `STATUS_STATE_STORE`/`CHANGE_LOG`/`ROUTE_VALIDATOR` DI tokens match their `@Inject(...)` sites; `prisma.statusTransition` fields (Task 1) match every `create`/`findFirst` call in Tasks 4/status specs.

**Sequencing / DAG:** 1 (StatusTransition model) → 2 (shared status) → 3 (shared change) → 4 (status module; needs 1 + 2) → 5 (changes module; needs 1 + 3) → 6 (docs + fresh-DB verify). Tasks 2 and 3 are independent (either order). Each task ends green + committed. Every api spec is seed-independent and self-cleans by a unique `entityId` prefix (`p3-model-`, `p3-status-`) or creates no rows (the mediator specs run empty transactions), so Task 6's `migrate reset --skip-seed` run is green.

---

*End of Plan 3.*
