# Stage 4 · Sub-build 2b — RFQ Distribution Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Work in a **fresh git worktree off `main`** on branch `feat/stage-4-sb2b`.

**Goal:** Build the headless (no-UI) backend RFQ **distribution flow** on top of the SB2a RFQ engine — eligibility, FF selection, leg-wise Distribute, page-level Distribute-All, and the hard FF foreign key — so an Executive/Manager can select freight forwarders for a leg and mint/amend RFQs that move quotes and legs into `RFQ_SENT`.

**Architecture:** Extend the existing `apps/api/src/modules/rfq/` module with a read-only `EligibilityService`, a write `RfqService` (selection + distribution), and an `RfqController` mounted under `queries/:id`. Distribution mints **one `Rfq` per `(queryId, freightForwarderId)`** (amend-on-add, D3), freezes each leg's manifest into `Quote.manifestSnapshot`, and advances status **only** through the sanctioned `StatusService.fire` door (quote `SELECT→RFQ_SENT`, leg `READY_FOR_RFQ→RFQ_SENT`). The query-status rollup comes free from the existing `QueryStatusProjector`. Eligibility filters the FF Master by leg country + mode + DG **in TypeScript** (fetch `ACTIVE` FFs, then match in TS).

> **⚠ Correction (post-implementation, verified against the generated client):** the Stage-4 handoff claimed *"Prisma has NO `hasSome`/`has` on scalar/enum arrays"* — **that is false.** Prisma 5.22 generates `has`/`hasEvery`/`hasSome`/`isEmpty` for both `String[]` (`StringNullableListFilter`) and enum lists (`EnumFreightModeNullableListFilter`). The TS-side filter shipped here is correct and well-tested, but a DB-side `where` (`availableCountries: { hasEvery: countries }`, `modes: { has: mode }`) would be strictly better and is the right shape for a future refactor. **Do not carry the false constraint into SB3–SB6.**

**Tech Stack:** NestJS 10 · Prisma 5 (PostgreSQL) · Zod (shared schemas) · Jest e2e (`supertest`) · pnpm monorepo (`apps/api`, `packages/shared`).

---

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from `docs/Stage 4 - Session Handoff.md`.

- **Schema is at the monorepo root:** `prisma/schema.prisma`; migrations at `prisma/migrations/`. Prisma client generate: `pnpm exec prisma generate` (from repo root). Migration: `pnpm exec prisma migrate dev --name <name>`.
- **DB safety:** local Postgres on **`:5433`** (Docker/colima — may need `colima start` + `docker compose up -d`). Migrations are **additive** only. **If Prisma ever proposes a RESET/DROP, STOP** — it's a shared dev DB.
- **Status changes go through ONE door:** `StatusService.fire(key, entityId, event, ctx)`. Never write `Leg.status`/`Quote.status` directly. **`fire` opens its own internal `$transaction` and cannot join an outer one** — so the pattern is: create rows in a `$transaction`, then call `fire` sequentially *after* the transaction. Never contribute/register machine edges here (SB2a already did).
- **Fire context:** pass `{ queryId }` (matches the SB2a status-fire convention). **Do not pass `actorId`** — `StatusTransition.actorId` is `@db.Uuid` and synthetic e2e JWT subjects (`u-EXECUTIVE`) are not UUIDs; omitting it keeps `actorId` null and tests green. (Actor audit for distribution is deferred.)
- **E2E teardown (the "11-hour hang" lesson):** ANY e2e that boots `AppModule` **MUST** `await app.close()` (HTTP specs) or `await moduleRef.close()` (service specs) in `afterAll` — otherwise the `@nestjs/schedule` cron keeps the process alive and jest hangs after tests pass. There is NO `forceExit` in `jest-e2e.json`. Make every e2e **self-contained**: create + delete its own `query`/`leg`/`FreightForwarder`/`cargo`/`point` fixtures; never `findFirst` ambient rows.
- **LINT is part of verification** — CI's `build-test` runs `pnpm run lint`. Run `pnpm --filter @svyft/api lint` before every commit. Watch `@typescript-eslint/no-unused-vars`: no destructure-to-omit (`const { x, ...rest }`) — use `{ ...obj, x: undefined }`.
- **Shared package rebuild:** after editing anything in `packages/shared/src/`, run `pnpm --filter @svyft/shared build` (api build/typecheck/lint resolve the **built** `@svyft/shared`). e2e tests resolve `@svyft/shared` → source via `jest-e2e.json` moduleNameMapper, so tests see edits without the build, but typecheck/lint/build do not. Add every new export to `packages/shared/src/index.ts`.
- **`PrismaExceptionFilter` does NOT map P2003** (FK violation) → guard FKs in services (validate the FF exists/ACTIVE before creating a Quote).
- **RBAC (resolved → Executive+):** distribution routes carry **no `@Roles`** — authenticated only (matches Functional Spec §5.2 and the `LegsController` convention; the global `JwtAuthGuard` still 401s the unauthenticated). *(User decision overriding the handoff's Admin/Manager — see Appendix B #1. Do **not** add `@Roles` to the write routes.)*
- **Enums / values (verbatim from schema + shared):** `Role = EXECUTIVE|MANAGER|ADMINISTRATOR`; `MasterStatus = ACTIVE|INACTIVE`; `FreightMode = ROAD|AIR|SEA`; `QuoteStatus.SELECT="SELECT"`, `.RFQ_SENT="RFQ_SENT"`; `QuoteEvent.SEND="send"`; `LegStatus.READY_FOR_RFQ`, `.RFQ_SENT`, `.DRAFT`; `LegEvent.SEND_RFQ="rfq.send"`. RFQ number format `YAL[YY]-[NNNN]-RFQ[NNN]` via `formatRfqNumber` (already used by `RfqNumberService.next`).
- **Commits:** conventional prefixes (`feat(rfq):`, `test(rfq):`, `chore(prisma):`). Frequent, per-step where the step structure calls for it. Co-author trailer per repo policy.

---

## Fresh-worktree setup (do this FIRST, before Task 1)

A new worktree off `main` has none of the build state. Run once:

- [ ] **S1.** Create the worktree + branch (via `superpowers:using-git-worktrees`), base `main`, branch `feat/stage-4-sb2b`.
- [ ] **S2.** `pnpm install` (repo root).
- [ ] **S3.** **Copy `apps/api/.env` from the main checkout** into the worktree's `apps/api/.env` (gitignored → provides `DATABASE_URL`/`DIRECT_URL` for the `:5433` dev DB). Confirm the DB is reachable (`colima start` + `docker compose up -d` if needed).
- [ ] **S4.** `pnpm exec prisma generate` (repo root).
- [ ] **S5.** `pnpm --filter @svyft/shared build`.
- [ ] **S6.** **Baseline green** before writing any code:
  - `pnpm --filter @svyft/shared build` → OK
  - `pnpm --filter @svyft/api test` → all e2e pass (and the process **exits**)
  - `pnpm --filter @svyft/api lint` → clean
  - `pnpm --filter @svyft/api typecheck` → clean
  If baseline is red, STOP and fix the environment before proceeding.

---

## File Structure

**New files** (all under `apps/api/src/modules/rfq/`):
- `leg-context.ts` — `loadLegForRfq(prisma, queryId, legId)` pure loader → `LegRfqContext` (leg + endpoint countries + DG flag + fresh/sent quotes). Shared by eligibility + distribution.
- `manifest.ts` — `buildManifestSnapshot(ctx, query, frozenAt)` pure function → `ManifestSnapshot`.
- `eligibility.service.ts` — `EligibilityService.getEligibleFfs(queryId, legId, broaden)`.
- `rfq.service.ts` — `RfqService`: `setFfSelection`, `distributeLeg`, `distributeAll`, private `performDistribution`/`validateLegForDistribution`/`resolveDeadline`.
- `rfq.controller.ts` — `RfqController` (`@Controller("queries/:id")`): 4 routes.

**Modified files:**
- `prisma/schema.prisma` — hard FK on `Rfq.freightForwarderId` + `Quote.freightForwarderId`; back-relations on `FreightForwarder`; `@@index([freightForwarderId])` on both. (+ new migration dir.)
- `apps/api/src/modules/rfq/rfq.module.ts` — add `FreightForwardersModule` import, `RfqController`, providers `EligibilityService` + `RfqService`.
- `apps/api/src/modules/freight-forwarders/freight-forwarders.service.ts` — add `findEligible(criteria)`.
- `packages/shared/src/rfq.ts` — add `ManifestSnapshot`(+cargo) type, `DistributeRfqEntry`/`DistributeResult` DTOs, `ffSelectionSchema`/`FfSelectionInput`, `distributeSchema`/`DistributeInput`.
- `packages/shared/src/index.ts` — export the new symbols (if not re-exported already).
- `apps/api/test/quote-machine.e2e-spec.ts` + `apps/api/test/leg-quote-rollup.e2e-spec.ts` — replace arbitrary-UUID `freightForwarderId` with real `FreightForwarder` rows.

**New e2e specs:** `apps/api/test/rfq-eligibility.e2e-spec.ts`, `rfq-selection.e2e-spec.ts`, `rfq-distribute.e2e-spec.ts`, `rfq-distribute-all.e2e-spec.ts`, `rfq-distribution-flow.e2e-spec.ts`.

---

## Task 1: Hard FF foreign key + fix SB2a fixtures

**Goal:** Convert the soft `freightForwarderId` on `Rfq`/`Quote` into real FK relations (+ index), and repair the two SB2a e2e specs whose fixtures pass arbitrary UUIDs (they break under the FK).

**Files:**
- Modify: `prisma/schema.prisma` (models `FreightForwarder`, `Rfq`, `Quote`)
- Create: `prisma/migrations/<timestamp>_add_ff_hard_fk/migration.sql` (generated)
- Modify: `apps/api/test/quote-machine.e2e-spec.ts`, `apps/api/test/leg-quote-rollup.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Rfq.freightForwarder` / `Quote.freightForwarder` relations; `FreightForwarder.rfqs` / `.quotes` back-relations; FK constraints `Rfq_freightForwarderId_fkey`, `Quote_freightForwarderId_fkey` (`ON DELETE RESTRICT`); indexes `Rfq_freightForwarderId_idx`, `Quote_freightForwarderId_idx`.

- [ ] **Step 1: Pre-check for orphan rows** (a bad `freightForwarderId` would make the FK migration fail).

Run (repo root):
```bash
pnpm exec prisma db execute --stdin <<'SQL'
SELECT 'quote' AS tbl, count(*) FROM "Quote" q LEFT JOIN "FreightForwarder" f ON q."freightForwarderId"=f.id WHERE f.id IS NULL
UNION ALL
SELECT 'rfq', count(*) FROM "Rfq" r LEFT JOIN "FreightForwarder" f ON r."freightForwarderId"=f.id WHERE f.id IS NULL;
SQL
```
Expected: both counts `0` on a clean dev DB (prior e2e clean up after themselves). If either is `>0`, they are abandoned test rows — delete them:
```bash
pnpm exec prisma db execute --stdin <<'SQL'
DELETE FROM "Quote" WHERE "freightForwarderId" NOT IN (SELECT id FROM "FreightForwarder");
DELETE FROM "Rfq"   WHERE "freightForwarderId" NOT IN (SELECT id FROM "FreightForwarder");
SQL
```
(Targeted deletion of orphan test rows only — never a reset.)

- [ ] **Step 2: Edit `prisma/schema.prisma`.**

On `model FreightForwarder`, add back-relations (anywhere before the closing `}`, after `updatedAt`):
```prisma
  rfqs   Rfq[]
  quotes Quote[]
```

On `model Rfq`, change the soft ref into a relation and add the index. Replace:
```prisma
  freightForwarderId String       @db.Uuid
```
with:
```prisma
  freightForwarderId String           @db.Uuid
  freightForwarder   FreightForwarder @relation(fields: [freightForwarderId], references: [id], onDelete: Restrict)
```
and add to the index block (alongside the existing `@@index([queryId])` / `@@index([tenantId])`):
```prisma
  @@index([freightForwarderId])
```

On `model Quote`, do the same. Replace:
```prisma
  freightForwarderId String      @db.Uuid
```
with:
```prisma
  freightForwarderId String           @db.Uuid
  freightForwarder   FreightForwarder @relation(fields: [freightForwarderId], references: [id], onDelete: Restrict)
```
and add:
```prisma
  @@index([freightForwarderId])
```

- [ ] **Step 3: Generate the migration** (this is where the FK breaks the old fixtures — expected).

Run (repo root):
```bash
pnpm exec prisma migrate dev --name add_ff_hard_fk
```
Expected: a new `prisma/migrations/<ts>_add_ff_hard_fk/migration.sql` containing `ALTER TABLE "Rfq" ADD CONSTRAINT "Rfq_freightForwarderId_fkey" ... ON DELETE RESTRICT`, the same for `Quote`, and two `CREATE INDEX ... _freightForwarderId_idx`. Prisma applies it and regenerates the client. **If Prisma proposes a reset, STOP** (means orphan rows remain — go back to Step 1).

- [ ] **Step 4: Run the SB2a e2e — confirm they now FAIL (RED).**

Run:
```bash
pnpm --filter @svyft/api test -- quote-machine leg-quote-rollup
```
Expected: FAIL — `quote.create` throws a P2003 FK violation because `freightForwarderId` (set to `query.id`/`leg.id`) references no `FreightForwarder`. This proves the FK is live.

- [ ] **Step 5: Fix `apps/api/test/quote-machine.e2e-spec.ts`.**

In `beforeAll`, before the `prisma.quote.create`, create a real FF and pre-clean it; replace the quote's `freightForwarderId`:
```ts
// after `legId = leg.id;`
await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: "FF-E2E-QMACH" } });
const ff = await prisma.freightForwarder.create({
  data: {
    freightForwarderCode: "FF-E2E-QMACH",
    companyName: "QMach FF E2E",
    pic: "PIC",
    contactNumber: "+10000000000",
    email: "qmach@e2e.test",
    availableCountries: ["AE"],
    modes: ["AIR"],
    handleDg: true,
  },
});
const quote = await prisma.quote.create({
  data: {
    queryId: query.id,
    legId: leg.id,
    freightForwarderId: ff.id,
    status: "SELECT",
  },
});
quoteId = quote.id;
```
Capture the FF id for teardown — add `let ffId: string;` to the suite scope and set `ffId = ff.id;`. In `afterAll`, delete the quote **before** the FF (FK Restrict), and the FF before the query is fine (no relation):
```ts
afterAll(async () => {
  await prisma.quote.deleteMany({ where: { id: quoteId } }).catch(() => {});
  await prisma.freightForwarder.deleteMany({ where: { id: ffId } }).catch(() => {});
  await prisma.leg.deleteMany({ where: { id: legId } }).catch(() => {});
  await prisma.query.deleteMany({ where: { id: queryId } }).catch(() => {});
  await moduleRef.close();
});
```

- [ ] **Step 6: Fix `apps/api/test/leg-quote-rollup.e2e-spec.ts`** (needs **two** distinct FFs — `@@unique([legId, freightForwarderId])`).

Add `let ffA: string; let ffB: string;` to suite scope. In `beforeAll`, replace the `mk`/two-quote block:
```ts
await prisma.freightForwarder.deleteMany({
  where: { freightForwarderCode: { in: ["FF-E2E-ROLLUP-A", "FF-E2E-ROLLUP-B"] } },
});
const mkFf = (code: string, name: string) =>
  prisma.freightForwarder.create({
    data: {
      freightForwarderCode: code, companyName: name, pic: "PIC",
      contactNumber: "+10000000000", email: `${code}@e2e.test`,
      availableCountries: ["AE"], modes: ["AIR"], handleDg: false,
    },
  });
ffA = (await mkFf("FF-E2E-ROLLUP-A", "Rollup FF A E2E")).id;
ffB = (await mkFf("FF-E2E-ROLLUP-B", "Rollup FF B E2E")).id;
const mk = (ff: string) =>
  prisma.quote.create({ data: { queryId, legId, freightForwarderId: ff, status: "RFQ_SENT" } });
qa = (await mk(ffA)).id;
qb = (await mk(ffB)).id;
await status.fire("leg", legId, "rfq.send", { queryId });
```
In `afterAll`, delete quotes first, then the FFs, then leg/query:
```ts
afterAll(async () => {
  await prisma.quote.deleteMany({ where: { legId } }).catch(() => {});
  await prisma.freightForwarder.deleteMany({ where: { id: { in: [ffA, ffB] } } }).catch(() => {});
  await prisma.leg.deleteMany({ where: { id: legId } }).catch(() => {});
  await prisma.query.deleteMany({ where: { id: queryId } }).catch(() => {});
  await moduleRef.close();
});
```

- [ ] **Step 7: Run the two specs — GREEN.**
```bash
pnpm --filter @svyft/api test -- quote-machine leg-quote-rollup
```
Expected: PASS, and the jest process **exits** (teardown closes the module).

- [ ] **Step 8: Full baseline still green.**
```bash
pnpm exec prisma generate && pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint && pnpm --filter @svyft/api test
```
Expected: all green, process exits.

- [ ] **Step 9: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations apps/api/test/quote-machine.e2e-spec.ts apps/api/test/leg-quote-rollup.e2e-spec.ts
git commit -m "chore(prisma): hard FK for Rfq/Quote.freightForwarderId + fix SB2a fixtures"
```

---

## Task 2: Eligibility — `findEligible` + leg-context loader + `GET eligible-ffs`

**Goal:** `GET /queries/:id/legs/:legId/eligible-ffs?broaden=bool` returns ACTIVE FFs filtered by the leg's endpoint countries + mode + (if any leg cargo is DG) `handleDg=true`; `broaden=true` drops the country/mode filter but keeps the DG restriction.

**Files:**
- Create: `apps/api/src/modules/rfq/leg-context.ts`
- Modify: `apps/api/src/modules/freight-forwarders/freight-forwarders.service.ts`
- Create: `apps/api/src/modules/rfq/eligibility.service.ts`
- Create: `apps/api/src/modules/rfq/rfq.controller.ts`
- Modify: `apps/api/src/modules/rfq/rfq.module.ts`
- Test: `apps/api/test/rfq-eligibility.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `FreightForwardersService`; `QuoteStatus` from `@svyft/shared`.
- Produces:
  - `loadLegForRfq(prisma: PrismaService, queryId: string, legId: string): Promise<LegRfqContext>` where `LegRfqContext = { leg: LegRfqRow; endpointCountries: string[]; hasDg: boolean; freshQuotes: {id;freightForwarderId}[]; sentQuotes: {id;freightForwarderId;status}[] }`.
  - `FreightForwardersService.findEligible(criteria: { countries: string[]; mode: FreightMode | null; requireDg: boolean; broaden: boolean }): Promise<FreightForwarder[]>`.
  - `EligibilityService.getEligibleFfs(queryId, legId, broaden): Promise<FreightForwarder[]>`.

- [ ] **Step 1: Write the failing e2e** `apps/api/test/rfq-eligibility.e2e-spec.ts`.

Prepend the standard HTTP harness (Appendix A). The test builds a query with two points (origin `CN`, destination `AE`), a leg `AIR` with one non-DG cargo, and four FFs: (A) serves CN+AE, AIR, no-DG → eligible; (B) serves CN+AE, SEA → filtered by mode; (C) serves CN only, AIR → filtered by country; (D) INACTIVE → excluded. Body:
```ts
it("filters eligible FFs by country + mode; broaden drops country/mode", async () => {
  const admin = cookie(Role.ADMINISTRATOR);
  // --- fixtures (self-contained) ---
  const query = await prisma.query.create({ data: { queryCode: CODE } });
  const origin = await prisma.point.create({ data: { queryId: query.id, type: "PICKUP", country: "CN" } });
  const dest = await prisma.point.create({ data: { queryId: query.id, type: "DELIVERY", country: "AE" } });
  const cargo = await prisma.cargoItem.create({
    data: { queryId: query.id, rowIndex: 0, poReference: "PO1", productName: "Widget",
            packageType: "BOX", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1, isDangerous: false },
  });
  const leg = await prisma.leg.create({
    data: { queryId: query.id, legCode: "L1", mode: "AIR", status: "READY_FOR_RFQ",
            originPointId: origin.id, destinationPointId: dest.id,
            readyDate: new Date(), targetDelivery: new Date(Date.now() + 86400000),
            legCargo: { create: { cargoItemId: cargo.id } } },
  });
  const mkFf = (code: string, countries: string[], modes: ("AIR"|"SEA"|"ROAD")[], status: "ACTIVE"|"INACTIVE", handleDg = false) =>
    prisma.freightForwarder.create({ data: {
      freightForwarderCode: code, companyName: `${code} Co`, pic: "P", contactNumber: "+1000000000",
      email: `${code}@e2e.test`, availableCountries: countries, modes, status, handleDg } });
  const a = await mkFf("FF-ELIG-A", ["CN", "AE"], ["AIR"], "ACTIVE");
  await mkFf("FF-ELIG-B", ["CN", "AE"], ["SEA"], "ACTIVE");
  await mkFf("FF-ELIG-C", ["CN"], ["AIR"], "ACTIVE");
  await mkFf("FF-ELIG-D", ["CN", "AE"], ["AIR"], "INACTIVE");

  const res = await request(app.getHttpServer())
    .get(`/api/queries/${query.id}/legs/${leg.id}/eligible-ffs`)
    .set("Cookie", admin).expect(200);
  const ids = res.body.map((f: { id: string }) => f.id);
  expect(ids).toContain(a.id);
  expect(res.body).toHaveLength(1); // only A

  const broad = await request(app.getHttpServer())
    .get(`/api/queries/${query.id}/legs/${leg.id}/eligible-ffs?broaden=true`)
    .set("Cookie", admin).expect(200);
  expect(broad.body.length).toBeGreaterThanOrEqual(3); // A,B,C (all ACTIVE); D excluded
});
```
Add a second test for DG: a DG cargo restricts to `handleDg=true` even with `broaden=true`. Use `CODE`/FF codes with a distinct prefix and clean them in `beforeAll`/`afterAll` (see Appendix A cleanup pattern — delete quotes → FFs → legCargo/cargo → points → legs → query, by `queryCode`/code prefix).

- [ ] **Step 2: Run it — RED.**
```bash
pnpm --filter @svyft/api test -- rfq-eligibility
```
Expected: FAIL/404 — the route does not exist yet.

- [ ] **Step 3: Create `apps/api/src/modules/rfq/leg-context.ts`.**
```ts
import { NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { QuoteStatus } from "@svyft/shared";
import type { PrismaService } from "../../prisma/prisma.service";

export const LEG_RFQ_INCLUDE = {
  originPoint: { select: { country: true, name: true, city: true } },
  destinationPoint: { select: { country: true, name: true, city: true } },
  legCargo: { include: { cargoItem: true } },
  quotes: { select: { id: true, freightForwarderId: true, status: true } },
} satisfies Prisma.LegInclude;

export type LegRfqRow = Prisma.LegGetPayload<{ include: typeof LEG_RFQ_INCLUDE }>;

export interface LegRfqContext {
  leg: LegRfqRow;
  endpointCountries: string[];
  hasDg: boolean;
  freshQuotes: { id: string; freightForwarderId: string }[];
  sentQuotes: { id: string; freightForwarderId: string; status: string }[];
}

export async function loadLegForRfq(
  prisma: PrismaService,
  queryId: string,
  legId: string,
): Promise<LegRfqContext> {
  const leg = await prisma.leg.findFirst({ where: { id: legId, queryId }, include: LEG_RFQ_INCLUDE });
  if (!leg) throw new NotFoundException("Leg not found");
  const countries = [leg.originPoint?.country, leg.destinationPoint?.country].filter(
    (c): c is string => !!c,
  );
  const endpointCountries = [...new Set(countries)];
  const hasDg = leg.legCargo.some((lc) => lc.cargoItem.isDangerous);
  const freshQuotes = leg.quotes
    .filter((q) => q.status === QuoteStatus.SELECT)
    .map((q) => ({ id: q.id, freightForwarderId: q.freightForwarderId }));
  const sentQuotes = leg.quotes
    .filter((q) => q.status !== QuoteStatus.SELECT)
    .map((q) => ({ id: q.id, freightForwarderId: q.freightForwarderId, status: q.status }));
  return { leg, endpointCountries, hasDg, freshQuotes, sentQuotes };
}
```

- [ ] **Step 4: Add `findEligible` to `FreightForwardersService`.**

Add imports at the top of `freight-forwarders.service.ts` (reuse existing `Prisma`/type imports; add `FreightForwarder`, `FreightMode` from `@prisma/client` if not present):
```ts
import type { FreightForwarder, FreightMode } from "@prisma/client";
```
Add the method to the class:
```ts
async findEligible(criteria: {
  countries: string[];
  mode: FreightMode | null;
  requireDg: boolean;
  broaden: boolean;
}): Promise<FreightForwarder[]> {
  const active = await this.prisma.freightForwarder.findMany({
    where: { status: "ACTIVE", ...(criteria.requireDg ? { handleDg: true } : {}) },
    orderBy: { companyName: "asc" },
  });
  if (criteria.broaden) return active;
  return active.filter((ff) => {
    const modeOk = criteria.mode === null || ff.modes.includes(criteria.mode);
    const countryOk =
      criteria.countries.length === 0 ||
      criteria.countries.every((c) => ff.availableCountries.includes(c));
    return modeOk && countryOk;
  });
}
```

- [ ] **Step 5: Create `apps/api/src/modules/rfq/eligibility.service.ts`.**
```ts
import { Injectable } from "@nestjs/common";
import type { FreightForwarder } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { FreightForwardersService } from "../freight-forwarders/freight-forwarders.service";
import { loadLegForRfq } from "./leg-context";

@Injectable()
export class EligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ffs: FreightForwardersService,
  ) {}

  async getEligibleFfs(queryId: string, legId: string, broaden: boolean): Promise<FreightForwarder[]> {
    const ctx = await loadLegForRfq(this.prisma, queryId, legId);
    return this.ffs.findEligible({
      countries: ctx.endpointCountries,
      mode: ctx.leg.mode,
      requireDg: ctx.hasDg,
      broaden,
    });
  }
}
```

- [ ] **Step 6: Create `apps/api/src/modules/rfq/rfq.controller.ts`** (only the eligibility route for now; other routes added in later tasks).
```ts
import { Controller, Get, Param, Query } from "@nestjs/common";
import { EligibilityService } from "./eligibility.service";

@Controller("queries/:id")
export class RfqController {
  constructor(private readonly eligibility: EligibilityService) {}

  @Get("legs/:legId/eligible-ffs")
  eligibleFfs(@Param("id") id: string, @Param("legId") legId: string, @Query("broaden") broaden?: string) {
    return this.eligibility.getEligibleFfs(id, legId, broaden === "true");
  }
}
```

- [ ] **Step 7: Wire `rfq.module.ts`.** Add imports + register the controller/providers, keeping the existing `onModuleInit`:
```ts
import { FreightForwardersModule } from "../freight-forwarders/freight-forwarders.module";
import { RfqController } from "./rfq.controller";
import { EligibilityService } from "./eligibility.service";
```
Update the `@Module({...})`:
```ts
@Module({
  imports: [StatusModule, FreightForwardersModule],
  controllers: [RfqController],
  providers: [RfqNumberService, RfqTokenService, LegQuoteProjector, EligibilityService],
  exports: [RfqNumberService, RfqTokenService],
})
```
(Confirm `RfqModule` is already in `AppModule` imports — SB2a added it. `PrismaService` is provided by a global `PrismaModule`, so no import needed.)

- [ ] **Step 8: Run the e2e — GREEN.**
```bash
pnpm --filter @svyft/api test -- rfq-eligibility
```
Expected: PASS, process exits.

- [ ] **Step 9: Typecheck + lint, then commit.**
```bash
pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint
git add apps/api/src/modules/rfq apps/api/src/modules/freight-forwarders/freight-forwarders.service.ts apps/api/test/rfq-eligibility.e2e-spec.ts
git commit -m "feat(rfq): eligible-ffs endpoint (country/mode/DG filter + broaden)"
```

---

## Task 3: FF selection — `PUT ff-selection`

**Goal:** `PUT /queries/:id/legs/:legId/ff-selection` with body `{ ffIds: string[] }` reconciles the leg's `SELECT` quotes: create rows for newly-ticked ACTIVE FFs, delete `SELECT` rows no longer selected, never touch `RFQ_SENT+` (frozen) rows. Validate every id is a known ACTIVE FF (P2003 is not mapped).

**Files:**
- Modify: `packages/shared/src/rfq.ts` (+ `index.ts` if needed)
- Create: `apps/api/src/modules/rfq/rfq.service.ts`
- Modify: `apps/api/src/modules/rfq/rfq.controller.ts`, `rfq.module.ts`
- Test: `apps/api/test/rfq-selection.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `QuoteStatus`, `RequestUser`.
- Produces:
  - Shared `ffSelectionSchema = z.object({ ffIds: z.array(z.string().uuid()) })`, `type FfSelectionInput = z.infer<typeof ffSelectionSchema>`.
  - `RfqService.setFfSelection(queryId, legId, ffIds: string[], user: RequestUser): Promise<{ selected: string[] }>`.

- [ ] **Step 1: Add the shared schema.** In `packages/shared/src/rfq.ts` add (top: `import { z } from "zod";` if absent):
```ts
export const ffSelectionSchema = z.object({ ffIds: z.array(z.string().uuid()) });
export type FfSelectionInput = z.infer<typeof ffSelectionSchema>;
```
Ensure `packages/shared/src/index.ts` re-exports `./rfq` (SB2a likely already does — verify `export * from "./rfq";`). Then rebuild shared:
```bash
pnpm --filter @svyft/shared build
```

- [ ] **Step 2: Write the failing e2e** `apps/api/test/rfq-selection.e2e-spec.ts` (Appendix A harness). Cover: (a) selecting two FFs creates two `SELECT` quotes; (b) re-PUT with one id deletes the dropped `SELECT` quote; (c) an unknown/INACTIVE id → 400; (d) a `SELECT`-status FF can be deselected but an `RFQ_SENT` quote (seed one directly) is preserved. Core assertion:
```ts
it("reconciles SELECT quotes and validates FFs", async () => {
  const admin = cookie(Role.ADMINISTRATOR);
  const query = await prisma.query.create({ data: { queryCode: CODE } });
  const leg = await prisma.leg.create({ data: { queryId: query.id, legCode: "L1", status: "READY_FOR_RFQ" } });
  const ffA = await mkActiveFf("FF-SEL-A");
  const ffB = await mkActiveFf("FF-SEL-B");

  await request(app.getHttpServer())
    .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
    .set("Cookie", admin).send({ ffIds: [ffA.id, ffB.id] }).expect(200);
  expect(await prisma.quote.count({ where: { legId: leg.id, status: "SELECT" } })).toBe(2);

  await request(app.getHttpServer())
    .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
    .set("Cookie", admin).send({ ffIds: [ffA.id] }).expect(200);
  const rows = await prisma.quote.findMany({ where: { legId: leg.id }, select: { freightForwarderId: true } });
  expect(rows.map((r) => r.freightForwarderId)).toEqual([ffA.id]);

  await request(app.getHttpServer())
    .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
    .set("Cookie", admin).send({ ffIds: ["00000000-0000-0000-0000-000000000000"] }).expect(400);
});
```
(`mkActiveFf` = the FF-create helper from Appendix A.)

- [ ] **Step 3: Run — RED** (`pnpm --filter @svyft/api test -- rfq-selection` → 404/fail).

- [ ] **Step 4: Create `apps/api/src/modules/rfq/rfq.service.ts`** with the selection method (distribution methods land in Task 4/5):
```ts
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { QuoteStatus } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import type { RequestUser } from "../auth/types";

@Injectable()
export class RfqService {
  constructor(private readonly prisma: PrismaService) {}

  async setFfSelection(
    queryId: string,
    legId: string,
    ffIds: string[],
    user: RequestUser,
  ): Promise<{ selected: string[] }> {
    const leg = await this.prisma.leg.findFirst({ where: { id: legId, queryId }, select: { id: true } });
    if (!leg) throw new NotFoundException("Leg not found");

    const wanted = [...new Set(ffIds)];
    if (wanted.length) {
      const active = await this.prisma.freightForwarder.findMany({
        where: { id: { in: wanted }, status: "ACTIVE" },
        select: { id: true },
      });
      if (active.length !== wanted.length) {
        throw new BadRequestException("One or more freight forwarders are unknown or inactive");
      }
    }

    const existing = await this.prisma.quote.findMany({
      where: { legId },
      select: { id: true, freightForwarderId: true, status: true },
    });
    const selectRows = existing.filter((q) => q.status === QuoteStatus.SELECT);
    const frozen = new Set(
      existing.filter((q) => q.status !== QuoteStatus.SELECT).map((q) => q.freightForwarderId),
    );
    const currentSel = new Set(selectRows.map((q) => q.freightForwarderId));
    const toAdd = wanted.filter((id) => !currentSel.has(id) && !frozen.has(id));
    const toRemove = selectRows
      .filter((q) => !wanted.includes(q.freightForwarderId))
      .map((q) => q.id);

    await this.prisma.$transaction([
      ...(toRemove.length ? [this.prisma.quote.deleteMany({ where: { id: { in: toRemove } } })] : []),
      ...toAdd.map((ffId) =>
        this.prisma.quote.create({
          data: {
            queryId,
            legId,
            freightForwarderId: ffId,
            status: QuoteStatus.SELECT,
            tenantId: user.tenantId,
          },
        }),
      ),
    ]);

    const now = await this.prisma.quote.findMany({
      where: { legId, status: QuoteStatus.SELECT },
      select: { freightForwarderId: true },
    });
    return { selected: now.map((q) => q.freightForwarderId) };
  }
}
```
(Import path for `RequestUser`: `../auth/types` — matches `LegsController`. Confirm the field is `user.tenantId`.)

- [ ] **Step 5: Add the route to `rfq.controller.ts`.** Extend imports + constructor + method:
```ts
import { Body, Controller, Get, Param, Put, Query } from "@nestjs/common";
import { ffSelectionSchema, type FfSelectionInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { RfqService } from "./rfq.service";
// ...
constructor(
  private readonly eligibility: EligibilityService,
  private readonly rfq: RfqService,
) {}

// Executive+ (no @Roles) — authenticated only, per the resolved RBAC decision
@Put("legs/:legId/ff-selection")
setSelection(
  @Param("id") id: string,
  @Param("legId") legId: string,
  @Body(new ZodValidationPipe(ffSelectionSchema)) body: FfSelectionInput,
  @CurrentUser() user: RequestUser,
) {
  return this.rfq.setFfSelection(id, legId, body.ffIds, user);
}
```
(Confirm `Role` is exported from `@svyft/shared` — the e2e imports it from there. `Roles` decorator: `../auth/decorators/roles.decorator`.)

- [ ] **Step 6: Register `RfqService`** in `rfq.module.ts` providers: `providers: [RfqNumberService, RfqTokenService, LegQuoteProjector, EligibilityService, RfqService]`.

- [ ] **Step 7: Run — GREEN** (`pnpm --filter @svyft/api test -- rfq-selection`).

- [ ] **Step 8: typecheck + lint + commit.**
```bash
pnpm --filter @svyft/shared build && pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint
git add packages/shared apps/api/src/modules/rfq apps/api/test/rfq-selection.e2e-spec.ts
git commit -m "feat(rfq): ff-selection endpoint (reconcile SELECT quotes)"
```

---

## Task 4: Distribute (leg-wise) — happy path

**Goal:** `POST /queries/:id/legs/:legId/distribute` mints one `Rfq` for the leg's selected FF(s) (per `(query, FF)`), freezes each leg's manifest into `Quote.manifestSnapshot`, sets the +48h deadline, and fires quote `SELECT→RFQ_SENT` + leg `READY_FOR_RFQ→RFQ_SENT`. Query rollup → `RFQ_SENT` comes free. (Validation gates, amend, dup-guard, override land in Task 5.)

**Files:**
- Modify: `packages/shared/src/rfq.ts` (+ rebuild)
- Create: `apps/api/src/modules/rfq/manifest.ts`
- Modify: `apps/api/src/modules/rfq/rfq.service.ts`, `rfq.controller.ts`
- Test: `apps/api/test/rfq-distribute.e2e-spec.ts`

**Interfaces:**
- Consumes: `RfqNumberService.next(queryId, tx)`, `RfqTokenService.mint()`, `StatusService.fire`, `loadLegForRfq`, `QuoteEvent.SEND`, `LegEvent.SEND_RFQ`, `LegStatus`, `Incoterms`.
- Produces:
  - Shared `ManifestSnapshot` + `ManifestSnapshotCargo` types; `DistributeRfqEntry`, `DistributeResult`; `distributeSchema = z.object({ submissionDeadline: z.string().datetime().optional(), confirm: z.boolean().optional() })`, `type DistributeInput`.
  - `buildManifestSnapshot(ctx: LegRfqContext, query: { incoterms: Incoterms | null }, frozenAt: Date): ManifestSnapshot`.
  - `RfqService.distributeLeg(queryId, legId, input: DistributeInput, user): Promise<DistributeResult>` and private `performDistribution(...)`, `resolveDeadline(...)`.

- [ ] **Step 1: Add shared types + schema** to `packages/shared/src/rfq.ts`:
```ts
import { z } from "zod";
import type { Incoterms } from "./query";      // existing shared union (used by RfqDto)
import type { FreightMode } from "./masters";  // existing shared FreightMode union (confirm path)

export interface ManifestSnapshotCargo {
  cargoItemId: string;
  poReference: string;
  productName: string;
  hsCode: string | null;
  packageType: string;
  isDangerous: boolean;
  qty: number;
  dimL: string;
  dimW: string;
  dimH: string;
  netWt: string | null;
  grossWt: string;
  volumeCbm: string | null;
}

export interface ManifestSnapshot {
  legId: string;
  legCode: string;
  legName: string | null;
  mode: FreightMode | null;
  incoterms: Incoterms | null;
  origin: { country: string | null; name: string | null; city: string | null } | null;
  destination: { country: string | null; name: string | null; city: string | null } | null;
  readyDate: string | null;
  targetDelivery: string | null;
  cargo: ManifestSnapshotCargo[];
  frozenAt: string;
}

export interface DistributeRfqEntry {
  freightForwarderId: string;
  rfqId: string;
  rfqNumber: string;
  minted: boolean;          // true = new RFQ (invitation); false = amended (D3 "RFQ Updated")
  accessToken?: string;     // raw 256-bit token, present ONLY when minted (goes into the link, SB5)
  legIds: string[];
}

export interface DistributeResult {
  rfqs: DistributeRfqEntry[];
  distributedLegIds: string[];
  skipped: { legId: string; reason: string }[];
}

export const distributeSchema = z.object({
  submissionDeadline: z.string().datetime().optional(),
  confirm: z.boolean().optional(),
});
export type DistributeInput = z.infer<typeof distributeSchema>;
```
> If `FreightMode`/`Incoterms` unions live at a different shared path, import from there; both are already used by `masters.ts`/`rfq.ts`. Rebuild shared: `pnpm --filter @svyft/shared build`.

- [ ] **Step 2: Write the failing e2e** `apps/api/test/rfq-distribute.e2e-spec.ts` (Appendix A). Fixtures: query (with `incoterms: "FOB"`), origin/dest points, one non-DG cargo, a leg `AIR` `READY_FOR_RFQ` with the cargo, one ACTIVE FF, and a pre-existing `SELECT` quote (via the selection endpoint or direct create). Assert the full happy path:
```ts
it("distributes: mints RFQ, freezes manifest, advances statuses + query rollup", async () => {
  const admin = cookie(Role.ADMINISTRATOR);
  // ...build query/points/cargo/leg + ACTIVE ff (helpers in Appendix A)...
  await request(app.getHttpServer())
    .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
    .set("Cookie", admin).send({ ffIds: [ff.id] }).expect(200);

  const res = await request(app.getHttpServer())
    .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
    .set("Cookie", admin).send({}).expect(201);

  expect(res.body.rfqs).toHaveLength(1);
  const entry = res.body.rfqs[0];
  expect(entry.minted).toBe(true);
  expect(entry.rfqNumber).toMatch(/-RFQ\d{3}$/);
  expect(entry.accessToken).toHaveLength(64);

  const rfq = await prisma.rfq.findUnique({ where: { id: entry.rfqId } });
  expect(rfq?.accessTokenHash).toHaveLength(64);
  expect(createHash("sha256").update(entry.accessToken).digest("hex")).toBe(rfq?.accessTokenHash);
  // deadline default ~ +48h
  expect(rfq!.submissionDeadline.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);

  const quote = await prisma.quote.findFirst({ where: { legId: leg.id } });
  expect(quote?.status).toBe("RFQ_SENT");
  expect(quote?.rfqId).toBe(entry.rfqId);
  expect(quote?.manifestSnapshot).toMatchObject({ legId: leg.id, mode: "AIR", incoterms: "FOB" });

  expect((await prisma.leg.findUnique({ where: { id: leg.id } }))?.status).toBe("RFQ_SENT");
  expect((await prisma.query.findUnique({ where: { id: query.id } }))?.status).toBe("RFQ_SENT");
});
```
(`import { createHash } from "node:crypto";` at the top of the spec.)

- [ ] **Step 3: Run — RED** (`pnpm --filter @svyft/api test -- rfq-distribute`).

- [ ] **Step 4: Create `apps/api/src/modules/rfq/manifest.ts`.**
```ts
import type { Incoterms } from "@prisma/client";
import type { ManifestSnapshot } from "@svyft/shared";
import type { LegRfqContext } from "./leg-context";

export function buildManifestSnapshot(
  ctx: LegRfqContext,
  query: { incoterms: Incoterms | null },
  frozenAt: Date,
): ManifestSnapshot {
  const { leg } = ctx;
  return {
    legId: leg.id,
    legCode: leg.legCode,
    legName: leg.legName,
    mode: leg.mode,
    incoterms: query.incoterms,
    origin: leg.originPoint
      ? { country: leg.originPoint.country, name: leg.originPoint.name, city: leg.originPoint.city }
      : null,
    destination: leg.destinationPoint
      ? { country: leg.destinationPoint.country, name: leg.destinationPoint.name, city: leg.destinationPoint.city }
      : null,
    readyDate: leg.readyDate ? leg.readyDate.toISOString() : null,
    targetDelivery: leg.targetDelivery ? leg.targetDelivery.toISOString() : null,
    cargo: leg.legCargo.map((lc) => ({
      cargoItemId: lc.cargoItem.id,
      poReference: lc.cargoItem.poReference,
      productName: lc.cargoItem.productName,
      hsCode: lc.cargoItem.hsCode,
      packageType: lc.cargoItem.packageType,
      isDangerous: lc.cargoItem.isDangerous,
      qty: lc.cargoItem.qty,
      dimL: lc.cargoItem.dimL.toString(),
      dimW: lc.cargoItem.dimW.toString(),
      dimH: lc.cargoItem.dimH.toString(),
      netWt: lc.cargoItem.netWt ? lc.cargoItem.netWt.toString() : null,
      grossWt: lc.cargoItem.grossWt.toString(),
      volumeCbm: lc.cargoItem.volumeCbm ? lc.cargoItem.volumeCbm.toString() : null,
    })),
    frozenAt: frozenAt.toISOString(),
  };
}
```

- [ ] **Step 5: Extend `RfqService`** with distribution. Add imports:
```ts
import type { Prisma, Incoterms } from "@prisma/client";
import { QuoteEvent, LegEvent, LegStatus, type DistributeInput, type DistributeResult, type DistributeRfqEntry } from "@svyft/shared";
import { StatusService } from "../status/status.service";
import { RfqNumberService } from "./rfq-number.service";
import { RfqTokenService } from "./rfq-token.service";
import { loadLegForRfq, type LegRfqContext } from "./leg-context";
import { buildManifestSnapshot } from "./manifest";
```
Expand the constructor:
```ts
constructor(
  private readonly prisma: PrismaService,
  private readonly status: StatusService,
  private readonly rfqNumber: RfqNumberService,
  private readonly token: RfqTokenService,
) {}

private readonly DEFAULT_DEADLINE_MS = 48 * 60 * 60 * 1000;
```
Add `distributeLeg` (happy path only — throws are minimal here; full gates in Task 5) + the shared core:
```ts
async distributeLeg(
  queryId: string,
  legId: string,
  input: DistributeInput,
  user: RequestUser,
): Promise<DistributeResult> {
  const ctx = await loadLegForRfq(this.prisma, queryId, legId);
  const query = await this.prisma.query.findUnique({
    where: { id: queryId },
    select: { id: true, incoterms: true },
  });
  if (!query) throw new NotFoundException("Query not found");
  if (ctx.freshQuotes.length === 0) {
    throw new BadRequestException("Select at least one freight forwarder before distributing");
  }
  const deadline = this.resolveDeadline(input.submissionDeadline);
  return this.performDistribution(query, [ctx], deadline, user);
}

private resolveDeadline(override?: string): Date {
  if (override) {
    const d = new Date(override);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
      throw new BadRequestException("submissionDeadline must be a valid future datetime");
    }
    return d;
  }
  return new Date(Date.now() + this.DEFAULT_DEADLINE_MS);
}

private async performDistribution(
  query: { id: string; incoterms: Incoterms | null },
  legCtxs: LegRfqContext[],
  deadline: Date,
  user: RequestUser,
): Promise<DistributeResult> {
  const frozenAt = new Date();
  const byFf = new Map<string, { quoteId: string; legCtx: LegRfqContext }[]>();
  for (const legCtx of legCtxs) {
    for (const q of legCtx.freshQuotes) {
      const arr = byFf.get(q.freightForwarderId) ?? [];
      arr.push({ quoteId: q.id, legCtx });
      byFf.set(q.freightForwarderId, arr);
    }
  }

  const entries: DistributeRfqEntry[] = [];
  const quoteFires: string[] = [];
  const legFires = new Set<string>();

  await this.prisma.$transaction(async (tx) => {
    for (const [ffId, items] of byFf) {
      let rfq = await tx.rfq.findUnique({
        where: { queryId_freightForwarderId: { queryId: query.id, freightForwarderId: ffId } },
      });
      let minted = false;
      let accessToken: string | undefined;
      if (!rfq) {
        const rfqNumber = await this.rfqNumber.next(query.id, tx);
        const t = this.token.mint();
        accessToken = t.token;
        rfq = await tx.rfq.create({
          data: {
            queryId: query.id,
            freightForwarderId: ffId,
            rfqNumber,
            accessTokenHash: t.hash,
            submissionDeadline: deadline,
            incoterms: query.incoterms,
            tenantId: user.tenantId,
          },
        });
        minted = true;
      }
      const legIds = new Set<string>();
      for (const { quoteId, legCtx } of items) {
        const snapshot = buildManifestSnapshot(legCtx, query, frozenAt);
        await tx.quote.update({
          where: { id: quoteId },
          data: { rfqId: rfq.id, manifestSnapshot: snapshot as unknown as Prisma.InputJsonValue },
        });
        quoteFires.push(quoteId);
        legIds.add(legCtx.leg.id);
        if (legCtx.leg.status === LegStatus.READY_FOR_RFQ) legFires.add(legCtx.leg.id);
      }
      entries.push({
        freightForwarderId: ffId,
        rfqId: rfq.id,
        rfqNumber: rfq.rfqNumber,
        minted,
        accessToken,
        legIds: [...legIds],
      });
    }
  });

  // fire AFTER the tx — StatusService.fire owns its own transaction
  for (const quoteId of quoteFires) {
    await this.status.fire("quote", quoteId, QuoteEvent.SEND, { queryId: query.id });
  }
  for (const legId of legFires) {
    await this.status.fire("leg", legId, LegEvent.SEND_RFQ, { queryId: query.id });
  }

  return {
    rfqs: entries,
    distributedLegIds: [...new Set(entries.flatMap((e) => e.legIds))],
    skipped: [],
  };
}
```

- [ ] **Step 6: Add the distribute route** to `rfq.controller.ts`:
```ts
import { Post } from "@nestjs/common";
import { distributeSchema, type DistributeInput } from "@svyft/shared";
// ...
@Post("legs/:legId/distribute")
distribute(
  @Param("id") id: string,
  @Param("legId") legId: string,
  @Body(new ZodValidationPipe(distributeSchema)) body: DistributeInput,
  @CurrentUser() user: RequestUser,
) {
  return this.rfq.distributeLeg(id, legId, body, user);
}
```

- [ ] **Step 7: Run — GREEN** (`pnpm --filter @svyft/api test -- rfq-distribute`). If the leg-status fire throws `IllegalTransitionError`, verify the leg fixture status is `READY_FOR_RFQ`.

- [ ] **Step 8: typecheck + lint + commit.**
```bash
pnpm --filter @svyft/shared build && pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint
git add packages/shared apps/api/src/modules/rfq apps/api/test/rfq-distribute.e2e-spec.ts
git commit -m "feat(rfq): distribute (leg-wise) — mint RFQ, freeze manifest, fire statuses"
```

---

## Task 5: Distribute gates (F1–F6), amend (D3), deadline override

**Goal:** Enforce distribution-readiness gates and the amend/duplicate semantics on `distributeLeg`: F1 (leg completeness), F4 (not `DRAFT`), F5 (DG → all selected FFs `handleDg`), F6/S5 duplicate-send guard (409 unless `confirm`), amend-on-add (2nd leg to same FF reuses the same `Rfq`/number/token, keeps the original deadline), and the `submissionDeadline` override.

**Files:**
- Modify: `apps/api/src/modules/rfq/rfq.service.ts`
- Test: `apps/api/test/rfq-distribute.e2e-spec.ts` (extend)

**Interfaces:**
- Consumes: same as Task 4.
- Produces: `RfqService.validateLegForDistribution(ctx): Promise<string[]>`; updated `distributeLeg` with dup-guard + gates.

- [ ] **Step 1: Add failing tests** to `rfq-distribute.e2e-spec.ts`:
  - **Amend:** distribute leg A to FF-X, then select+distribute leg B (same query) to FF-X → `rfqs[0].minted === false`, same `rfqId`/`rfqNumber`; FF-X has exactly **one** `Rfq`; leg B's quote `RFQ_SENT`; leg A's deadline unchanged.
  - **F6 dup-guard:** distribute leg A to FF-X (now no fresh SELECT quotes), distribute again → **409**; again with `{ confirm: true }` → **201** with `skipped: [{ legId, reason: "already-distributed" }]`.
  - **F5 DG:** leg with a DG cargo + a selected FF with `handleDg:false` → distribute **400** (code `F5_DG_FF_CANNOT_HANDLE`).
  - **F1:** leg missing `mode` (or `targetDelivery`) with a selected FF → **400** (`F1_INCOMPLETE_LEG`).
  - **Override:** `{ submissionDeadline: <ISO +72h> }` → `rfq.submissionDeadline` ≈ +72h; a past ISO → **400**.

- [ ] **Step 2: Run — RED** for the new cases.

- [ ] **Step 3: Add `validateLegForDistribution`** to `RfqService`:
```ts
private async validateLegForDistribution(ctx: LegRfqContext): Promise<string[]> {
  const { leg } = ctx;
  const errors: string[] = [];
  // F1 — leg completeness (origin, destination, mode, >=1 cargo, dates)
  if (
    !leg.originPointId || !leg.destinationPointId || !leg.mode ||
    leg.legCargo.length === 0 || !leg.readyDate || !leg.targetDelivery
  ) {
    errors.push("F1_INCOMPLETE_LEG");
  }
  // F4 — leg has passed the Stage-3 validation gate (not DRAFT)
  if (leg.status === LegStatus.DRAFT) errors.push("F4_LEG_NOT_READY");
  // F5 — DG cargo requires every selected FF to handle DG
  if (ctx.hasDg && ctx.freshQuotes.length) {
    const ffs = await this.prisma.freightForwarder.findMany({
      where: { id: { in: ctx.freshQuotes.map((q) => q.freightForwarderId) } },
      select: { handleDg: true },
    });
    if (ffs.some((f) => !f.handleDg)) errors.push("F5_DG_FF_CANNOT_HANDLE");
  }
  return errors;
}
```

- [ ] **Step 4: Rewrite `distributeLeg`** to apply the dup-guard + gates (replace the Task-4 body):
```ts
async distributeLeg(
  queryId: string,
  legId: string,
  input: DistributeInput,
  user: RequestUser,
): Promise<DistributeResult> {
  const ctx = await loadLegForRfq(this.prisma, queryId, legId);
  const query = await this.prisma.query.findUnique({
    where: { id: queryId },
    select: { id: true, incoterms: true },
  });
  if (!query) throw new NotFoundException("Query not found");

  // F2 / F6 — nothing fresh to send
  if (ctx.freshQuotes.length === 0) {
    if (ctx.sentQuotes.length > 0) {
      if (!input.confirm) {
        throw new ConflictException(
          "This leg's selected forwarders have already been sent this RFQ; confirm to proceed.",
        );
      }
      return { rfqs: [], distributedLegIds: [], skipped: [{ legId, reason: "already-distributed" }] };
    }
    throw new BadRequestException("Select at least one freight forwarder before distributing");
  }

  // F1 / F4 / F5
  const errors = await this.validateLegForDistribution(ctx);
  if (errors.length) {
    throw new BadRequestException({ message: "Leg is not ready for distribution", codes: errors });
  }

  const deadline = this.resolveDeadline(input.submissionDeadline);
  return this.performDistribution(query, [ctx], deadline, user);
}
```
Add `ConflictException` to the `@nestjs/common` import.

> **Amend correctness:** `performDistribution` (Task 4) already does find-or-create per FF, so a 2nd leg to the same FF reuses the existing `Rfq` (no new number/token/deadline) and only appends the new leg's quote — this satisfies D3/S3/S6 without change. The `submissionDeadline` override only affects **newly minted** RFQs (the create branch), never existing ones.

- [ ] **Step 5: Run — GREEN** (`pnpm --filter @svyft/api test -- rfq-distribute`).

- [ ] **Step 6: typecheck + lint + commit.**
```bash
pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint
git add apps/api/src/modules/rfq apps/api/test/rfq-distribute.e2e-spec.ts
git commit -m "feat(rfq): distribute gates F1/F4/F5, dup-guard F6, amend + deadline override"
```

---

## Task 6: Distribute-All (grouped by FF)

**Goal:** `POST /queries/:id/distribute-all` distributes every `READY_FOR_RFQ` leg that has fresh selections and passes F1/F4/F5, **grouped by FF** (one `Rfq` per FF across all its legs → no amend churn, B7). Legs that fail a gate or have nothing selected are skipped and reported.

**Files:**
- Modify: `apps/api/src/modules/rfq/rfq.service.ts`, `rfq.controller.ts`
- Test: `apps/api/test/rfq-distribute-all.e2e-spec.ts`

**Interfaces:**
- Consumes: `performDistribution`, `validateLegForDistribution`, `resolveDeadline`, `loadLegForRfq`.
- Produces: `RfqService.distributeAll(queryId, input: DistributeInput, user): Promise<DistributeResult>`; controller route `POST distribute-all`.

- [ ] **Step 1: Write the failing e2e** `apps/api/test/rfq-distribute-all.e2e-spec.ts`. Fixtures: a query with **two** `READY_FOR_RFQ` legs (L1, L2) each with a non-DG cargo; one FF (FF-X) selected on **both** legs; a third leg L3 left `DRAFT` (should be skipped). Assert:
```ts
it("distribute-all groups by FF: one RFQ for FF across both legs; skips non-ready legs", async () => {
  const admin = cookie(Role.ADMINISTRATOR);
  // ...select FF-X on L1 and L2 via ff-selection...
  const res = await request(app.getHttpServer())
    .post(`/api/queries/${query.id}/distribute-all`)
    .set("Cookie", admin).send({}).expect(201);

  expect(res.body.rfqs).toHaveLength(1);               // ONE RFQ for FF-X
  expect(res.body.rfqs[0].legIds.sort()).toEqual([l1.id, l2.id].sort());
  expect(res.body.distributedLegIds.sort()).toEqual([l1.id, l2.id].sort());
  expect(await prisma.rfq.count({ where: { queryId: query.id, freightForwarderId: ffX.id } })).toBe(1);
  expect((await prisma.leg.findUnique({ where: { id: l1.id } }))?.status).toBe("RFQ_SENT");
  expect((await prisma.leg.findUnique({ where: { id: l2.id } }))?.status).toBe("RFQ_SENT");
  expect((await prisma.query.findUnique({ where: { id: query.id } }))?.status).toBe("RFQ_SENT");
});
```

- [ ] **Step 2: Run — RED.**

- [ ] **Step 3: Add `distributeAll`** to `RfqService`:
```ts
async distributeAll(
  queryId: string,
  input: DistributeInput,
  user: RequestUser,
): Promise<DistributeResult> {
  const query = await this.prisma.query.findUnique({
    where: { id: queryId },
    select: { id: true, incoterms: true },
  });
  if (!query) throw new NotFoundException("Query not found");

  const legs = await this.prisma.leg.findMany({ where: { queryId }, select: { id: true } });
  const deadline = this.resolveDeadline(input.submissionDeadline);

  const ready: LegRfqContext[] = [];
  const skipped: { legId: string; reason: string }[] = [];
  for (const { id: legId } of legs) {
    const ctx = await loadLegForRfq(this.prisma, queryId, legId);
    // AS SHIPPED (final-review fix): report the skip instead of dropping it silently —
    // the Goal above says legs with nothing selected are "skipped and reported".
    if (ctx.freshQuotes.length === 0) {
      skipped.push({
        legId,
        reason: ctx.sentQuotes.length ? "already-distributed" : "nothing-selected",
      });
      continue;
    }
    const errors = await this.validateLegForDistribution(ctx);
    if (errors.length) {
      skipped.push({ legId, reason: errors.join(",") });
      continue;
    }
    ready.push(ctx);
  }
  if (ready.length === 0) return { rfqs: [], distributedLegIds: [], skipped };

  const result = await this.performDistribution(query, ready, deadline, user);
  return { ...result, skipped: [...skipped, ...result.skipped] };
}
```

- [ ] **Step 4: Add the route** to `rfq.controller.ts`:
```ts
@Post("distribute-all")
distributeAll(
  @Param("id") id: string,
  @Body(new ZodValidationPipe(distributeSchema)) body: DistributeInput,
  @CurrentUser() user: RequestUser,
) {
  return this.rfq.distributeAll(id, body, user);
}
```

- [ ] **Step 5: Run — GREEN** (`pnpm --filter @svyft/api test -- rfq-distribute-all`).

- [ ] **Step 6: typecheck + lint + commit.**
```bash
pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint
git add apps/api/src/modules/rfq apps/api/test/rfq-distribute-all.e2e-spec.ts
git commit -m "feat(rfq): distribute-all grouped by FF"
```

---

## Task 7: Consolidated full-flow e2e + final verification

**Goal:** One narrative e2e that exercises the whole distribution flow end-to-end (the handoff's scope item 6), then a green run of the full suite + lint + typecheck + build before the PR.

**Files:**
- Test: `apps/api/test/rfq-distribution-flow.e2e-spec.ts`

**Interfaces:** Consumes all endpoints; produces no new code.

- [ ] **Step 1: Write `apps/api/test/rfq-distribution-flow.e2e-spec.ts`** (Appendix A). **Drive every write with `cookie(Role.EXECUTIVE)`** to lock the Executive+ RBAC decision. One `it` that walks: build a 2-leg query → `GET eligible-ffs` (assert country/mode/DG filtering) → `PUT ff-selection` FF-X on L1 → `POST distribute` L1 (assert RFQ minted: number `^YAL\d{2}-\d{4}-RFQ\d{3}$`, `accessTokenHash` = sha256(token), quote `RFQ_SENT`, leg `RFQ_SENT`, query `RFQ_SENT`) → `PUT ff-selection` FF-X on L2 → `POST distribute` L2 (assert **amend**: same `rfqId`/number, FF-X still has 1 RFQ, query still `RFQ_SENT`) → `POST distribute` L1 again → **409** dup-guard → add FF-Y on both legs via `distribute-all` (assert grouped: one RFQ for FF-Y spanning both legs).

- [ ] **Step 2: Run it — iterate to GREEN.**
```bash
pnpm --filter @svyft/api test -- rfq-distribution-flow
```

- [ ] **Step 3: Full verification — everything green + process exits.**
```bash
pnpm --filter @svyft/shared build
pnpm --filter @svyft/api typecheck
pnpm --filter @svyft/api lint
pnpm --filter @svyft/api test        # entire e2e suite; MUST exit (no hang)
```
Also run web/shared checks that CI runs (match CI `build-test`):
```bash
pnpm run lint
pnpm run typecheck
```
Expected: all green. If the jest run hangs after "Tests: N passed", a new spec is missing its `afterAll` close — fix before proceeding.

- [ ] **Step 4: Commit.**
```bash
git add apps/api/test/rfq-distribution-flow.e2e-spec.ts
git commit -m "test(rfq): consolidated distribution-flow e2e (select→distribute→amend→distribute-all→dup-guard)"
```

- [ ] **Step 5: Whole-branch review + PR.** Per the handoff workflow: run the **opus** whole-branch review over `feat/stage-4-sb2b` (via `superpowers:requesting-code-review`), address findings, then open the PR (base `main`, title `Stage 4 · Sub-build 2b — RFQ Distribution Flow (backend)`). Push and **watch CI**: `gh pr checks <n> --watch` — do not assume green.

---

## Appendix A — Standard e2e harness (copy into each new spec)

Every new spec begins with this exact boilerplate (adapted from `apps/api/test/vessels.e2e-spec.ts`). Replace the `PREFIX` per spec so fixtures are unique and self-cleaning.

```ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

const PREFIX = "RFQ-ELIG"; // e.g. per-spec sentinel; FF codes use `FF-${PREFIX}-*`, queryCode `YAL00-${PREFIX}`
const CODE = `YAL00-${PREFIX}`;

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  // FF helper used across specs
  const mkFf = (
    code: string,
    countries: string[] = ["AE"],
    modes: ("AIR" | "SEA" | "ROAD")[] = ["AIR"],
    status: "ACTIVE" | "INACTIVE" = "ACTIVE",
    handleDg = false,
  ) =>
    prisma.freightForwarder.create({
      data: {
        freightForwarderCode: code,
        companyName: `${code} Co`,
        pic: "P",
        contactNumber: "+1000000000",
        email: `${code}@e2e.test`,
        availableCountries: countries,
        modes,
        status,
        handleDg,
      },
    });

  const cleanup = async () => {
    // order matters: quotes/rfqs reference FF (Restrict) and query (Cascade)
    const q = await prisma.query.findUnique({ where: { queryCode: CODE }, select: { id: true } });
    if (q) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/cargo/legCargo
    }
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } } });
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

  // it(...) blocks per task
});
```

Notes:
- Use a **distinct `PREFIX`** per spec file (`RFQ-ELIG`, `RFQ-SEL`, `RFQ-DIST`, `RFQ-DALL`, `RFQ-FLOW`) so parallel-safe cleanup by `queryCode`/code prefix never collides. Tests run `--runInBand` (serial) but self-contained fixtures are still required for a clean CI DB.
- Deleting the `Query` **cascades** its `points`, `legs`, `legCargo`, `cargo` (all `onDelete: Cascade` to `Query`), so `cleanup` only needs to delete quotes/rfqs (FK-Restrict to FF) + the query + the FFs.
- Create legs with cargo inline: `legCargo: { create: { cargoItemId: cargo.id } }`. Points need `type` (`PICKUP`/`DELIVERY`) + `country`.

---

## Appendix B — Open decisions / assumptions (flag at plan review)

Sensible defaults chosen to keep momentum; each is one-line-cheap to flip if the reviewer disagrees.

1. **RBAC = Executive+ (RESOLVED by user).** Distribution write routes carry **no `@Roles`** — authenticated only, matching Functional Spec §5.2 and the `LegsController` convention (Executives are the primary RFQ distributors). This overrides the handoff's `@Roles(ADMINISTRATOR, MANAGER)`. The global `JwtAuthGuard` still enforces auth (401 unauthenticated). At least one write path is exercised with an `EXECUTIVE` cookie (Task 7) to lock this in.
2. **No `rfq-preview` endpoint.** Design §5.2 lists `GET …/rfq-preview`, but the handoff's enumerated 2b scope omits it (and SB3 is "pure frontend"). Excluded; `buildManifestSnapshot` is built as a reusable pure function so a preview route is trivial to add later.
3. **No emails / no `RfqReminder` rows.** The handoff roadmap puts compose-&-log emails + the reminder cron in **SB5**. Distribute mints the number + token-hash + freezes the manifest + fires statuses only. "RFQ Updated" (D3) is realized as the **amend** (same `Rfq`), not an email.
4. **Eligibility country match = `every`.** An FF is eligible only if it serves **all** distinct endpoint countries of the leg (origin AND destination). Alternative reading is `some`; `broaden` is the escape hatch either way. Flip in `findEligible` if the spec means "either endpoint".
5. **F6 `confirm` semantics.** In SB2b the dup-guard **blocks** re-distribution (409) and, with `confirm:true` when nothing is fresh, returns a no-op `skipped`. True re-send (re-freeze + re-notify) belongs to the change-order path (SB6).
6. **Raw access token returned in the distribute response** (`DistributeRfqEntry.accessToken`, minted RFQs only). The hash is one-way, so the token can't be recovered later; surfacing it at mint preserves it for SB5's link composition. Only the **hash** is persisted.
7. **Status fires pass `{ queryId }` only** (no `actorId`) — matches the SB2a convention and avoids the `StatusTransition.actorId @db.Uuid` constraint under synthetic e2e subjects.
8. **`onDelete: Restrict`** on the new FF FKs — a referenced FF Master row can't be hard-deleted (consistent with its `status=INACTIVE` soft-retire).

---

## Self-review (author's checklist against the spec)

- **Spec coverage:** S1 eligibility → Task 2 (F5 DG re-checked at distribute). S2 selection → Task 3. S3 one-RFQ-per-FF + amend → Task 4/5 (`performDistribution` find-or-create). S6 deadline (default+override, set-once) → Task 4/5. S10 manifest freeze → Task 4 (`buildManifestSnapshot`). §10.1 F1–F5 + F6 → Task 5. §9 status lifecycle (quote/leg/query) → Task 4 fires + free rollup. Endpoints §5.2 (eligible-ffs, ff-selection, distribute, distribute-all) → Tasks 2/3/4/6. Hard FK + fixtures → Task 1. Full e2e → Task 7. Preview/emails/reminders → **out of scope** (Appendix B 2–3).
- **Type consistency:** `LegRfqContext`, `ManifestSnapshot`, `DistributeResult`/`DistributeRfqEntry`, `DistributeInput`, `FfSelectionInput` defined once and consumed with the same names/shapes across tasks. `performDistribution(query, legCtxs, deadline, user)` signature is stable between Task 4 (create) and Task 6 (reuse). Event/status strings pulled from `@svyft/shared` constants (never literals) except where the machine already uses them.
- **No placeholders:** every code step shows real code; every run step shows the command + expected result. Enum values, RFQ-number regex, FK names, and Prisma compound-unique accessor (`queryId_freightForwarderId`) are concrete.
