# Charge Configuration & Warehouse Attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Logistics Executive configure, per leg and before distribution, which optional charge lines the assigned FF(s) must price (on top of always-present cores), and decide which single leg carries a shared warehouse's handling cost — both locked at Distribute and edited thereafter only via the SB6 change-order cascade.

**Architecture:** A seeded `ChargeLineDefinition` master table catalogues every FF-portal charge per mode (`role` × `inputType`). The Executive's per-leg picks live in `LegChargeLineSelection`; the warehouse decision is a `Leg.warehouseHandlingIncluded` tri-state. Both ride the existing mediated `legs.update()` path (classified RfqDefining), so pre-distribute edits are free and post-distribute edits route to the change-order cascade. At distribute, the effective set (cores + selected) is frozen into `Quote.chargeConfigSnapshot`; the FF portal seeds and the Q1 submit-gate read that frozen set instead of the retired hardcoded presets.

**Tech Stack:** NestJS 10 + Prisma 5 (Postgres), `@svyft/shared` (isomorphic const-enums/zod), Vitest (shared + web), Jest e2e (`*.e2e-spec.ts`, api), React 18 + react-query + react-hook-form (web).

**Design of record:** `docs/Stage 4 - Charge Configuration & Warehouse Attribution - Design.md` (read it first — every task's *why* lives there; §-refs below point into it).

## Global Constraints

- **No `prisma migrate dev`.** It drifts on `CargoItem.volumeCbm` (generated column → PG 42601). **Hand-author** `prisma/migrations/<UTC-timestamp>_<name>/migration.sql` (additive only), then apply with `prisma migrate deploy`. Never accept a RESET/DROP — it's a shared dev DB.
- **Prisma commands need env exported first:** `set -a; . apps/api/.env; set +a` then `pnpm exec prisma <cmd> --schema prisma/schema.prisma`. Local DB is Postgres container `svyft-postgres-task4` on **:5433**; needs a gitignored `apps/api/.env`. Run `pnpm exec prisma generate --schema prisma/schema.prisma` after every schema edit.
- **Shared-enum pattern (TS side):** `const` object + union type + `Object.values(...) as [X, ...X[]]`, pinned by a `toEqual` test. **Never a TS `enum`.** (Prisma `schema.prisma` uses real `enum` blocks — that's separate.)
- **Rebuild shared after any shared edit:** `pnpm --filter @svyft/shared build` (api/web read `dist`). The api Jest config maps `@svyft/shared` → `src` (so e2e sees source), but web and `tsc` read `dist`.
- **Vitest does not type-check** (esbuild) and `tsconfig` excludes `*.test.ts`. After writing tests, run the package `typecheck` script **and** `npx tsc --noEmit` on new test files, or type errors hide.
- **api has no unit runner:** `pnpm --filter @svyft/api test` runs `test/*.e2e-spec.ts` (Jest, `--runInBand`, real DB). Pure-logic unit tests belong in `packages/shared` (Vitest). Every full-`AppModule` e2e **must** `await app.close()` in `afterAll` (the schedule cron keeps the process alive otherwise).
- **e2e reference data:** CI DB is migrated-but-unseeded — e2e needing catalogue rows must call `seedReferenceData(prisma)` in `beforeAll`.
- **RBAC:** workflow writes stay **Executive+ (authenticated, no `@Roles`)**. The catalogue GET is read-only auth-only (no `@Roles`). Only future admin CRUD would gate to `@Roles(Role.ADMINISTRATOR)`.
- **Lint is verification:** `pnpm run lint` per task — no `no-explicit-any`, no unused vars.

---

## File structure

**New files**
- `packages/shared/src/charge-config.ts` — `ChargeLineRole`/`ChargeLineInputType` const-enums, `ChargeLineDefinitionDto`, `ResolvedChargeLine`, `ChargeConfigSnapshot`, `resolveChargeConfig()`.
- `packages/shared/src/charge-config.test.ts` — `resolveChargeConfig` unit tests.
- `prisma/migrations/<ts>_add_charge_config/migration.sql` — enums, tables, columns.
- `apps/api/src/modules/config/charge-catalogue.service.ts` — read service for `ChargeLineDefinition`.
- `apps/api/src/modules/config/charge-catalogue.controller.ts` — `GET /api/charge-line-definitions`.
- `apps/api/src/modules/rfq/charge-config.snapshot.ts` — `buildChargeConfigSnapshot(...)`.
- `apps/api/test/charge-catalogue.e2e-spec.ts`, `apps/api/test/charge-config-distribute.e2e-spec.ts`, `apps/api/test/warehouse-attribution.e2e-spec.ts`, `apps/api/test/charge-config-lock.e2e-spec.ts`.
- `apps/web/src/features/rfq-workspace/ConfigureChargesPopover.tsx`, `WarehouseHandlingToggle.tsx`, `useChargeConfig.ts`, and their `*.test.tsx`.
- `apps/web/src/features/ff-portal/RoadChargesPanel.tsx`.

**Modified files**
- `packages/shared/src/quote.ts` (QuoteDraftCharge: `zone` nullable + `definitionKey`), `quote-engine.ts` (null-zone bucket + Q1 rewrite), `ff-portal.ts` (`FfPortalSeededCharge` + snapshot fields), `query.ts` (`QueryLegDto` new fields), `legs.ts` (`legSaveSchema`), `index.ts` (barrel export).
- `prisma/schema.prisma` (enums, 2 models, `Leg`/`Quote` columns, 3 instance-model `definitionKey`, `ChargeLine.zone` nullable).
- `apps/api/src/seed/reference-seed.ts` (`CHARGE_LINE_DEFINITIONS` + upsert loop).
- `apps/api/src/modules/rfq/leg-context.ts` (surface selection + toggle), `rfq.service.ts` (freeze + F7/F8), `ff-portal.service.ts` (snapshot-driven seeding + submit gate).
- `apps/api/src/modules/legs/legs.service.ts` (handle new fields in the mediated tx), `leg.impact.ts` (declare RfqDefining), `apps/api/src/modules/queries/*` (`shapeQuery` new leg fields).
- `apps/web/src/features/rfq-workspace/LegPanel.tsx` (mount the two controls), `apps/web/src/features/ff-portal/{draftFromDto.ts,LegSection.tsx}`.

---

## Phase A — Shared foundation (types + engine)

### Task 1: Charge-config types & enums

**Files:**
- Create: `packages/shared/src/charge-config.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/charge-config.test.ts` (added in Task 3)

**Interfaces — Produces:** `ChargeLineRole`, `ChargeLineInputType` (+ `CHARGE_LINE_ROLES`, `CHARGE_LINE_INPUT_TYPES`), `ChargeLineDefinitionDto`, `ResolvedChargeLine`, `ChargeConfigSnapshot` — consumed by every later task.

- [ ] **Step 1: Create `packages/shared/src/charge-config.ts`**

```ts
import type { FreightMode } from "./config";
import type { ChargeZone } from "./quote";

// Role = when/how a catalogue line is included on the FF portal.
export const ChargeLineRole = {
  CORE: "CORE",           // always shown & priced (Air/Sea Zones 1-2, Road trucking)
  STANDARD: "STANDARD",   // Executive-selected (popover "Standard")
  TAG_DRIVEN: "TAG_DRIVEN", // Executive-selected (popover "Tag-driven"); tagKey inert this build (design §13)
  WAREHOUSE: "WAREHOUSE", // included via the per-leg warehouse toggle, never the popover
} as const;
export type ChargeLineRole = (typeof ChargeLineRole)[keyof typeof ChargeLineRole];
export const CHARGE_LINE_ROLES = Object.values(ChargeLineRole) as [ChargeLineRole, ...ChargeLineRole[]];

// InputType = how the FF prices it / which instance table stores the amount.
export const ChargeLineInputType = {
  PLAIN: "PLAIN",                       // ChargeLine {amount, note}
  TRUCKING: "TRUCKING",                 // TruckingCharge {type, basis, amount, remarks}
  WAREHOUSE_STAGING: "WAREHOUSE_STAGING", // WarehouseStagingLine {amount, cargoAcceptanceWindow}
} as const;
export type ChargeLineInputType = (typeof ChargeLineInputType)[keyof typeof ChargeLineInputType];
export const CHARGE_LINE_INPUT_TYPES = Object.values(ChargeLineInputType) as [
  ChargeLineInputType,
  ...ChargeLineInputType[],
];

// A catalogue row as served to the Executive popover and read at distribute-time resolution.
export interface ChargeLineDefinitionDto {
  id: string;
  key: string;
  mode: FreightMode;
  role: ChargeLineRole;
  inputType: ChargeLineInputType;
  zone: ChargeZone | null;   // ORIGIN|MAIN_FREIGHT|DESTINATION for Air/Sea; null for Road
  tagKey: string | null;     // reserved/inert this build (design §13)
  label: string;
  sortOrder: number;
  isActive: boolean;
}

// A resolved PLAIN charge line frozen onto a Quote at distribute (cores + selected).
export interface ResolvedChargeLine {
  definitionKey: string;
  role: ChargeLineRole;
  inputType: ChargeLineInputType;
  zone: ChargeZone | null;
  label: string;
}

// The per-quote frozen snapshot (design §5.4 / §7).
export interface ChargeConfigSnapshot {
  lines: ResolvedChargeLine[];   // all PLAIN, all mandatory-to-price
  warehouseIncluded: boolean;
}
```

- [ ] **Step 2: Export it from the barrel** — append to `packages/shared/src/index.ts` (after the `./quote` line):

```ts
export * from "./charge-config";
```

- [ ] **Step 3: Build shared + typecheck**

Run: `pnpm --filter @svyft/shared build && pnpm --filter @svyft/shared typecheck`
Expected: PASS (no emit errors; `dist/charge-config.js` + `.d.ts` produced).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/charge-config.ts packages/shared/src/index.ts
git commit -m "feat(shared): charge-config catalogue types + role/inputType enums"
```

---

### Task 2: Extend quote draft & FF-portal DTOs for snapshot-driven charges

**Files:**
- Modify: `packages/shared/src/quote.ts:27-29` (`QuoteDraftCharge`)
- Modify: `packages/shared/src/ff-portal.ts:16` (`FfPortalSeededCharge`) + `:18-28` (`FfPortalLegDto`) + `:49-52` (`quoteDraftSchema.charges`)

**Interfaces — Produces:** `QuoteDraftCharge.zone: ChargeZone | null` + `definitionKey?: string | null`; `FfPortalSeededCharge` carrying `definitionKey`/`inputType`/nullable `zone`; `FfPortalLegDto.warehouseIncluded`.

- [ ] **Step 1: Widen `QuoteDraftCharge`** — `packages/shared/src/quote.ts:27-29`, replace:

```ts
export interface QuoteDraftCharge {
  zone: ChargeZone | null; definitionKey?: string | null; presetKey: string | null; label: string; amount: number | null; note?: string;
}
```
(`zone` is now nullable for Road configured lines; `definitionKey` links a seeded line back to its catalogue row. `presetKey` stays for FF `[+ Add Charge]` custom lines — both null on a custom line.)

- [ ] **Step 2: Update `FfPortalSeededCharge` + `FfPortalLegDto`** — `packages/shared/src/ff-portal.ts`:

```ts
import type { ChargeLineInputType } from "./charge-config";
// ...
export interface FfPortalSeededCharge {
  zone: ChargeZone | null;
  definitionKey: string;
  inputType: ChargeLineInputType;   // PLAIN here; TRUCKING/WAREHOUSE_STAGING seed via endpoints
  presetKey: string | null;         // null for catalogue lines (kept for shape compatibility)
  label: string;
  isPreset: true;
  amount: null;
}
```
And add to `FfPortalLegDto` (after `seededCharges`):
```ts
  warehouseIncluded: boolean;   // frozen Leg warehouse decision (design §9)
```

- [ ] **Step 3: Widen the `quoteDraftSchema.charges` shape-check** — `packages/shared/src/ff-portal.ts:49-52`:

```ts
    charges: z.array(z.object({
      zone: z.enum(CHARGE_ZONES).nullable(), definitionKey: z.string().nullable().optional(),
      presetKey: z.string().nullable(), label: z.string(),
      amount: z.number().nullable(), note: z.string().optional(),
    })),
```

- [ ] **Step 4: Build shared + typecheck**

Run: `pnpm --filter @svyft/shared build && pnpm --filter @svyft/shared typecheck`
Expected: PASS. (Type errors in `apps/api`/`apps/web` are expected until later tasks — do not fix them here; only the shared package must compile.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/quote.ts packages/shared/src/ff-portal.ts
git commit -m "feat(shared): snapshot-driven charge DTOs (definitionKey, nullable zone, warehouseIncluded)"
```

---

### Task 3: `resolveChargeConfig()` — the distribute-time resolver

**Files:**
- Modify: `packages/shared/src/charge-config.ts`
- Test: `packages/shared/src/charge-config.test.ts`

**Interfaces — Consumes:** `ChargeLineDefinitionDto`, `ChargeConfigSnapshot` (Task 1). **Produces:** `resolveChargeConfig(defs, selectedKeys, warehouseIncluded) → ChargeConfigSnapshot`.

- [ ] **Step 1: Write the failing test** — `packages/shared/src/charge-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveChargeConfig, type ChargeLineDefinitionDto } from "./charge-config";

const def = (p: Partial<ChargeLineDefinitionDto> & { key: string; role: ChargeLineDefinitionDto["role"] }): ChargeLineDefinitionDto => ({
  id: p.key, key: p.key, mode: "AIR", role: p.role, inputType: p.inputType ?? "PLAIN",
  zone: p.zone ?? "DESTINATION", tagKey: p.tagKey ?? null, label: p.label ?? p.key,
  sortOrder: p.sortOrder ?? 0, isActive: p.isActive ?? true,
});

describe("resolveChargeConfig", () => {
  const defs = [
    def({ key: "AIR_ORIGIN_THC", role: "CORE", zone: "ORIGIN", sortOrder: 1 }),
    def({ key: "AIR_DEST_THC", role: "STANDARD", zone: "DESTINATION", sortOrder: 2 }),
    def({ key: "AIR_DEST_STORAGE", role: "STANDARD", zone: "DESTINATION", sortOrder: 3 }),
    def({ key: "AIR_TAG_FRAGILE", role: "TAG_DRIVEN", zone: "DESTINATION", tagKey: "FRAGILE", sortOrder: 4 }),
    def({ key: "ROAD_CORE_TRUCKING", role: "CORE", inputType: "TRUCKING", zone: null, sortOrder: 0 }),
    def({ key: "ROAD_WH_HANDLING", role: "WAREHOUSE", inputType: "WAREHOUSE_STAGING", zone: null, sortOrder: 9 }),
  ];

  it("always includes CORE PLAIN lines and excludes unselected optionals", () => {
    const snap = resolveChargeConfig(defs, [], false);
    expect(snap.lines.map((l) => l.definitionKey)).toEqual(["AIR_ORIGIN_THC"]);
    expect(snap.warehouseIncluded).toBe(false);
  });

  it("includes selected STANDARD + TAG_DRIVEN lines, ordered by sortOrder", () => {
    const snap = resolveChargeConfig(defs, ["AIR_DEST_THC", "AIR_TAG_FRAGILE"], true);
    expect(snap.lines.map((l) => l.definitionKey)).toEqual(["AIR_ORIGIN_THC", "AIR_DEST_THC", "AIR_TAG_FRAGILE"]);
    expect(snap.warehouseIncluded).toBe(true);
  });

  it("never puts TRUCKING or WAREHOUSE_STAGING lines in the PLAIN snapshot set", () => {
    const snap = resolveChargeConfig(defs, ["ROAD_WH_HANDLING"], true);
    expect(snap.lines.some((l) => l.inputType !== "PLAIN")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/shared exec vitest run src/charge-config.test.ts`
Expected: FAIL — `resolveChargeConfig is not a function`.

- [ ] **Step 3: Implement `resolveChargeConfig`** — append to `packages/shared/src/charge-config.ts`:

```ts
/**
 * Resolve the effective mandatory-to-price PLAIN charge set for a leg at distribute (design §7).
 * CORE lines are always included; STANDARD/TAG_DRIVEN only when their key is selected.
 * TRUCKING/WAREHOUSE_STAGING lines are excluded here — they are priced via the draft's
 * `trucking`/`warehouse` arrays; warehouse presence is governed by `warehouseIncluded`.
 * No tag filtering (design §13: tag-driven activation is deferred).
 */
export function resolveChargeConfig(
  definitions: ChargeLineDefinitionDto[],
  selectedKeys: string[],
  warehouseIncluded: boolean,
): ChargeConfigSnapshot {
  const selected = new Set(selectedKeys);
  const lines: ResolvedChargeLine[] = definitions
    .filter((d) => d.isActive && d.inputType === "PLAIN")
    .filter((d) => d.role === "CORE" || ((d.role === "STANDARD" || d.role === "TAG_DRIVEN") && selected.has(d.key)))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => ({ definitionKey: d.key, role: d.role, inputType: d.inputType, zone: d.zone, label: d.label }));
  return { lines, warehouseIncluded };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @svyft/shared exec vitest run src/charge-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Build + typecheck (incl. the test file) + commit**

Run: `pnpm --filter @svyft/shared build && npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit packages/shared/src/charge-config.test.ts --moduleResolution bundler --module esnext --skipLibCheck`
Expected: PASS.
```bash
git add packages/shared/src/charge-config.ts packages/shared/src/charge-config.test.ts
git commit -m "feat(shared): resolveChargeConfig (cores + selected → frozen snapshot)"
```

---

### Task 4: Quote-engine — null-zone totals bucket + Q1 rewrite

**Files:**
- Modify: `packages/shared/src/quote-engine.ts:11-36` (`QuoteTotals`/`computeQuoteTotals`) + `:38-56` (`validateQuote` Q1)
- Test: `packages/shared/src/quote-engine.test.ts` (extend)

**Interfaces — Consumes:** `ChargeConfigSnapshot` (Task 1). **Produces:** `computeQuoteTotals` with a `configuredSubtotal`; `validateQuote(draft, deadlineIso, nowIso, mandatoryLines?: ResolvedChargeLine[])`.

- [ ] **Step 1: Write the failing tests** — add to `packages/shared/src/quote-engine.test.ts`:

```ts
import { validateQuote as vq } from "./quote-engine";
import type { ResolvedChargeLine } from "./charge-config";

describe("configured (zone=null) charges", () => {
  it("sums null-zone Road charges into configuredSubtotal + grandTotal", () => {
    const road: QuoteDraft = { ...base, mode: "ROAD",
      charges: [{ zone: null, definitionKey: "ROAD_STD_INSURANCE", presetKey: null, label: "Insurance", amount: 120 }],
      cargo: [{ cargoItemId: "c1", grossWtT: 1, cbm: 1, isDangerous: false, freightDensity: 333 }],
      trucking: [{ legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: 300 }] };
    const t = computeQuoteTotals(road);
    expect(t.configuredSubtotal).toBe(120);
    expect(t.grandTotal).toBe(420);
  });
});

describe("Q1 from the frozen mandatory set", () => {
  const mandatory: ResolvedChargeLine[] = [
    { definitionKey: "AIR_ORIGIN_THC", role: "CORE", inputType: "PLAIN", zone: "ORIGIN", label: "Origin THC" },
    { definitionKey: "AIR_DEST_THC", role: "STANDARD", inputType: "PLAIN", zone: "DESTINATION", label: "Dest THC" },
  ];
  const deadline = "2099-01-01T00:00:00.000Z";
  it("blocks when a mandatory configured line is unpriced", () => {
    const draft: QuoteDraft = { ...base,
      charges: [{ zone: "ORIGIN", definitionKey: "AIR_ORIGIN_THC", presetKey: null, label: "Origin THC", amount: 100 }] };
    const f = vq(draft, deadline, "2020-01-01T00:00:00.000Z", mandatory);
    expect(f.some((x) => x.rule === "Q1" && x.message.includes("Dest THC"))).toBe(true);
  });
  it("passes when all mandatory lines are priced (0 allowed)", () => {
    const draft: QuoteDraft = { ...base,
      charges: [
        { zone: "ORIGIN", definitionKey: "AIR_ORIGIN_THC", presetKey: null, label: "Origin THC", amount: 0 },
        { zone: "DESTINATION", definitionKey: "AIR_DEST_THC", presetKey: null, label: "Dest THC", amount: 250 },
      ] };
    const f = vq(draft, deadline, "2020-01-01T00:00:00.000Z", mandatory);
    expect(f.some((x) => x.rule === "Q1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/shared exec vitest run src/quote-engine.test.ts`
Expected: FAIL — `configuredSubtotal` undefined; `vq` arity mismatch.

- [ ] **Step 3: Add the null-zone bucket** — `packages/shared/src/quote-engine.ts`, replace `QuoteTotals` + the charge loop + `grandTotal` in `computeQuoteTotals`:

```ts
export interface QuoteTotals {
  zoneSubtotals: { origin: number; mainFreight: number; destination: number };
  configuredSubtotal: number;
  truckingSubtotal: number;
  warehouseSubtotal: number;
  totalChargeableWeightT: number;
  grandTotal: number;
}
```
```ts
  const zoneSubtotals = { origin: 0, mainFreight: 0, destination: 0 };
  let configuredSubtotal = 0;
  for (const c of draft.charges) {
    const amt = c.amount ?? 0;
    if (c.zone === "ORIGIN") zoneSubtotals.origin += amt;
    else if (c.zone === "MAIN_FREIGHT") zoneSubtotals.mainFreight += amt;
    else if (c.zone === "DESTINATION") zoneSubtotals.destination += amt;
    else configuredSubtotal += amt; // zone === null → Road configured lines
  }
```
```ts
  const grandTotal =
    zoneSubtotals.origin + zoneSubtotals.mainFreight + zoneSubtotals.destination +
    configuredSubtotal + truckingSubtotal + warehouseSubtotal;
  return { zoneSubtotals, configuredSubtotal, truckingSubtotal, warehouseSubtotal, totalChargeableWeightT, grandTotal };
```

- [ ] **Step 4: Rewrite Q1** — `packages/shared/src/quote-engine.ts`, change the signature and the Q1 block (replace lines 38 + 47-56). Remove the `AIR_CHARGE_PRESETS`/`SEA_CHARGE_PRESETS` import usage:

```ts
import type { ResolvedChargeLine } from "./charge-config";
// ...
export function validateQuote(
  draft: QuoteDraft, deadlineIso: string, nowIso: string, mandatoryLines: ResolvedChargeLine[] = [],
): Finding[] {
```
```ts
  // Q1 — every frozen mandatory PLAIN line must be priced (0 allowed). Road trucking blocks too.
  const priced = new Set(draft.charges.filter((c) => c.amount != null).map((c) => c.definitionKey ?? undefined));
  for (const line of mandatoryLines)
    if (!priced.has(line.definitionKey)) f.push(blk("Q1", `Charge line "${line.label}" must be priced`, leg));
  if (draft.mode === "ROAD")
    for (const t of draft.trucking)
      if (t.amount == null) f.push(blk("Q1", "A trucking charge is required for every pickup/drop block", leg));
```

- [ ] **Step 5: Run tests + full shared suite**

Run: `pnpm --filter @svyft/shared exec vitest run`
Expected: PASS (new tests green; update any prior `validateQuote(...)` call in the existing test file that relied on preset-derived Q1 — pass the `mandatoryLines` arg where those cases assert Q1).

- [ ] **Step 6: Build + typecheck + lint + commit**

Run: `pnpm --filter @svyft/shared build && pnpm --filter @svyft/shared typecheck && pnpm --filter @svyft/shared lint`
Expected: PASS.
```bash
git add packages/shared/src/quote-engine.ts packages/shared/src/quote-engine.test.ts
git commit -m "feat(shared): configuredSubtotal + Q1 driven by frozen mandatory lines"
```

---

## Phase B — Data model & seed

### Task 5: Prisma schema + hand-authored migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_add_charge_config/migration.sql`

**Interfaces — Produces:** Prisma models `ChargeLineDefinition`, `LegChargeLineSelection`; `Leg.warehouseHandlingIncluded`; `Quote.chargeConfigSnapshot`; `definitionKey` on the three instance models; nullable `ChargeLine.zone`; enums `ChargeLineRole`/`ChargeLineInputType`.

- [ ] **Step 1: Add enums + models to `prisma/schema.prisma`** (place enums beside `ChargeZone`; models after `WarehouseStagingLine`):

```prisma
enum ChargeLineRole {
  CORE
  STANDARD
  TAG_DRIVEN
  WAREHOUSE
}

enum ChargeLineInputType {
  PLAIN
  TRUCKING
  WAREHOUSE_STAGING
}

model ChargeLineDefinition {
  id         String              @id @default(uuid()) @db.Uuid
  key        String              @unique
  mode       FreightMode
  role       ChargeLineRole
  inputType  ChargeLineInputType @default(PLAIN)
  zone       ChargeZone?
  tagKey     String?
  label      String
  sortOrder  Int                 @default(0)
  isActive   Boolean             @default(true)
  createdAt  DateTime            @default(now())
  updatedAt  DateTime            @updatedAt

  selections LegChargeLineSelection[]

  @@index([mode, role, isActive])
}

model LegChargeLineSelection {
  id           String               @id @default(uuid()) @db.Uuid
  tenantId     String?              @db.Uuid
  legId        String               @db.Uuid
  leg          Leg                  @relation(fields: [legId], references: [id], onDelete: Cascade)
  definitionId String               @db.Uuid
  definition   ChargeLineDefinition @relation(fields: [definitionId], references: [id], onDelete: Restrict)
  createdAt    DateTime             @default(now())

  @@unique([legId, definitionId])
  @@index([legId])
}
```

- [ ] **Step 2: Add columns + relations to existing models** — in `prisma/schema.prisma`:
  - `model Leg` (after `targetDelivery`): `warehouseHandlingIncluded Boolean?` and (in the relations block) `chargeSelections LegChargeLineSelection[]`.
  - `model Quote` (after `manifestSnapshot`): `chargeConfigSnapshot Json?`.
  - `model ChargeLine`: change `zone ChargeZone` → `zone ChargeZone?`; add `definitionKey String?`.
  - `model TruckingCharge`: add `definitionKey String?`.
  - `model WarehouseStagingLine`: add `definitionKey String?`.

- [ ] **Step 3: Hand-author the migration** — create `prisma/migrations/<UTC-ts>_add_charge_config/migration.sql` (e.g. `20260804120000_add_charge_config`):

```sql
CREATE TYPE "ChargeLineRole" AS ENUM ('CORE', 'STANDARD', 'TAG_DRIVEN', 'WAREHOUSE');
CREATE TYPE "ChargeLineInputType" AS ENUM ('PLAIN', 'TRUCKING', 'WAREHOUSE_STAGING');

CREATE TABLE "ChargeLineDefinition" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "mode" "FreightMode" NOT NULL,
    "role" "ChargeLineRole" NOT NULL,
    "inputType" "ChargeLineInputType" NOT NULL DEFAULT 'PLAIN',
    "zone" "ChargeZone",
    "tagKey" TEXT,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChargeLineDefinition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChargeLineDefinition_key_key" ON "ChargeLineDefinition"("key");
CREATE INDEX "ChargeLineDefinition_mode_role_isActive_idx" ON "ChargeLineDefinition"("mode", "role", "isActive");

CREATE TABLE "LegChargeLineSelection" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "legId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LegChargeLineSelection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LegChargeLineSelection_legId_definitionId_key" ON "LegChargeLineSelection"("legId", "definitionId");
CREATE INDEX "LegChargeLineSelection_legId_idx" ON "LegChargeLineSelection"("legId");
ALTER TABLE "LegChargeLineSelection" ADD CONSTRAINT "LegChargeLineSelection_legId_fkey"
    FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LegChargeLineSelection" ADD CONSTRAINT "LegChargeLineSelection_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "ChargeLineDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Leg" ADD COLUMN "warehouseHandlingIncluded" BOOLEAN;
ALTER TABLE "Quote" ADD COLUMN "chargeConfigSnapshot" JSONB;
ALTER TABLE "ChargeLine" ALTER COLUMN "zone" DROP NOT NULL;
ALTER TABLE "ChargeLine" ADD COLUMN "definitionKey" TEXT;
ALTER TABLE "TruckingCharge" ADD COLUMN "definitionKey" TEXT;
ALTER TABLE "WarehouseStagingLine" ADD COLUMN "definitionKey" TEXT;
```

- [ ] **Step 4: Apply + regenerate**

Run:
```bash
set -a; . apps/api/.env; set +a
pnpm exec prisma migrate deploy --schema prisma/schema.prisma
pnpm exec prisma generate --schema prisma/schema.prisma
```
Expected: `add_charge_config` applied; client regenerated with `prisma.chargeLineDefinition` / `prisma.legChargeLineSelection`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): charge catalogue tables, leg/quote columns, nullable ChargeLine.zone"
```

---

### Task 6: Seed the catalogue + seed-regression test

**Files:**
- Modify: `apps/api/src/seed/reference-seed.ts`
- Test: `apps/api/test/charge-catalogue.e2e-spec.ts`

**Interfaces — Consumes:** `prisma.chargeLineDefinition` (Task 5). **Produces:** the seeded catalogue (create-only upsert by `key`), covering today's per-mode line-up + new Road/tag lines, 3 rows `isActive:false`.

- [ ] **Step 1: Add the catalogue const + upsert loop** — in `apps/api/src/seed/reference-seed.ts`, add the array (top, beside `DENSITY`/`CHECKLIST`) and the loop (inside `seedReferenceData`, beside the density loop):

```ts
type ChargeDef = {
  key: string; mode: "ROAD" | "AIR" | "SEA"; role: "CORE" | "STANDARD" | "TAG_DRIVEN" | "WAREHOUSE";
  inputType?: "PLAIN" | "TRUCKING" | "WAREHOUSE_STAGING"; zone?: "ORIGIN" | "MAIN_FREIGHT" | "DESTINATION" | null;
  tagKey?: string | null; label: string; sortOrder: number; isActive?: boolean;
};
const CHARGE_LINE_DEFINITIONS: ChargeDef[] = [
  // ── AIR cores (Zones 1-2) ──
  { key: "AIR_ORIGIN_EXPORT_CLEARANCE", mode: "AIR", role: "CORE", zone: "ORIGIN", label: "Export Customs Clearance", sortOrder: 1 },
  { key: "AIR_ORIGIN_DOCUMENTATION", mode: "AIR", role: "CORE", zone: "ORIGIN", label: "Documentation Charges", sortOrder: 2 },
  { key: "AIR_ORIGIN_THC", mode: "AIR", role: "CORE", zone: "ORIGIN", label: "Origin THC / Airport Handling", sortOrder: 3 },
  { key: "AIR_ORIGIN_SECURITY", mode: "AIR", role: "CORE", zone: "ORIGIN", label: "Security / Screening Charges", sortOrder: 4 },
  { key: "AIR_ORIGIN_WAREHOUSE_PRESTORAGE", mode: "AIR", role: "CORE", zone: "ORIGIN", label: "Warehouse / Pre-storage at OAP", sortOrder: 5 },
  { key: "AIR_MAIN_FREIGHT", mode: "AIR", role: "CORE", zone: "MAIN_FREIGHT", label: "Air Freight Charges", sortOrder: 6 },
  { key: "AIR_MAIN_SEC", mode: "AIR", role: "CORE", zone: "MAIN_FREIGHT", label: "Security Exchange (SEC)", sortOrder: 7 },
  { key: "AIR_MAIN_CARRIER_SURCHARGE", mode: "AIR", role: "CORE", zone: "MAIN_FREIGHT", label: "Airline / Carrier Surcharge", sortOrder: 8 },
  { key: "AIR_MAIN_HEAVY_WEIGHT", mode: "AIR", role: "CORE", zone: "MAIN_FREIGHT", label: "Heavy Weight Surcharge", sortOrder: 9 },
  // ── AIR configurable (destination) ──
  { key: "AIR_DEST_THC", mode: "AIR", role: "STANDARD", zone: "DESTINATION", label: "Destination THC / Airport Handling", sortOrder: 10 },
  { key: "AIR_DEST_IMPORT_CLEARANCE", mode: "AIR", role: "STANDARD", zone: "DESTINATION", label: "Import Customs Clearance", sortOrder: 11 },
  { key: "AIR_DEST_STORAGE", mode: "AIR", role: "STANDARD", zone: "DESTINATION", label: "Storage 1 Free Day Charges", sortOrder: 12 },
  { key: "AIR_DEST_LAST_MILE", mode: "AIR", role: "STANDARD", zone: "DESTINATION", label: "Last Mile Handling / Lift Gate", sortOrder: 13, isActive: false },
  { key: "AIR_TAG_NON_STACKABLE", mode: "AIR", role: "TAG_DRIVEN", zone: "DESTINATION", tagKey: "NON_STACKABLE", label: "Non-stackable handling", sortOrder: 14 },
  { key: "AIR_TAG_FRAGILE", mode: "AIR", role: "TAG_DRIVEN", zone: "DESTINATION", tagKey: "FRAGILE", label: "Fragile handling", sortOrder: 15 },
  { key: "AIR_TAG_DG", mode: "AIR", role: "TAG_DRIVEN", zone: "DESTINATION", tagKey: "DG", label: "DG handling", sortOrder: 16 },
  { key: "AIR_TAG_OOG", mode: "AIR", role: "TAG_DRIVEN", zone: "DESTINATION", tagKey: "OUT_OF_GAUGE", label: "OOG handling", sortOrder: 17 },
  { key: "AIR_TAG_HEAVY", mode: "AIR", role: "TAG_DRIVEN", zone: "DESTINATION", tagKey: "HEAVY", label: "Heavy handling", sortOrder: 18 },
  // ── SEA cores ──
  { key: "SEA_ORIGIN_EXPORT_CLEARANCE", mode: "SEA", role: "CORE", zone: "ORIGIN", label: "Export Customs Clearance", sortOrder: 1 },
  { key: "SEA_ORIGIN_DOCUMENTATION", mode: "SEA", role: "CORE", zone: "ORIGIN", label: "Documentation Charges", sortOrder: 2 },
  { key: "SEA_ORIGIN_THC", mode: "SEA", role: "CORE", zone: "ORIGIN", label: "Origin THC (Terminal Handling Charge)", sortOrder: 3 },
  { key: "SEA_ORIGIN_BILL_OF_LADING", mode: "SEA", role: "CORE", zone: "ORIGIN", label: "Bill of Lading", sortOrder: 4 },
  { key: "SEA_ORIGIN_WAREHOUSE", mode: "SEA", role: "CORE", zone: "ORIGIN", label: "Warehouse Charges", sortOrder: 5 },
  { key: "SEA_MAIN_FREIGHT", mode: "SEA", role: "CORE", zone: "MAIN_FREIGHT", label: "Sea Freight Charges", sortOrder: 6 },
  // ── SEA configurable (destination) ──
  { key: "SEA_DEST_THC", mode: "SEA", role: "STANDARD", zone: "DESTINATION", label: "Destination THC / Handling Charges", sortOrder: 10 },
  { key: "SEA_DEST_IMPORT_CLEARANCE", mode: "SEA", role: "STANDARD", zone: "DESTINATION", label: "Import Customs Clearance", sortOrder: 11 },
  { key: "SEA_DEST_STORAGE", mode: "SEA", role: "STANDARD", zone: "DESTINATION", label: "Storage 1 Free Day Charges", sortOrder: 12 },
  { key: "SEA_DEST_DELIVERY", mode: "SEA", role: "STANDARD", zone: "DESTINATION", label: "Delivery (Last Mile — Door to Door)", sortOrder: 13, isActive: false },
  { key: "SEA_DEST_LAST_MILE", mode: "SEA", role: "STANDARD", zone: "DESTINATION", label: "Last Mile Handling / Lift Gate", sortOrder: 14, isActive: false },
  { key: "SEA_TAG_NON_STACKABLE", mode: "SEA", role: "TAG_DRIVEN", zone: "DESTINATION", tagKey: "NON_STACKABLE", label: "Non-stackable handling", sortOrder: 15 },
  { key: "SEA_TAG_FRAGILE", mode: "SEA", role: "TAG_DRIVEN", zone: "DESTINATION", tagKey: "FRAGILE", label: "Fragile handling", sortOrder: 16 },
  { key: "SEA_TAG_DG", mode: "SEA", role: "TAG_DRIVEN", zone: "DESTINATION", tagKey: "DG", label: "DG handling", sortOrder: 17 },
  { key: "SEA_TAG_OOG", mode: "SEA", role: "TAG_DRIVEN", zone: "DESTINATION", tagKey: "OUT_OF_GAUGE", label: "OOG handling", sortOrder: 18 },
  { key: "SEA_TAG_HEAVY", mode: "SEA", role: "TAG_DRIVEN", zone: "DESTINATION", tagKey: "HEAVY", label: "Heavy handling", sortOrder: 19 },
  // ── ROAD ──
  { key: "ROAD_CORE_TRUCKING", mode: "ROAD", role: "CORE", inputType: "TRUCKING", zone: null, label: "Road Trucking", sortOrder: 1 },
  { key: "ROAD_STD_TAIL_LIFT", mode: "ROAD", role: "STANDARD", zone: null, label: "Tail-lift / lift-gate", sortOrder: 10 },
  { key: "ROAD_STD_T1_DOCUMENT", mode: "ROAD", role: "STANDARD", zone: null, label: "T1 document", sortOrder: 11 },
  { key: "ROAD_STD_OTHER_DOCUMENTS", mode: "ROAD", role: "STANDARD", zone: null, label: "Other documents", sortOrder: 12 },
  { key: "ROAD_STD_REPACKING", mode: "ROAD", role: "STANDARD", zone: null, label: "Re-packing", sortOrder: 13 },
  { key: "ROAD_STD_WEEKEND_SURCHARGE", mode: "ROAD", role: "STANDARD", zone: null, label: "Weekend / Weekday surcharge", sortOrder: 14 },
  { key: "ROAD_STD_SURCHARGES", mode: "ROAD", role: "STANDARD", zone: null, label: "Surcharges (general)", sortOrder: 15 },
  { key: "ROAD_STD_INSURANCE", mode: "ROAD", role: "STANDARD", zone: null, label: "Insurance", sortOrder: 16 },
  { key: "ROAD_STD_EXTRA_WAITING", mode: "ROAD", role: "STANDARD", zone: null, label: "Extra waiting time", sortOrder: 17 },
  { key: "ROAD_TAG_NON_STACKABLE", mode: "ROAD", role: "TAG_DRIVEN", zone: null, tagKey: "NON_STACKABLE", label: "Non-stackable handling", sortOrder: 18 },
  { key: "ROAD_TAG_FRAGILE", mode: "ROAD", role: "TAG_DRIVEN", zone: null, tagKey: "FRAGILE", label: "Fragile handling", sortOrder: 19 },
  { key: "ROAD_TAG_DG", mode: "ROAD", role: "TAG_DRIVEN", zone: null, tagKey: "DG", label: "DG handling", sortOrder: 20 },
  { key: "ROAD_TAG_OOG", mode: "ROAD", role: "TAG_DRIVEN", zone: null, tagKey: "OUT_OF_GAUGE", label: "OOG handling", sortOrder: 21 },
  { key: "ROAD_TAG_HEAVY", mode: "ROAD", role: "TAG_DRIVEN", zone: null, tagKey: "HEAVY", label: "Heavy handling", sortOrder: 22 },
  { key: "ROAD_WH_HANDLING", mode: "ROAD", role: "WAREHOUSE", inputType: "WAREHOUSE_STAGING", zone: null, label: "Warehouse handling", sortOrder: 23 },
];
```
Loop (create-only, never overwrite admin edits — mirrors the density loop):
```ts
  for (const d of CHARGE_LINE_DEFINITIONS) {
    await prisma.chargeLineDefinition.upsert({
      where: { key: d.key },
      create: {
        key: d.key, mode: d.mode, role: d.role, inputType: d.inputType ?? "PLAIN",
        zone: d.zone ?? null, tagKey: d.tagKey ?? null, label: d.label,
        sortOrder: d.sortOrder, isActive: d.isActive ?? true,
      },
      update: {},
    });
  }
```

- [ ] **Step 2: Write the failing seed-regression test** — `apps/api/test/charge-catalogue.e2e-spec.ts`:

```ts
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";

describe("charge catalogue seed", () => {
  const prisma = new PrismaService();
  beforeAll(async () => { await prisma.$connect(); await seedReferenceData(prisma); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("seeds today's per-mode line-up with 3 inactive rows", async () => {
    const rows = await prisma.chargeLineDefinition.findMany();
    const by = (m: string, r: string) => rows.filter((x) => x.mode === m && x.role === r && x.isActive);
    expect(by("AIR", "CORE")).toHaveLength(9);
    expect(by("SEA", "CORE")).toHaveLength(6);
    expect(by("AIR", "STANDARD")).toHaveLength(3);   // dest THC/import/storage (last-mile inactive)
    expect(by("SEA", "STANDARD")).toHaveLength(3);   // delivery + last-mile inactive
    expect(by("ROAD", "STANDARD")).toHaveLength(8);
    expect(rows.filter((x) => x.role === "TAG_DRIVEN")).toHaveLength(15); // 5 × 3 modes
    expect(rows.filter((x) => !x.isActive).map((x) => x.key).sort()).toEqual(
      ["AIR_DEST_LAST_MILE", "SEA_DEST_DELIVERY", "SEA_DEST_LAST_MILE"]);
    expect(rows.find((x) => x.key === "ROAD_CORE_TRUCKING")?.inputType).toBe("TRUCKING");
    expect(rows.find((x) => x.key === "ROAD_WH_HANDLING")?.role).toBe("WAREHOUSE");
  });

  it("is idempotent (second seed adds no rows)", async () => {
    const before = await prisma.chargeLineDefinition.count();
    await seedReferenceData(prisma);
    expect(await prisma.chargeLineDefinition.count()).toBe(before);
  });
});
```

- [ ] **Step 3: Run**

Run: `set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api exec jest --config test/jest-e2e.json charge-catalogue --runInBand`
Expected: PASS.

- [ ] **Step 4: Lint + commit**

Run: `pnpm --filter @svyft/api lint`
```bash
git add apps/api/src/seed/reference-seed.ts apps/api/test/charge-catalogue.e2e-spec.ts
git commit -m "feat(api): seed charge-line catalogue (create-only) + regression test"
```

---

## Phase C — API: catalogue read, distribute-freeze, portal, submit

### Task 7: Catalogue read service + GET endpoint

**Files:**
- Create: `apps/api/src/modules/config/charge-catalogue.service.ts`, `charge-catalogue.controller.ts`
- Modify: `apps/api/src/modules/config/config.module.ts` (register both)
- Test: `apps/api/test/charge-catalogue.e2e-spec.ts` (extend)

**Interfaces — Produces:** `GET /api/charge-line-definitions → ChargeLineDefinitionDto[]` (active rows, ordered), Executive+ (no `@Roles`). Consumed by the web popover (Task 12).

- [ ] **Step 1: Service** — `apps/api/src/modules/config/charge-catalogue.service.ts`:

```ts
import { Injectable } from "@nestjs/common";
import type { ChargeLineDefinitionDto } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class ChargeCatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<ChargeLineDefinitionDto[]> {
    const rows = await this.prisma.chargeLineDefinition.findMany({
      where: { isActive: true },
      orderBy: [{ mode: "asc" }, { sortOrder: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id, key: r.key, mode: r.mode, role: r.role, inputType: r.inputType,
      zone: r.zone, tagKey: r.tagKey, label: r.label, sortOrder: r.sortOrder, isActive: r.isActive,
    }));
  }
}
```

- [ ] **Step 2: Controller** — `apps/api/src/modules/config/charge-catalogue.controller.ts` (auth-only; mirrors the RBAC of workflow reads):

```ts
import { Controller, Get } from "@nestjs/common";
import type { ChargeLineDefinitionDto } from "@svyft/shared";
import { ChargeCatalogueService } from "./charge-catalogue.service";

@Controller("charge-line-definitions")
export class ChargeCatalogueController {
  constructor(private readonly svc: ChargeCatalogueService) {}

  @Get()
  list(): Promise<ChargeLineDefinitionDto[]> {
    return this.svc.list();
  }
}
```

- [ ] **Step 3: Register** in `config.module.ts` — add `ChargeCatalogueService` to `providers` and `ChargeCatalogueController` to `controllers`.

- [ ] **Step 4: Extend the e2e** — add to `apps/api/test/charge-catalogue.e2e-spec.ts` a full-`AppModule` case (mirror `rfq-selection.e2e-spec.ts` bootstrap): authenticated `GET /api/charge-line-definitions` returns only `isActive` rows and excludes the 3 inactive keys. Assert `res.body.every(r => r.isActive)` and `200`.

- [ ] **Step 5: Run + lint + commit**

Run: `set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api exec jest --config test/jest-e2e.json charge-catalogue --runInBand && pnpm --filter @svyft/api lint`
```bash
git add apps/api/src/modules/config/charge-catalogue.* apps/api/src/modules/config/config.module.ts apps/api/test/charge-catalogue.e2e-spec.ts
git commit -m "feat(api): GET /charge-line-definitions catalogue endpoint"
```

---

### Task 8: Resolve-and-freeze `chargeConfigSnapshot` at distribute

**Files:**
- Create: `apps/api/src/modules/rfq/charge-config.snapshot.ts`
- Modify: `apps/api/src/modules/rfq/leg-context.ts` (surface selection + toggle), `rfq.service.ts:358-368` (freeze beside manifest)
- Test: `apps/api/test/charge-config-distribute.e2e-spec.ts`

**Interfaces — Consumes:** `resolveChargeConfig` (Task 3), `prisma.chargeLineDefinition`, `Leg.warehouseHandlingIncluded`, `LegChargeLineSelection`. **Produces:** `Quote.chargeConfigSnapshot` populated on every distributed quote.

- [ ] **Step 1: Surface selection + toggle into the leg context** — `apps/api/src/modules/rfq/leg-context.ts`, extend `LEG_RFQ_INCLUDE`:

```ts
export const LEG_RFQ_INCLUDE = {
  originPoint: { select: { id: true, type: true, country: true, name: true, city: true } },
  destinationPoint: { select: { id: true, type: true, country: true, name: true, city: true } },
  legCargo: { include: { cargoItem: true } },
  quotes: { select: { id: true, freightForwarderId: true, status: true } },
  chargeSelections: { select: { definition: { select: { key: true } } } },
} satisfies Prisma.LegInclude;
```
(The leg row already carries `mode` and `warehouseHandlingIncluded` as scalar columns — no include needed. `originPoint`/`destinationPoint` now also select `id` + `type` for the warehouse gate in Task 10.)

- [ ] **Step 2: Snapshot builder** — `apps/api/src/modules/rfq/charge-config.snapshot.ts`:

```ts
import { resolveChargeConfig, type ChargeConfigSnapshot, type ChargeLineDefinitionDto } from "@svyft/shared";
import type { PrismaService } from "../../prisma/prisma.service";
import type { LegRfqRow } from "./leg-context";

export async function buildChargeConfigSnapshot(
  prisma: Pick<PrismaService, "chargeLineDefinition">,
  leg: LegRfqRow,
): Promise<ChargeConfigSnapshot> {
  const defs = await prisma.chargeLineDefinition.findMany({
    where: { mode: leg.mode ?? undefined, isActive: true },
  });
  const dtos: ChargeLineDefinitionDto[] = defs.map((d) => ({
    id: d.id, key: d.key, mode: d.mode, role: d.role, inputType: d.inputType,
    zone: d.zone, tagKey: d.tagKey, label: d.label, sortOrder: d.sortOrder, isActive: d.isActive,
  }));
  const selectedKeys = leg.chargeSelections.map((s) => s.definition.key);
  return resolveChargeConfig(dtos, selectedKeys, leg.warehouseHandlingIncluded === true);
}
```
(Ensure `LegRfqRow`'s payload type includes `mode` + `warehouseHandlingIncluded` — they are scalar `Leg` columns, so `Prisma.LegGetPayload<{ include: typeof LEG_RFQ_INCLUDE }>` already carries them.)

- [ ] **Step 3: Freeze at distribute** — `apps/api/src/modules/rfq/rfq.service.ts`, in `performDistribution` where the manifest is written (currently `:360-363`), resolve + write the snapshot too:

```ts
        for (const { quoteId, legCtx } of items) {
          const snapshot = buildManifestSnapshot(legCtx, query, frozenAt);
          const chargeConfig = await buildChargeConfigSnapshot(this.prisma, legCtx.leg);
          await tx.quote.update({
            where: { id: quoteId },
            data: {
              rfqId: rfq.id,
              manifestSnapshot: snapshot as unknown as Prisma.InputJsonValue,
              chargeConfigSnapshot: chargeConfig as unknown as Prisma.InputJsonValue,
            },
          });
```
Import `buildChargeConfigSnapshot` at the top of `rfq.service.ts`. (`legCtx.leg` is the `LegRfqRow`; `this.prisma` is fine for the catalogue read — it's reference data, not part of the tx's mutation set.)

- [ ] **Step 4: Write the e2e** — `apps/api/test/charge-config-distribute.e2e-spec.ts` (mirror `rfq-distribute.e2e-spec.ts` bootstrap + `seedReferenceData` in `beforeAll`): create an AIR leg, insert a `LegChargeLineSelection` for `AIR_DEST_THC`, set 1 FF to SELECT, POST distribute, then:

```ts
const quote = await prisma.quote.findFirstOrThrow({ where: { legId } });
const snap = quote.chargeConfigSnapshot as { lines: { definitionKey: string }[]; warehouseIncluded: boolean };
const keys = snap.lines.map((l) => l.definitionKey);
expect(keys).toContain("AIR_ORIGIN_THC");        // a core
expect(keys).toContain("AIR_DEST_THC");          // selected
expect(keys).not.toContain("AIR_DEST_IMPORT_CLEARANCE"); // unselected standard
expect(snap.warehouseIncluded).toBe(false);
```

- [ ] **Step 5: Run + lint + commit**

Run: `set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api exec jest --config test/jest-e2e.json charge-config-distribute --runInBand && pnpm --filter @svyft/api lint`
```bash
git add apps/api/src/modules/rfq/charge-config.snapshot.ts apps/api/src/modules/rfq/leg-context.ts apps/api/src/modules/rfq/rfq.service.ts apps/api/test/charge-config-distribute.e2e-spec.ts
git commit -m "feat(api): freeze chargeConfigSnapshot onto each quote at distribute"
```

---

### Task 9: FF-portal seeding + submit gate from the snapshot

**Files:**
- Modify: `apps/api/src/modules/ff-portal/ff-portal.service.ts` (`resolveScope:54-88` seeding; `submit:191-197` gate)
- Test: `apps/api/test/charge-config-distribute.e2e-spec.ts` (extend with a portal-scope + submit case)

**Interfaces — Consumes:** `Quote.chargeConfigSnapshot` (Task 8). **Produces:** `seededCharges` derived from the snapshot (incl. Road PLAIN lines); Q1 enforced against `snapshot.lines`.

- [ ] **Step 1: Seed from the snapshot** — `apps/api/src/modules/ff-portal/ff-portal.service.ts`, replace the preset block (`:57` + `:75-81`). Remove `AIR_CHARGE_PRESETS`/`SEA_CHARGE_PRESETS` imports:

```ts
      const snap = (q.chargeConfigSnapshot as ChargeConfigSnapshot | null) ?? { lines: [], warehouseIncluded: false };
      // ...
      return {
        // ...
        seededCharges: snap.lines
          .filter((l) => l.inputType === "PLAIN")
          .map((l) => ({
            zone: l.zone,
            definitionKey: l.definitionKey,
            inputType: l.inputType,
            presetKey: null,
            label: l.label,
            isPreset: true as const,
            amount: null,
          })),
        warehouseIncluded: snap.warehouseIncluded,
        // ...
      };
```
Add `import type { ChargeConfigSnapshot } from "@svyft/shared";` and ensure the scope query selects `chargeConfigSnapshot` (it selects `q.*` today via the token scope; confirm `chargeConfigSnapshot` is included — if the scope uses an explicit `select`, add it there).

- [ ] **Step 2: Submit gate reads the snapshot** — `ff-portal.service.ts` `submit()`, pass the frozen mandatory lines to `validateQuote` (currently `:192-197`):

```ts
    const snap = (q.chargeConfigSnapshot as ChargeConfigSnapshot | null) ?? { lines: [], warehouseIncluded: false };
    const findings: Finding[] = validateQuote(
      draft, scope.rfq.submissionDeadline.toISOString(), new Date().toISOString(), snap.lines,
    );
    if (findings.length) throw new UnprocessableEntityException({ findings });
```

- [ ] **Step 3: Warehouse gating at seeding** — in `submit()`'s draft re-derivation (`:161-164`) and in `resolveScope`, only keep a warehouse staging line when `snap.warehouseIncluded`. In the submit draft build, filter:

```ts
      warehouse: (snap.warehouseIncluded ? stored.warehouse ?? [] : []).map((w) => ({
        ...w, position: whPos[w.warehousePointId] ?? w.position,
      })),
```

- [ ] **Step 4: Extend the e2e** — add to `charge-config-distribute.e2e-spec.ts`: resolve the FF portal scope (`GET /ff/rfq/:token`) and assert `legs[0].seededCharges` contains `AIR_DEST_THC` + a core, excludes unselected; then a ROAD leg with `ROAD_STD_INSURANCE` selected yields a seeded Road charge (previously `[]`). Add a submit case: unpriced mandatory line → `422` with a `Q1` finding; all priced → `201`.

- [ ] **Step 5: Run + lint + commit**

Run: `set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api exec jest --config test/jest-e2e.json charge-config-distribute --runInBand && pnpm --filter @svyft/api lint`
```bash
git add apps/api/src/modules/ff-portal/ff-portal.service.ts apps/api/test/charge-config-distribute.e2e-spec.ts
git commit -m "feat(api): FF portal seeds + submit-gate from chargeConfigSnapshot"
```

---

## Phase D — Warehouse attribution gates

### Task 10: Warehouse util + F7/F8 distribution gates

**Files:**
- Create: `apps/api/src/modules/rfq/warehouse.util.ts`
- Modify: `apps/api/src/modules/rfq/rfq.service.ts` (`validateLegForDistribution:257-282`)
- Test: `apps/api/test/warehouse-attribution.e2e-spec.ts`

**Interfaces — Produces:** `warehousePointIds(endpoints)`, `findWarehouseYesConflict(prisma, {queryId, legId, warehousePointIds})`; distribution codes `F7_WAREHOUSE_UNDECIDED`, `F8_WAREHOUSE_DOUBLE_YES`.

- [ ] **Step 1: Warehouse util** — `apps/api/src/modules/rfq/warehouse.util.ts`:

```ts
import type { PrismaService } from "../../prisma/prisma.service";

/** The warehouse point ids a leg touches (origin/destination of PointType WAREHOUSE). */
export function warehousePointIds(
  endpoints: ({ id: string; type: string } | null | undefined)[],
): string[] {
  return endpoints
    .filter((p): p is { id: string; type: string } => !!p && p.type === "WAREHOUSE")
    .map((p) => p.id);
}

/** Another leg in the same query that already carries Yes for one of these warehouses; else null. */
export async function findWarehouseYesConflict(
  prisma: Pick<PrismaService, "leg">,
  args: { queryId: string; legId: string; warehousePointIds: string[] },
): Promise<string | null> {
  if (args.warehousePointIds.length === 0) return null;
  const sibling = await prisma.leg.findFirst({
    where: {
      queryId: args.queryId,
      id: { not: args.legId },
      warehouseHandlingIncluded: true,
      OR: [
        { originPointId: { in: args.warehousePointIds } },
        { destinationPointId: { in: args.warehousePointIds } },
      ],
    },
    select: { id: true },
  });
  return sibling?.id ?? null;
}
```

- [ ] **Step 2: Write the failing e2e** — `apps/api/test/warehouse-attribution.e2e-spec.ts` (full-`AppModule` bootstrap + `seedReferenceData`). Setup: one query, a WAREHOUSE point `w`, two ROAD legs — A `pickup→w`, B `w→delivery` — each with 1 SELECT quote and F1 fields complete. Cases:

```ts
// F7: A.warehouseHandlingIncluded = null → distribute A blocked with F7
await prisma.leg.update({ where: { id: legA }, data: { warehouseHandlingIncluded: null } });
await request(server).post(`/api/queries/${queryId}/legs/${legA}/distribute`).set("Cookie", exec)
  .send({}).expect(400).expect((r) => expect(r.body.codes).toContain("F7_WAREHOUSE_UNDECIDED"));

// F8: A=Yes and B=Yes → distribute A blocked with F8
await prisma.leg.update({ where: { id: legA }, data: { warehouseHandlingIncluded: true } });
await prisma.leg.update({ where: { id: legB }, data: { warehouseHandlingIncluded: true } });
await request(server).post(`/api/queries/${queryId}/legs/${legA}/distribute`).set("Cookie", exec)
  .send({}).expect(400).expect((r) => expect(r.body.codes).toContain("F8_WAREHOUSE_DOUBLE_YES"));

// success: A=Yes, B=No → distribute A succeeds
await prisma.leg.update({ where: { id: legB }, data: { warehouseHandlingIncluded: false } });
await request(server).post(`/api/queries/${queryId}/legs/${legA}/distribute`).set("Cookie", exec)
  .send({}).expect(201);
```

- [ ] **Step 3: Run to verify it fails**

Run: `set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api exec jest --config test/jest-e2e.json warehouse-attribution --runInBand`
Expected: FAIL — no F7/F8 codes yet (distribute returns 201 for the undecided case).

- [ ] **Step 4: Add F7/F8** — `apps/api/src/modules/rfq/rfq.service.ts`, in `validateLegForDistribution`, before `return errors;`:

```ts
    // F7 — warehouse completeness; F8 — no duplicate Yes for the same warehouse (design §10)
    const whIds = warehousePointIds([leg.originPoint, leg.destinationPoint]);
    if (whIds.length > 0) {
      if (leg.warehouseHandlingIncluded == null) errors.push("F7_WAREHOUSE_UNDECIDED");
      else if (leg.warehouseHandlingIncluded === true) {
        const conflict = await findWarehouseYesConflict(this.prisma, {
          queryId: leg.queryId, legId: leg.id, warehousePointIds: whIds,
        });
        if (conflict) errors.push("F8_WAREHOUSE_DOUBLE_YES");
      }
    }
```
Import `{ warehousePointIds, findWarehouseYesConflict }` at the top. (`leg.originPoint`/`destinationPoint` carry `id`+`type` from Task 8 Step 1; `leg.queryId`/`warehouseHandlingIncluded` are scalar columns on the context row.)

- [ ] **Step 5: Run + lint + commit**

Run: `set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api exec jest --config test/jest-e2e.json warehouse-attribution --runInBand && pnpm --filter @svyft/api lint`
Expected: PASS.
```bash
git add apps/api/src/modules/rfq/warehouse.util.ts apps/api/src/modules/rfq/rfq.service.ts apps/api/test/warehouse-attribution.e2e-spec.ts
git commit -m "feat(api): F7/F8 warehouse-attribution distribution gates"
```

---

## Phase E — Locking (SB6 mediated writes)

### Task 11: Editable leg fields + impact map + query shaper

**Files:**
- Modify: `packages/shared/src/legs.ts` (`legSaveSchema`), `packages/shared/src/query.ts` (`QueryLegDto`)
- Modify: `apps/api/src/modules/legs/leg.impact.ts`, `apps/api/src/modules/legs/legs.service.ts` (`update`)
- Modify: the query-detail shaper in `apps/api/src/modules/queries/` (produces `QueryLegDto`)
- Test: `apps/api/test/charge-config-lock.e2e-spec.ts`

**Interfaces — Consumes:** `LegChargeLineSelection`, `Leg.warehouseHandlingIncluded`, the `ChangeMediator`. **Produces:** PATCH `queries/:id/legs/:legId` accepts `chargeLineDefinitionIds` + `warehouseHandlingIncluded` (RfqDefining); `QueryLegDto` carries both; pre-distribute = free, post-distribute = `409 needsChangeOrder`.

- [ ] **Step 1: Extend `legSaveSchema`** — `packages/shared/src/legs.ts`, inside the `.object({...})` (before `reason`):

```ts
    warehouseHandlingIncluded: z.boolean().nullable().optional(),
    chargeLineDefinitionIds: z.array(z.string().uuid()).optional(),
```

- [ ] **Step 2: Declare their impact** — `apps/api/src/modules/legs/leg.impact.ts`, add to `legImpactMap`:

```ts
  warehouseHandlingIncluded: ImpactClass.RfqDefining,
  chargeLineDefinitionIds: ImpactClass.RfqDefining,
```
(The `Record<Exclude<keyof LegSaveInput, "reason"> | "@create" | "@delete", ImpactClass>` type makes this mandatory once Step 1 lands — omitting either is a compile error, which is the safety net.)

- [ ] **Step 3: Extend `QueryLegDto`** — `packages/shared/src/query.ts`, add to the type (after `assignedCargoIds`):

```ts
  warehouseHandlingIncluded: boolean | null;
  chargeLineDefinitionIds: string[];
```

- [ ] **Step 4: Handle the new fields in the mediated update** — `apps/api/src/modules/legs/legs.service.ts` `update()`:
  - Add the write-time exclusivity guard before `mediator.apply` (only when turning Yes on):

```ts
    if (input.warehouseHandlingIncluded === true) await this.assertWarehouseExclusivity(queryId, legId);
```
  - Pull `chargeLineDefinitionIds` out of the Prisma patch (it is not a `Leg` column) — change the destructure:

```ts
    const { assignedCargoIds, chargeLineDefinitionIds, readyDate, targetDelivery, ...rest } = fieldsInput;
```
  - Inside the mediator `uow` callback, after the `assignedCargoIds` block, apply the selection set:

```ts
        if (chargeLineDefinitionIds !== undefined) {
          await tx.legChargeLineSelection.deleteMany({ where: { legId } });
          if (chargeLineDefinitionIds.length)
            await tx.legChargeLineSelection.createMany({
              data: chargeLineDefinitionIds.map((definitionId) => ({ legId, definitionId, tenantId: user.tenantId })),
            });
        }
```
  - Add the guard helper (uses the Task 10 util):

```ts
  private async assertWarehouseExclusivity(queryId: string, legId: string) {
    const leg = await this.prisma.leg.findUnique({
      where: { id: legId },
      select: { originPoint: { select: { id: true, type: true } }, destinationPoint: { select: { id: true, type: true } } },
    });
    const whIds = warehousePointIds([leg?.originPoint, leg?.destinationPoint]);
    const conflict = await findWarehouseYesConflict(this.prisma, { queryId, legId, warehousePointIds: whIds });
    if (conflict)
      throw new UnprocessableEntityException({
        findings: [{ rule: "F8", severity: "blocking", scope: { type: "leg", id: legId },
          message: "Another leg already carries warehouse handling for this warehouse." }],
      });
  }
```
Import `{ warehousePointIds, findWarehouseYesConflict }` from `../rfq/warehouse.util` and `UnprocessableEntityException` from `@nestjs/common`. (`warehouseHandlingIncluded` stays in `rest`, so it flows into `tx.leg.update` as a normal column.)

- [ ] **Step 5: Shape the fields into `QueryLegDto`** — in the query-detail shaper (find it: `grep -rn "assignedCargoIds:" apps/api/src/modules/queries`). Add to the leg `include`: `chargeSelections: { select: { definitionId: true } }`, and to the leg→DTO mapping:

```ts
      warehouseHandlingIncluded: leg.warehouseHandlingIncluded ?? null,
      chargeLineDefinitionIds: leg.chargeSelections.map((s) => s.definitionId),
```

- [ ] **Step 6: Build shared, then write the failing e2e** — `apps/api/test/charge-config-lock.e2e-spec.ts`:

```ts
// pre-distribute: PATCH selection applies freely (200), reflected in GET /queries/:id
await request(server).patch(`/api/queries/${queryId}/legs/${legId}`).set("Cookie", exec)
  .send({ chargeLineDefinitionIds: [airDestThcId] }).expect(200);
// distribute the leg (1 FF selected)
await request(server).post(`/api/queries/${queryId}/legs/${legId}/distribute`).set("Cookie", exec).send({}).expect(201);
// post-distribute: same PATCH now routes to change-order (409 needsChangeOrder) without a reason
await request(server).patch(`/api/queries/${queryId}/legs/${legId}`).set("Cookie", exec)
  .send({ chargeLineDefinitionIds: [] }).expect(409)
  .expect((r) => expect(r.body.needsChangeOrder).toBe(true));
```

- [ ] **Step 7: Run + typecheck + lint + commit**

Run: `pnpm --filter @svyft/shared build && set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api exec jest --config test/jest-e2e.json charge-config-lock --runInBand && pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint`
Expected: PASS (free pre-distribute; 409 post-distribute).
```bash
git add packages/shared/src/legs.ts packages/shared/src/query.ts apps/api/src/modules/legs apps/api/src/modules/queries apps/api/test/charge-config-lock.e2e-spec.ts
git commit -m "feat(api): mediated leg charge-selection + warehouse toggle (RfqDefining, locked post-distribute)"
```

---

## Phase F — Web: Executive Leg-Panel controls

### Task 12: Catalogue hook + mutations + Configure-charges popover

**Files:**
- Create: `apps/web/src/features/rfq-workspace/useChargeConfig.ts`, `ConfigureChargesPopover.tsx`
- Test: `apps/web/src/features/rfq-workspace/ConfigureChargesPopover.test.tsx`

**Interfaces — Consumes:** `GET /api/charge-line-definitions` (Task 7); PATCH `queries/:id/legs/:legId` (Task 11). **Produces:** `useChargeCatalogue()`, `useSetChargeSelection(queryId, legId)`, `useSetWarehouseHandling(queryId, legId)`; `<ConfigureChargesPopover leg catalogue disabled />`.

- [ ] **Step 1: Hooks** — `apps/web/src/features/rfq-workspace/useChargeConfig.ts`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChargeLineDefinitionDto } from "@svyft/shared";
import { fetchJson, patchJson } from "@/lib/api";

export function useChargeCatalogue() {
  return useQuery({
    queryKey: ["charge-catalogue"],
    queryFn: () => fetchJson<ChargeLineDefinitionDto[]>("/api/charge-line-definitions"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSetChargeSelection(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chargeLineDefinitionIds: string[]) =>
      patchJson(`/api/queries/${queryId}/legs/${legId}`, { chargeLineDefinitionIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["query", queryId] }),
  });
}

export function useSetWarehouseHandling(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (warehouseHandlingIncluded: boolean) =>
      patchJson(`/api/queries/${queryId}/legs/${legId}`, { warehouseHandlingIncluded }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["query", queryId] }),
  });
}
```

- [ ] **Step 2: Popover component** — `apps/web/src/features/rfq-workspace/ConfigureChargesPopover.tsx`:

```tsx
import { useMemo, useState } from "react";
import type { ChargeLineDefinitionDto, QueryLegDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { useSetChargeSelection } from "./useChargeConfig";

export function ConfigureChargesPopover({
  queryId, leg, catalogue, disabled,
}: { queryId: string; leg: QueryLegDto; catalogue: ChargeLineDefinitionDto[]; disabled: boolean }) {
  const mut = useSetChargeSelection(queryId, leg.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(leg.chargeLineDefinitionIds));
  const forMode = useMemo(() => catalogue.filter((c) => c.mode === leg.mode), [catalogue, leg.mode]);
  const cores = forMode.filter((c) => c.role === "CORE");
  const standard = forMode.filter((c) => c.role === "STANDARD");
  const tagDriven = forMode.filter((c) => c.role === "TAG_DRIVEN");

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id); else next.delete(id);
    setSelected(next);
    mut.mutate([...next]);
  };
  const Section = ({ title, rows }: { title: string; rows: ChargeLineDefinitionDto[] }) =>
    rows.length === 0 ? null : (
      <div className="space-y-1">
        <p className="text-xs font-semibold text-muted-foreground">{title}</p>
        {rows.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <Checkbox checked={selected.has(c.id)} disabled={disabled}
              onCheckedChange={(v) => toggle(c.id, v === true)} />
            {c.label}
          </label>
        ))}
      </div>
    );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">Configure charges ({selected.size})</Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3">
        <Section title="Standard" rows={standard} />
        <Section title="Tag-driven" rows={tagDriven} />
        {cores.length > 0 && (
          <p className="border-t pt-2 text-xs text-muted-foreground">
            Always included: {cores.map((c) => c.label).join(", ")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
```
(If `@/components/ui/popover` does not exist, `grep -rn "PopoverTrigger" apps/web/src/components/ui` to confirm; the repo uses shadcn/ui primitives — add the popover primitive with the same pattern as existing ones if missing.)

- [ ] **Step 3: Write the test** — `ConfigureChargesPopover.test.tsx` (mirror `LegPanel.test.tsx`): render inside `QueryClientProvider`, stub fetch, open the popover, assert the Standard/Tag-driven headings + the cores note render, toggling a checkbox calls `PATCH …/legs/:id` with the new id set. Assert `disabled` hides the checkboxes' interactivity.

- [ ] **Step 4: Run + typecheck + lint + commit**

Run: `pnpm --filter @svyft/web exec vitest run src/features/rfq-workspace/ConfigureChargesPopover.test.tsx && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint`
```bash
git add apps/web/src/features/rfq-workspace/useChargeConfig.ts apps/web/src/features/rfq-workspace/ConfigureChargesPopover.tsx apps/web/src/features/rfq-workspace/ConfigureChargesPopover.test.tsx
git commit -m "feat(web): Configure-charges popover + catalogue/selection hooks"
```

---

### Task 13: Warehouse toggle + mount both controls in the Leg Panel

**Files:**
- Create: `apps/web/src/features/rfq-workspace/WarehouseHandlingToggle.tsx`
- Modify: `apps/web/src/features/rfq-workspace/LegPanel.tsx`
- Test: `apps/web/src/features/rfq-workspace/LegPanel.test.tsx` (extend)

**Interfaces — Consumes:** `useSetWarehouseHandling` (Task 12), `useChargeCatalogue`. **Produces:** the two controls rendered above `FfSelectionGrid`, read-only once the leg is distributed.

- [ ] **Step 1: Toggle component** — `apps/web/src/features/rfq-workspace/WarehouseHandlingToggle.tsx`:

```tsx
import type { QueryLegDto, QueryPointDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { useSetWarehouseHandling } from "./useChargeConfig";

export function legTouchesWarehouse(leg: QueryLegDto, points: QueryPointDto[]): boolean {
  const t = (id: string | null) => points.find((p) => p.id === id)?.type;
  return t(leg.originPointId) === "WAREHOUSE" || t(leg.destinationPointId) === "WAREHOUSE";
}

export function WarehouseHandlingToggle({
  queryId, leg, disabled,
}: { queryId: string; leg: QueryLegDto; disabled: boolean }) {
  const mut = useSetWarehouseHandling(queryId, leg.id);
  const set = (v: boolean) =>
    mut.mutate(v, {
      onError: (e) => {
        if (e instanceof ApiError && e.status === 409) alert("This change routes through a change-order (leg already distributed).");
        else if (e instanceof ApiError && e.findings?.length) alert(e.findings[0].message);
      },
    });
  const val = leg.warehouseHandlingIncluded;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Warehouse handling included?</span>
      <Button size="sm" variant={val === true ? "default" : "outline"} disabled={disabled} onClick={() => set(true)}>Yes</Button>
      <Button size="sm" variant={val === false ? "default" : "outline"} disabled={disabled} onClick={() => set(false)}>No</Button>
      {val == null && <span className="text-xs text-amber-600">Decision required to distribute</span>}
    </div>
  );
}
```

- [ ] **Step 2: Mount both in `LegPanel`** — `apps/web/src/features/rfq-workspace/LegPanel.tsx`, add the catalogue hook + a block **above** the existing FF-selection `<div className="space-y-2">` (line 91). Reuse the existing `hasSent` (line 51) as the read-only signal:

```tsx
import { useChargeCatalogue } from "./useChargeConfig";
import { ConfigureChargesPopover } from "./ConfigureChargesPopover";
import { WarehouseHandlingToggle, legTouchesWarehouse } from "./WarehouseHandlingToggle";
// ...inside the component, before the return:
  const catalogue = useChargeCatalogue();
// ...inside the expanded body, immediately BEFORE the `Forwarders covering …` block:
          <div className="space-y-3 border-b border-border pb-4">
            {catalogue.data && (
              <ConfigureChargesPopover queryId={queryId} leg={leg} catalogue={catalogue.data} disabled={hasSent} />
            )}
            {legTouchesWarehouse(leg, points) && (
              <WarehouseHandlingToggle queryId={queryId} leg={leg} disabled={hasSent} />
            )}
          </div>
```

- [ ] **Step 3: Extend `LegPanel.test.tsx`** — add cases: (a) a Road leg with a WAREHOUSE endpoint renders the toggle; a leg without one does not (`legTouchesWarehouse` false); (b) once `legQuotes` contains a non-SELECT quote, the "Configure charges" trigger + toggle buttons are `disabled`. Stub `GET /api/charge-line-definitions` via `mockFetch`.

- [ ] **Step 4: Run + typecheck + lint + commit**

Run: `pnpm --filter @svyft/web exec vitest run src/features/rfq-workspace/LegPanel.test.tsx && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint`
```bash
git add apps/web/src/features/rfq-workspace/WarehouseHandlingToggle.tsx apps/web/src/features/rfq-workspace/LegPanel.tsx apps/web/src/features/rfq-workspace/LegPanel.test.tsx
git commit -m "feat(web): warehouse toggle + mount charge controls above FF selection"
```

---

## Phase G — Web: FF portal

### Task 14: Snapshot-driven draft + Road charges panel

**Files:**
- Modify: `apps/web/src/features/ff-portal/draftFromDto.ts`, `LegSection.tsx`
- Create: `apps/web/src/features/ff-portal/RoadChargesPanel.tsx`
- Test: `apps/web/src/features/ff-portal/RoadChargesPanel.test.tsx`

**Interfaces — Consumes:** `FfPortalLegDto.seededCharges` (now snapshot-driven, incl. Road PLAIN lines with `zone: null`), `.warehouseIncluded` (Task 2/9). **Produces:** Road configured charges rendered; Air/Sea unchanged; warehouse staging gated by `warehouseIncluded`.

- [ ] **Step 1: Map the new seeded fields in `draftFromDto.ts`** — carry `definitionKey` + nullable `zone`, and gate warehouse by `warehouseIncluded`:

```ts
  const charges = leg.seededCharges.map((s) => ({
    zone: s.zone, definitionKey: s.definitionKey, presetKey: s.presetKey, label: s.label, amount: null,
  }));
  const warehouse = (leg.warehouseIncluded ? leg.endpoints.filter((e) => e.warehousePosition != null) : [])
    .map((e) => ({ warehousePointId: e.pointId, position: e.warehousePosition!, label: warehouseLabel(e.warehousePosition!), amount: null }));
```

- [ ] **Step 2: Road charges panel** — `apps/web/src/features/ff-portal/RoadChargesPanel.tsx` (a flat list over `charges` where `zone === null`, mirroring `ChargeZonePanel`'s absolute-index binding + custom `[+ Add line]`):

```tsx
import { useFieldArray, useFormContext, useWatch } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { Input } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Button } from "@/components/ui/button";

export function RoadChargesPanel() {
  const { control, register, setValue } = useFormContext<QuoteDraft>();
  const { fields, append } = useFieldArray({ control, name: "charges" });
  const draft = useWatch({ control }) as Partial<QuoteDraft>;
  const rows = fields.map((f, idx) => ({ f, idx })).filter(({ idx }) => (draft.charges?.[idx]?.zone ?? null) === null);

  return (
    <div className="space-y-2">
      {rows.map(({ f, idx }) => {
        const c = draft.charges?.[idx];
        const isPreset = !!c?.definitionKey;
        return (
          <div key={f.id} className="flex items-center gap-2">
            {isPreset ? <span className="flex-1 text-sm">{c?.label}</span>
                      : <Input className="flex-1" {...register(`charges.${idx}.label`)} />}
            <NumberField value={c?.amount ?? null} onChange={(v) => setValue(`charges.${idx}.amount`, v, { shouldDirty: true })} />
            <Input placeholder="Note" {...register(`charges.${idx}.note`)} />
          </div>
        );
      })}
      <Button type="button" variant="ghost" size="sm"
        onClick={() => append({ zone: null, definitionKey: null, presetKey: null, label: "Custom charge", amount: null })}>
        + Add line
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Render it for Road** — `apps/web/src/features/ff-portal/LegSection.tsx`, in the charges section, render both trucking and the new panel for ROAD:

```tsx
  {leg.mode === "ROAD" ? (
    <>
      <TruckingBlocks endpoints={leg.endpoints} />
      <RoadChargesPanel />
    </>
  ) : (
    <ChargeZonePanel />
  )}
```

- [ ] **Step 4: Write the test** — `RoadChargesPanel.test.tsx`: render inside a `useForm` wrapper whose `charges` include one preset (`definitionKey` set, `zone: null`) and no zone rows; assert the preset label renders read-only, the amount input is bound, and `+ Add line` appends a `zone: null` custom row.

- [ ] **Step 5: Run + typecheck + lint + commit**

Run: `pnpm --filter @svyft/web exec vitest run src/features/ff-portal && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint`
```bash
git add apps/web/src/features/ff-portal/draftFromDto.ts apps/web/src/features/ff-portal/LegSection.tsx apps/web/src/features/ff-portal/RoadChargesPanel.tsx apps/web/src/features/ff-portal/RoadChargesPanel.test.tsx
git commit -m "feat(web): FF-portal Road charges panel + snapshot-driven draft"
```

---

## Final verification (run before opening the PR)

- [ ] `pnpm --filter @svyft/shared build && pnpm run typecheck` — whole monorepo typechecks against the rebuilt shared `dist`.
- [ ] `pnpm run lint`
- [ ] `pnpm --filter @svyft/shared test` (Vitest) and `pnpm --filter @svyft/web test` (Vitest).
- [ ] `set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test` (Jest e2e, real DB on :5433, `--runInBand`).
- [ ] Manual smoke (design §12): open a query with a Road leg through a warehouse → Configure charges (Standard/Tag-driven sections, cores note) + Warehouse toggle appear **above** FF selection; distribute is blocked until the toggle is set; after distribute both controls are read-only; the FF portal shows exactly cores + selected (+ warehouse on the Yes leg) and blocks submit until every line is priced.

---

## Self-review (spec coverage)

| Design § | Covered by |
|---|---|
| §5.1 `ChargeLineDefinition` / §5.2 selection / §5.3 leg column / §5.4 quote snapshot | Tasks 1, 5 |
| §6 seed inventory (3 inactive) | Task 6 |
| §7 resolve-and-freeze | Tasks 3, 8 |
| §8.1 portal seeding / §8.2 Q1 + null-zone totals | Tasks 4, 9 |
| §9 warehouse single-leg attribution | Tasks 9 (gating), 10, 11 |
| §10 F7/F8 gates | Task 10 |
| §11 locking via mediator (RfqDefining) | Task 11 |
| §12.1 Leg-Panel controls above FF selection | Tasks 12, 13 |
| §12.2 FF-portal Road panel | Task 14 |
| §13 deferrals (tagKey inert, no admin add, structural params as enums) | Tasks 1, 6 (no wiring added) |

Not in scope (design §16): admin catalogue CRUD, tag↔reference-tag activation, structural-param admin — intentionally omitted.
