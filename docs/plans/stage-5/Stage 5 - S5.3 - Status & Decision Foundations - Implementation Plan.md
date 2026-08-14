# Stage 5 · S5.3 — Status & Decision Foundations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax.
>
> Design of record: [`docs/Stage 5 - Compare Quotes - Design.md`](../../Stage%205%20-%20Compare%20Quotes%20-%20Design.md) §5 (data model), §8 (status lifecycle & Extensibility-Core additions). Master plan: [`Stage 5 - Implementation Plan.md`](Stage%205%20-%20Implementation%20Plan.md). Predecessors on this branch: S5.1 (FX) + S5.2 (comparison).

**Goal:** The **headless** state + persistence layer for the maker-checker: new status enum values, the Stage-5 quote/leg machine edges (incl. the durable-`REQUOTED` model), a `reason` on every status transition, and the `LegAwardDecision` / `AwardDecisionEvent` tables + `Query.awardSnapshot`. No endpoints (those are S5.4) — this only makes the transitions *legal to fire* and the tables *exist*.

**Architecture:** Extend the shared status vocabulary + `deriveQueryStatus`; add the edges via `StatusRegistry.contribute()` in a new `award` module's `onModuleInit` (never edit a Stage-3 status file); add `reason` to `FireContext` → the one `StatusService.fire` door persists it; additive Prisma migration for the two enum values + the decision tables + two columns.

**Tech Stack:** NestJS + Prisma (`apps/api`), pure-TS + Zod (`packages/shared`).

## Global Constraints

_Inherits the master plan's constraints (the `pnpm run ci` gate; hand-authored migrations + `migrate deploy`, never `migrate dev`; e2e `await app.close()` + `seedReferenceData` + namespaced rows + `sub: randomUUID()`; rebuild `@svyft/shared` after edits; the Prisma CLI needs `set -a; . apps/api/.env; set +a`). Plus, specific to S5.3:_

- **Shared enums:** const obj + companion `Object.values(...) as [X, ...X[]]` array + a pinned `toEqual` test (`packages/shared/src/status.test.ts` — order matters for the downstream Zod enums). Adding a value = extend the const obj + the array + the pinned test.
- **`LEG_RANK` is `Record<LegStatus, number>` (exhaustive)** — adding a `LegStatus` forces a compile error until ranked. Same for the web's exhaustive `Record<LegStatus,…>` / `Record<QuoteStatus,…>` / `Record<QueryStatus,…>` label maps — `tsc` will point you at each; add the new keys.
- **Migration safety:** additive only. `ALTER TYPE … ADD VALUE` is allowed in the migration's implicit transaction on PG12+ **as long as the new value is not *used* (default/insert/compare) in the same migration** — it isn't here. Do NOT put a column `DEFAULT 'QUOTING_CLIENT'` etc.
- **Extensibility Core:** never edit `leg.machine.ts`/`quote.machine.ts`/`status.service.ts`'s existing transitions; ADD edges via `contribute()`. Every status change goes through `StatusService.fire`.
- **Headless:** no controllers/endpoints, no `fire()` *callers* for the new events yet (S5.4 wires those) — S5.3 proves each edge is *fireable* via a test that calls `StatusService.fire` directly.

## File-Structure Map

| File | Responsibility |
| :-- | :-- |
| `packages/shared/src/status.ts` (+ `status.test.ts`) | New enum values + events + `QueryMilestones.quotingClient` + `deriveQueryStatus` mapping + `LEG_RANK` |
| `apps/web/src/features/rfq-workspace/statusBadges.tsx`, `QueryOverviewHeader.tsx` | Add the new keys to the exhaustive label/variant maps (keep web compiling) |
| `prisma/schema.prisma` (+ `…_add_award_decision/migration.sql`) | `reason` col, `awardSnapshot` col, `AwardDecisionStatus` enum, `LegAwardDecision` + `AwardDecisionEvent` models, the two `ADD VALUE`s |
| `apps/api/src/modules/status/status.types.ts` | `FireContext.reason` |
| `apps/api/src/modules/status/status.service.ts` | Persist `ctx.reason` on the `StatusTransition` row |
| `apps/api/src/modules/award/award.module.ts` | `onModuleInit` → `contribute()` the Stage-5 quote/leg edges |
| `apps/api/test/award-machine.e2e-spec.ts` | Fire-through each new edge + assert `reason` persists |

---

## Task 1 — shared status vocabulary + `deriveQueryStatus` (+ web label maps)

**Interfaces — Produces:** `LegStatus.APPROVED`; `QueryStatus.QUOTING_CLIENT`; `QuoteEvent.{APPROVE,UNAPPROVE,REQUEST_REQUOTE}`; `LegEvent.{APPROVE,REOPEN_AWARD}`; `QueryMilestones.quotingClient`.

- [ ] **Step 1: Write the failing test** — extend `packages/shared/src/status.test.ts`. Add the new values to the pinned arrays and add derive cases:
```ts
// in the LEG_STATUSES pinned toEqual: insert "APPROVED" right after "FULLY_QUOTED"
// in the QUERY_STATUSES pinned toEqual: insert "QUOTING_CLIENT" right after "QUOTED"
// in the LEG_EVENTS pinned toEqual: append "reopen_award" and "approve" (the two new literals)
// QUOTE_EVENTS uses arrayContaining — add "approve","unapprove","request_requote"

import { deriveQueryStatus, QueryStatus, LegStatus } from "./status";
describe("deriveQueryStatus — Stage 5", () => {
  it("all legs APPROVED but no milestone → still QUOTED (the Generate gate drives QUOTING_CLIENT)", () => {
    expect(deriveQueryStatus([LegStatus.APPROVED, LegStatus.APPROVED])).toBe(QueryStatus.QUOTED);
  });
  it("quotingClient milestone → QUOTING_CLIENT", () => {
    expect(deriveQueryStatus([LegStatus.APPROVED], { quotingClient: true })).toBe(QueryStatus.QUOTING_CLIENT);
  });
  it("awaitingClientDecision still outranks quotingClient (sent beats preparing)", () => {
    expect(deriveQueryStatus([LegStatus.APPROVED], { quotingClient: true, awaitingClientDecision: true }))
      .toBe(QueryStatus.AWAITING_CLIENT_DECISION);
  });
});
```
- [ ] **Step 2: Run → FAIL.** `pnpm --filter @svyft/shared test -- src/status.test.ts`
- [ ] **Step 3: Implement in `packages/shared/src/status.ts`:**
  - `LegStatus`: insert `APPROVED: "APPROVED"` **after** `FULLY_QUOTED` (the `LEG_STATUSES` array picks it up in place).
  - `LEG_RANK` (`Record<LegStatus, number>`): re-number so `APPROVED` sits between `FULLY_QUOTED` and `AWARDED`:
    `DRAFT:0, READY_FOR_RFQ:1, RFQ_SENT:2, PARTIALLY_QUOTED:3, FULLY_QUOTED:4, APPROVED:5, AWARDED:6, IN_TRANSIT:7, DELIVERED:8, CLOSED:9`.
  - `QueryStatus`: insert `QUOTING_CLIENT: "QUOTING_CLIENT"` **after** `QUOTED`.
  - `QuoteEvent` += `APPROVE: "approve"`, `UNAPPROVE: "unapprove"`, `REQUEST_REQUOTE: "request_requote"`.
  - `LegEvent` += `APPROVE: "approve"`, `REOPEN_AWARD: "reopen_award"`.
  - `QueryMilestones` += `quotingClient?: boolean;`.
  - `deriveQueryStatus`: add a `LegStatus.APPROVED` case to the `switch` returning `QueryStatus.QUOTED`; and add the milestone short-circuit **after** the `awaitingClientDecision` check:
    `if (milestones.quotingClient) return QueryStatus.QUOTING_CLIENT;`
- [ ] **Step 4: Fix the web label maps** the new enum values break (run `pnpm --filter @svyft/web exec tsc --noEmit` to find them):
  - `statusBadges.tsx`: `LEG_LABEL` += `APPROVED: "Approved"`; `legStatusVariant` — `case "APPROVED": return "success"`.
  - `QueryOverviewHeader.tsx`: `QUERY_STATUS_LABEL` += `QUOTING_CLIENT: "Quoting Client"`; `queryStatusVariant` — add `if (s === "QUOTING_CLIENT") return "accent" as const`.
  - (Add any other exhaustive `Record` `tsc` flags.)
- [ ] **Step 5: Run tests + build + typecheck.** `pnpm --filter @svyft/shared test -- src/status.test.ts` GREEN; `pnpm --filter @svyft/shared build`; `pnpm --filter @svyft/web exec tsc --noEmit` clean.
- [ ] **Step 6: Commit** — `feat(stage5): status vocabulary — leg APPROVED, query QUOTING_CLIENT, quote/leg award events` (+ `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer).

---

## Task 2 — Prisma: decision tables + columns + enum values

**Interfaces — Produces:** models `LegAwardDecision`, `AwardDecisionEvent`; enum `AwardDecisionStatus`; `StatusTransition.reason`; `Query.awardSnapshot`; `QueryStatus.QUOTING_CLIENT` + `LegStatus.APPROVED` in the DB.

- [ ] **Step 1: Edit `prisma/schema.prisma`:**
  - `model StatusTransition` += `reason String?`.
  - `model Query` += `awardSnapshot Json?`.
  - Add to `enum QueryStatus` a line `QUOTING_CLIENT` and to `enum LegStatus` a line `APPROVED`.
  - New enum + models:
```prisma
enum AwardDecisionStatus { DRAFT PENDING_APPROVAL APPROVED REJECTED }

model LegAwardDecision {
  id                 String   @id @default(uuid()) @db.Uuid
  legId              String   @unique @db.Uuid
  queryId            String   @db.Uuid
  shortlistedQuoteId String?  @db.Uuid
  shortlistedVariant ChargeRateVariant?
  recommendedQuoteId String?  @db.Uuid
  recommendedVariant ChargeRateVariant?
  overrideReason     String?
  status             AwardDecisionStatus @default(DRAFT)
  sentForApprovalAt  DateTime?
  sentByUserId       String?  @db.Uuid
  decidedByUserId    String?  @db.Uuid
  decidedAt          DateTime?
  rejectionReason    String?
  updatedAt          DateTime @updatedAt
  @@index([queryId])
}

model AwardDecisionEvent {
  id       String   @id @default(uuid()) @db.Uuid
  legId    String   @db.Uuid
  queryId  String   @db.Uuid
  type     String
  quoteId  String?  @db.Uuid
  variant  ChargeRateVariant?
  reason   String?
  actorId  String?  @db.Uuid
  at       DateTime @default(now())
  @@index([legId])
  @@index([queryId])
}
```
- [ ] **Step 2: Hand-author** `prisma/migrations/20260814130000_add_award_decision/migration.sql` (the two `ADD VALUE`s are safe here — neither value is *used* in this migration):
```sql
ALTER TYPE "QueryStatus" ADD VALUE 'QUOTING_CLIENT';
ALTER TYPE "LegStatus" ADD VALUE 'APPROVED';

CREATE TYPE "AwardDecisionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

ALTER TABLE "StatusTransition" ADD COLUMN "reason" TEXT;
ALTER TABLE "Query" ADD COLUMN "awardSnapshot" JSONB;

CREATE TABLE "LegAwardDecision" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "legId" UUID NOT NULL,
  "queryId" UUID NOT NULL,
  "shortlistedQuoteId" UUID,
  "shortlistedVariant" "ChargeRateVariant",
  "recommendedQuoteId" UUID,
  "recommendedVariant" "ChargeRateVariant",
  "overrideReason" TEXT,
  "status" "AwardDecisionStatus" NOT NULL DEFAULT 'DRAFT',
  "sentForApprovalAt" TIMESTAMP(3),
  "sentByUserId" UUID,
  "decidedByUserId" UUID,
  "decidedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LegAwardDecision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LegAwardDecision_legId_key" ON "LegAwardDecision"("legId");
CREATE INDEX "LegAwardDecision_queryId_idx" ON "LegAwardDecision"("queryId");

CREATE TABLE "AwardDecisionEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "legId" UUID NOT NULL,
  "queryId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "quoteId" UUID,
  "variant" "ChargeRateVariant",
  "reason" TEXT,
  "actorId" UUID,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AwardDecisionEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AwardDecisionEvent_legId_idx" ON "AwardDecisionEvent"("legId");
CREATE INDEX "AwardDecisionEvent_queryId_idx" ON "AwardDecisionEvent"("queryId");
```
- [ ] **Step 3: Apply + generate.** `set -a; . apps/api/.env; set +a` then `pnpm exec prisma migrate deploy --schema prisma/schema.prisma`; `prisma migrate status` → up to date; `pnpm exec prisma generate --schema prisma/schema.prisma`.
- [ ] **Step 4: Typecheck.** `pnpm --filter @svyft/api build` (nest build) PASS.
- [ ] **Step 5: Commit** — `feat(stage5): award-decision tables + reason/awardSnapshot columns + status enum values (migration)` (+ trailer).

---

## Task 3 — `reason` on transitions + the Stage-5 machine edges (headless) + fire-through e2e

**Interfaces — Consumes:** the new events/statuses (Task 1); the tables/columns (Task 2). **Produces:** `FireContext.reason`; the contributed quote/leg edges (fireable); `StatusTransition.reason` populated by `fire`.

**Read first:** `apps/api/src/modules/rfq/rfq.module.ts:32-49` (the `contribute()` shape); `apps/api/src/modules/status/status.service.ts:63-73` (the `StatusTransition.create` block); `apps/api/test/quote-machine.e2e-spec.ts` (how a quote's status is driven + asserted in a test).

- [ ] **Step 1: Write the failing fire-through e2e** `apps/api/test/award-machine.e2e-spec.ts` (mirror `quote-machine.e2e-spec.ts` harness — boot AppModule, `PrismaExceptionFilter`, `setGlobalPrefix("api")`, `seedReferenceData`, namespaced rows, **`await app.close()`**). It injects `StatusService` from the module ref and drives transitions directly (no HTTP). Seed a query + leg + FF + one `Quote`. Assert each **new** edge fires and lands the expected status, and that `reason` persists:
```ts
// quote edges
await status.fire("quote", quoteId, "submit", { queryId }); // RFQ_SENT→QUOTED (baseline)
await status.fire("quote", quoteId, "approve", { queryId, reason: "picked as winner" }); // → APPROVED
const t = await prisma.statusTransition.findFirst({ where: { entity: "quote", entityId: quoteId, event: "approve" } });
expect(t?.to).toBe("APPROVED"); expect(t?.reason).toBe("picked as winner");
await status.fire("quote", quoteId, "unapprove", { queryId }); // APPROVED→QUOTED
await status.fire("quote", quoteId, "request_requote", { queryId, reason: "negotiate" }); // QUOTED→REQUOTED
await status.fire("quote", quoteId, "submit", { queryId }); // REQUOTED→QUOTED (durable-REQUOTED re-submit)
// leg edges (drive the leg to FULLY_QUOTED first via the existing events, then:)
await status.fire("leg", legId, "approve", { queryId }); // FULLY_QUOTED→APPROVED
await status.fire("leg", legId, "reopen_award", { queryId }); // APPROVED→FULLY_QUOTED
// change-order sources:
//   quote APPROVED→INVALIDATE→INVALID ; leg APPROVED→REOPEN→READY_FOR_RFQ
```
Include a negative check: firing an undefined edge (e.g. `approve` from `SELECT`) rejects (findTransition returns undefined → `fire` throws — mirror how the existing machine tests assert an illegal transition).
- [ ] **Step 2: Run → FAIL** (events unknown / edges missing). `pnpm --filter @svyft/api test -- award-machine.e2e-spec.ts`
- [ ] **Step 3: Add `reason` to the fire door.**
  - `status.types.ts` `FireContext` += `reason?: string | null;`.
  - `status.service.ts` — in the `tx.statusTransition.create({ data: { … } })` block add `reason: ctx.reason ?? null,`.
- [ ] **Step 4: Create the `award` module** `apps/api/src/modules/award/award.module.ts` — an `OnModuleInit` that contributes the edges (mirror `rfq.module.ts`), then register `AwardModule` in `app.module.ts`:
```ts
this.registry.contribute("quote", [
  { from: QuoteStatus.QUOTED,    on: QuoteEvent.APPROVE,         to: QuoteStatus.APPROVED, kind: "forward" },
  { from: QuoteStatus.APPROVED,  on: QuoteEvent.UNAPPROVE,       to: QuoteStatus.QUOTED,   kind: "reopen"  },
  { from: QuoteStatus.QUOTED,    on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen"  },
  { from: QuoteStatus.APPROVED,  on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen"  },
  { from: QuoteStatus.REQUOTED,  on: QuoteEvent.SUBMIT,          to: QuoteStatus.QUOTED,   kind: "forward" }, // durable REQUOTED re-submit
  { from: QuoteStatus.REQUOTED,  on: QuoteEvent.EXPIRE,          to: QuoteStatus.EXPIRED,  kind: "forward" },
  { from: QuoteStatus.APPROVED,  on: QuoteEvent.INVALIDATE,      to: QuoteStatus.INVALID,  kind: "reopen"  }, // change-order source
]);
this.registry.contribute("leg", [
  { from: LegStatus.FULLY_QUOTED, on: LegEvent.APPROVE,      to: LegStatus.APPROVED,      kind: "forward" },
  { from: LegStatus.APPROVED,     on: LegEvent.REOPEN_AWARD, to: LegStatus.FULLY_QUOTED,  kind: "reopen"  },
  { from: LegStatus.APPROVED,     on: LegEvent.REOPEN,       to: LegStatus.READY_FOR_RFQ, kind: "reopen"  }, // change-order source
]);
```
  ⚠ `AwardModule` must import `StatusModule` (for `StatusRegistry`) and run its `onModuleInit` — order doesn't matter (contribute just appends to the already-registered machine), but do NOT also register the leg/quote machines (they're already registered).
- [ ] **Step 5: Run e2e + lint.** `pnpm --filter @svyft/api test -- award-machine.e2e-spec.ts` GREEN; `pnpm run lint`.
- [ ] **Step 6: Commit** — `feat(stage5): reason on StatusTransition + Stage-5 quote/leg machine edges (award module)` (+ trailer).

### S5.3 acceptance
- [ ] `pnpm run ci` green → opus whole-branch review → push to PR #52.

---

## Self-review (against the design)
- **Spec coverage:** §5.1 enum values + §8.1/§8.2 edges (incl. durable-`REQUOTED` `SUBMIT`/`EXPIRE`, and the `APPROVED→INVALIDATE`/`APPROVED→REOPEN` change-order sources) → Tasks 1+3; §5.3/§5.4 tables + §5.5 `reason` + §5.6 `awardSnapshot` → Tasks 2+3; §8.3 `quotingClient` milestone + `LEG_RANK` → Task 1 (the milestone is *defined* + mapped; *setting* it is S5.4).
- **Type consistency:** the event literals fired in the Task-3 e2e (`"approve"`, `"unapprove"`, `"request_requote"`, `"reopen_award"`) match Task 1's `QuoteEvent`/`LegEvent` definitions; `LegAwardDecision.shortlistedVariant` is `ChargeRateVariant?` (nullable for Air).
- **Headless:** no controllers, no `fire()` production callers — the e2e drives the door directly, proving legality. S5.4 adds the endpoints that call these edges.
- **No state-store change:** new `LegStatus`/`QuoteStatus` values persist through the generic `status` column automatically (`DispatchingStateStore`).
