# Stage 4 · FF Portal v2 (§4.8) + Cargo→Package Ripple — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-point the Stage-4 quote/portal layer onto the Stage-3 `Cargo→Package→Item` package grain (unblock `nest build`), then deliver the full §4.8 FF-Portal v5 upgrade — dual-rate pricing with two leg grand totals, FF-entered Charged Wt (kg), the Air Heavy-Weight calculator, tonnage/container/B-L option-sets, the tag two-gate, mode-specific mandatory transit, richer warehouse zones, and the Route-SVG/PDF/Preview extras — so `pnpm run ci` is green and the branch is deployable.

**Architecture:** Re-point first (Unit 1: a migration-free, behaviour-preserving grain swap that makes `apps/api` compile), then enhance (Units 2–4: additive migration + shared engine v2 + api wiring + web v5), then re-green the ~25 Stage-4 e2e specs (Unit 5), then the final gate + whole-branch review (Unit 6). The domain core (`@svyft/shared`) holds all pure logic (engine totals, submit gate, tag two-gate, manifest builder types); api freezes it at distribute; web renders it.

**Tech Stack:** pnpm monorepo — `apps/api` (NestJS + Prisma/Postgres), `apps/web` (React/Vite + TanStack Query + react-hook-form + Zod), `packages/shared` (pure-TS domain core + Zod). Node `>=20 <21`, pnpm `9.12.0`. Design of record: [`docs/Stage 4 - FF Portal v2 - Design.md`](../../Stage%204%20-%20FF%20Portal%20v2%20-%20Design.md). SDD ledger: [`.superpowers/sdd/progress.md`](../../../.superpowers/sdd/progress.md).

---

## Global Constraints

*Every task's requirements implicitly include this section. These are the non-negotiable protocols carried from the Stage-3/Stage-4 SDD ledger — copied verbatim.*

### Git protocol (SHARED-checkout drift hazard — CONFIRMED live)
- A background pull / another Claude session intermittently `git checkout main`s this shared checkout → a naive commit lands on `main`.
- **Implementers NEVER touch git** (no checkout/add/commit/stash). They edit + test, then report the exact files to stage and a suggested commit message.
- **The controller commits atomically:** start EVERY commit with `git checkout feat/stage-3-cargo-packing-list`, then `git add <specific files>`, `git commit`, then verify parent == the previous feat tip (`git log --oneline -2`). Record each task's BASE (feat tip before dispatch) for `review-package` — never `HEAD~1`.
- Leave the untracked `CLAUDE.md` and `docs/README.md` in place (another session's artifacts) — never stage them.
- Branch tip at plan start: **`89a6c06`** (design commit). This plan's commit sits on top; Task 1's BASE = this plan's commit.

### Build / test / typecheck reality
- **`@svyft/shared` compiles to `dist/` (gitignored). Run `pnpm --filter @svyft/shared build` after EVERY shared edit** or api-tsc / web / vitest see stale types. (api jest maps `@svyft/shared`→`src`; tsc/web read `dist`.)
- **vitest (shared + web) and esbuild do NOT type-check.** A green suite can hide type errors. Run `pnpm --filter @svyft/shared typecheck` + `pnpm --filter @svyft/web typecheck` explicitly per task on touched files.
- **`apps/api` will not fully `typecheck` until Unit 5** (the ~25 legacy specs are on the old model). Two gates instead:
  - Unit 1's exit = **`pnpm --filter @svyft/api build` green** (`nest build` compiles `src` only via `tsconfig.build.json` — this is the deploy-unblocker).
  - Each API task runs its e2e via an **isolated-transpile jest config**: copy `apps/api/test/jest-e2e.json` into the scratchpad, set ts-jest `isolatedModules: true`, point `--config` at it. This boots the real `AppModule` + real DB and skips unrelated files' type errors. **This config is NEVER committed.**
  - Full `pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api test` green is the Unit 5/6 gate.
- Full-AppModule e2e MUST `await app.close()` in `afterAll` (the schedule cron keeps the process alive otherwise). Prefer `AppModule` + `moduleRef.get(PrismaService)`.
- CI has no seed: any e2e needing catalogue rows calls `seedReferenceData(prisma)` in `beforeAll`. Self-clean by a per-file unique prefix (`const PFX = "..."`).

### Database / migrations
- Dev Postgres UP: container `svyft-postgres-task4` on **:5433**. `apps/api/.env` present (DATABASE_URL / DIRECT_URL / JWT). Export it for the Prisma CLI: `set -a; . apps/api/.env; set +a`.
- **Migrations: hand-author `prisma/migrations/<timestamp>_<name>/migration.sql`, then `pnpm --filter @svyft/api exec prisma migrate deploy --schema ../../prisma/schema.prisma`, then `prisma generate`. NEVER `prisma migrate dev`** (it drifts on the generated `volumeCbm` column → PG 42601, and may propose a destructive RESET of the shared dev DB). **If Prisma proposes RESET/DROP unexpectedly → STOP.** Do NOT run `prisma format` (reformats unrelated models → churn).
- Schema lives at the **repo root** `prisma/schema.prisma`, not under `apps/api`. Always pass `--schema ../../prisma/schema.prisma` from `apps/api` (or `--schema prisma/schema.prisma` from root).
- Verification psql: `docker exec -e PGPASSWORD=$DBPASS svyft-postgres-task4 psql -U $DBUSER -d svyft -Atc "…"` (parse DBUSER/DBPASS from DATABASE_URL).

### RBAC
- Quote/RFQ/portal writes are **workflow writes → auth-only (no `@Roles`)**. The FF portal routes are `@Public()` + token-scoped. Only master-data/`/admin/config` writes gate to ADMINISTRATOR/MANAGER. Match this; prefer spec + existing code over any handoff doc on conflict.

### 🔴 GO-LIVE GATE (destructive migration — read before merge)
- The Stage-3 migration already on this branch is **destructive** (`DROP CargoItem`/`LegCargo`, `DELETE FROM QuoteCargoLine`) and **CD auto-runs `prisma migrate deploy` on merge to `main`.**
- **Do NOT merge until the whole branch is green (`pnpm run ci`), opus-reviewed, and the user explicitly approves.** DB migrations do NOT auto-rollback with the app image.
- Business-approved test path: deploy this branch to the prod droplet pointed at a **staging Neon-branch DB** (branched off prod) via the Deploy workflow (`workflow_dispatch`); **quantify prod loss** (`count(*)` on `CargoItem`/`LegCargo`/`QuoteCargoLine`) before the real cutover. Add this to the PR body + go-live checklist.

### How to read Units 1–3 vs 4–6
Units 1–3 (shared + api) carry **complete, real code** — write it as shown. Units 4–5 (≈40 web components, ≈25 e2e specs) are **mechanical re-points of existing files**: each task gives the exact files, the DTO fields to consume, the test pattern, acceptance criteria, and real code for every *new* pure helper — but for existing component JSX / spec bodies the implementer reads the live file and applies the described change (verbatim reproduction of 40 components would be noise). This is deliberate and called out per task.

---

# UNIT 1 — Ripple unblock (migration-free grain re-point → `apps/api build` green)

**No behaviour change, no schema change.** `QuoteCargoLine.packageId` already exists (Stage-3 T3). `manifestSnapshot` is `Json` (no migration). This unit only swaps `legCargo.cargoItem.*` reads → `legPackages.package.*` and the flat `ManifestSnapshotCargo` → per-package. The density model stays intact (Unit 2 removes it). Exit: `pnpm --filter @svyft/api build` compiles.

### Task 1: Shared `ManifestSnapshotCargo` → per-package shape

**Files:**
- Modify: `packages/shared/src/rfq.ts:7-21` (the `ManifestSnapshotCargo` interface)
- Test: `packages/shared/src/rfq.test.ts` (create if absent — a type-shape pin)

**Interfaces:**
- Produces: `ManifestSnapshotCargo = { packageId, packageNo, packageType, packageCount, dimL, dimW, dimH, netWt, grossWt, volumeCbm, tags }` — dims canonical cm (string), gross/net canonical kg (string|null), `tags: ReferenceTag[]` (= `effectiveTags`, incl. DG). Consumed by Task 2 (`buildManifestSnapshot`), Task 3 (portal), Unit 4 web, Unit 5 specs.

- [ ] **Step 1: Write the failing test** — pin the new shape so any drift is a compile error.

```ts
// packages/shared/src/rfq.test.ts
import { describe, it, expect } from "vitest";
import type { ManifestSnapshotCargo } from "./rfq";

describe("ManifestSnapshotCargo (per-package)", () => {
  it("has the package-grain fields and no flat cargo-item fields", () => {
    const c: ManifestSnapshotCargo = {
      packageId: "p1", packageNo: "V-1", packageType: "PALLET", packageCount: 1,
      dimL: "120", dimW: "80", dimH: "100", netWt: "90", grossWt: "100",
      volumeCbm: "0.96", tags: ["DG"],
    };
    expect(c.tags).toContain("DG");
    // @ts-expect-error — flat CargoItem fields are gone
    const _bad: ManifestSnapshotCargo = { ...c, isDangerous: true, qty: 3, productName: "x" };
    void _bad;
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`isDangerous`/`qty` still allowed today, so `@ts-expect-error` is unused → tsc errors; and `packageId` not yet a field).

Run: `pnpm --filter @svyft/shared build && npx tsc --noEmit -p packages/shared` — Expected: FAIL (shape mismatch).

- [ ] **Step 3: Replace the interface** in `packages/shared/src/rfq.ts`:

```ts
import type { ReferenceTag } from "./cargo";
// ...
export interface ManifestSnapshotCargo {
  packageId: string;
  packageNo: string;
  packageType: string;
  packageCount: number;
  dimL: string; // canonical cm
  dimW: string;
  dimH: string;
  netWt: string | null; // canonical kg
  grossWt: string;
  volumeCbm: string | null; // m³
  tags: ReferenceTag[]; // effectiveTags(package ∪ items), incl. DG
}
```

- [ ] **Step 4: Rebuild shared + run test + typecheck** — Expected: PASS.

Run: `pnpm --filter @svyft/shared build && pnpm --filter @svyft/shared test -- src/rfq.test.ts && pnpm --filter @svyft/shared typecheck`

- [ ] **Step 5: Report to controller** — files: `packages/shared/src/rfq.ts`, `packages/shared/src/rfq.test.ts`. Message: `refactor(shared): ManifestSnapshotCargo → per-package grain (Cargo→Package ripple)`. *(Note: shared consumers in api break until Task 2/3 — expected; do not chase them here.)*

---

### Task 2: `leg-context` include + `manifest` builder → package grain

**Files:**
- Modify: `apps/api/src/modules/rfq/leg-context.ts:9` (`LEG_RFQ_INCLUDE`), `:54` (`hasDg`)
- Modify: `apps/api/src/modules/rfq/manifest.ts` (whole `buildManifestSnapshot`)
- Test: `apps/api/test/rfq-manifest.e2e-spec.ts` (create)

**Interfaces:**
- Consumes: `ManifestSnapshotCargo` (Task 1); `effectiveTags` from `@svyft/shared` (`cargo.ts`).
- Produces: `LEG_RFQ_INCLUDE.legPackages` include (leg → LegPackage → Package → Item[]); `buildManifestSnapshot(ctx, query, frozenAt)` builds per-package `cargo[]`. Consumed by Task 3, `rfq.service`, Unit 5.

- [ ] **Step 1: Write the failing e2e** — distribute a leg carrying one Cargo with two Packages (one with a DG item), assert the frozen manifest is per-package with canonical kg + effective tags.

```ts
// apps/api/test/rfq-manifest.e2e-spec.ts  (isolated-transpile config)
// PFX = "MANIFEST_"; boot AppModule; seedReferenceData; create client→query→cargo→2 packages
// (one package with an Item tagged ["DG"]) → 1 leg → assign both packages → select an ACTIVE,
// DG-handling FF → POST /queries/:id/legs/:legId/distribute → read the quote's manifestSnapshot.
it("freezes a per-package manifest with canonical kg and effective DG tag", async () => {
  const quote = await prisma.quote.findFirstOrThrow({ where: { legId }, select: { manifestSnapshot: true } });
  const snap = quote.manifestSnapshot as ManifestSnapshot;
  expect(snap.cargo).toHaveLength(2);
  expect(snap.cargo[0]).toMatchObject({ packageId: expect.any(String), packageNo: expect.any(String) });
  expect(snap.cargo.some((c) => c.tags.includes("DG"))).toBe(true);
  expect(snap.cargo[0]).not.toHaveProperty("cargoItemId");
  expect(Number(snap.cargo[0].grossWt)).toBeGreaterThan(0); // canonical kg
});
```

- [ ] **Step 2: Run it — expect FAIL** (`leg.legPackages` undefined; `buildManifestSnapshot` still reads `legCargo`).

Run: `pnpm --filter @svyft/api exec jest --config <scratchpad>/jest-e2e.isolated.json rfq-manifest --runInBand`

- [ ] **Step 3: Re-point `leg-context.ts`:**

```ts
export const LEG_RFQ_INCLUDE = {
  originPoint: { select: { id: true, type: true, country: true, name: true, city: true } },
  destinationPoint: { select: { id: true, type: true, country: true, name: true, city: true } },
  legPackages: { include: { package: { include: { items: true } } } },
  quotes: { select: { id: true, freightForwarderId: true, status: true } },
  chargeSelections: { select: { definition: { select: { key: true } } } },
} satisfies Prisma.LegInclude;
```

And `hasDg` via `effectiveTags` (import `effectiveTags` from `@svyft/shared`):

```ts
const hasDg = leg.legPackages.some((lp) =>
  effectiveTags({ tags: lp.package.tags, items: lp.package.items }).includes("DG"),
);
```

- [ ] **Step 4: Rewrite `manifest.ts`** — build per-package from `legPackages`, canonical values straight from the DB (no `toKg`):

```ts
import type { Incoterms } from "@prisma/client";
import { effectiveTags } from "@svyft/shared";
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
    cargo: leg.legPackages.map((lp) => {
      const p = lp.package;
      return {
        packageId: p.id,
        packageNo: p.packageNo,
        packageType: p.packageType,
        packageCount: p.packageCount,
        dimL: p.dimL.toString(),
        dimW: p.dimW.toString(),
        dimH: p.dimH.toString(),
        netWt: p.netWt ? p.netWt.toString() : null,
        grossWt: p.grossWt.toString(),
        volumeCbm: p.volumeCbm ? p.volumeCbm.toString() : null,
        tags: effectiveTags({ tags: p.tags, items: p.items }),
      };
    }),
    frozenAt: frozenAt.toISOString(),
  };
}
```

- [ ] **Step 5: Run the e2e — expect PASS.** Then rebuild shared is not needed (no shared edit); just re-run.

- [ ] **Step 6: Report to controller** — files: `apps/api/src/modules/rfq/leg-context.ts`, `apps/api/src/modules/rfq/manifest.ts`, `apps/api/test/rfq-manifest.e2e-spec.ts`. Message: `fix(api): build the RFQ manifest at package grain (leg-context + manifest.ts)`.

---

### Task 3: `rfq.service` eligibility + `ff-portal.service` re-point (grain only; density intact)

**Files:**
- Modify: `apps/api/src/modules/rfq/rfq.service.ts:267` (F1: `leg.legCargo.length` → `leg.legPackages.length`)
- Modify: `apps/api/src/modules/ff-portal/ff-portal.service.ts` (`resolveScope` seededDensity/manifest reads; `submit` draft rebuild + `quoteCargoLine` write)
- Modify: `packages/shared/src/ff-portal.ts:26` (`FfPortalSeededDensity.cargoItemId` stays as the field name this unit — see note)
- Test: extend `apps/api/test/ff-portal.e2e-spec.ts` is Unit 5; here use a focused new `apps/api/test/ff-portal-grain.e2e-spec.ts`

**Interfaces:**
- Consumes: per-package `ManifestSnapshot` (Task 2). `QuoteDraftCargo.cargoItemId` (unchanged this unit) **holds a packageId** — the field is renamed to `packageId` in Unit 2 Task 6.
- Produces: a compiling `ff-portal.service`; `pnpm --filter @svyft/api build` green.

> **Intentional churn note:** this task keeps the density model (`freightDensity`/`chargeableWeightT`/`computeChargeableWeight`) and only swaps the grain, so `apps/api` compiles with zero schema change. Unit 2 Task 8 rewrites the same lines to `chargedWeightKg`. This is the design's compile-first sequencing (§4.1) — do not pull the kg change forward.

- [ ] **Step 1: Write the failing e2e** — GET the portal for a distributed leg, assert `legs[].manifest.cargo` is per-package and `seededDensity` is keyed by package id; then submit a minimal priced draft and assert it materializes a `QuoteCargoLine` per package.

```ts
// apps/api/test/ff-portal-grain.e2e-spec.ts (isolated config) — PFX = "FFGRAIN_"
it("serves a package-grain manifest and materializes one QuoteCargoLine per package", async () => {
  const dto = await getPortal(token); // GET /ff/rfq/:token
  const leg = dto.legs[0];
  expect(leg.manifest.cargo[0]).toHaveProperty("packageId");
  expect(leg.seededDensity[0]).toHaveProperty("cargoItemId"); // field name unchanged this unit
  // ...price the mandatory lines + trucking/transit, POST submit...
  const lines = await prisma.quoteCargoLine.findMany({ where: { quoteId: leg.quoteId } });
  expect(lines).toHaveLength(leg.manifest.cargo.length);
  expect(lines.every((l) => l.packageId)).toBe(true);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`manifest.cargo[].cargoItemId` undefined; submit maps the old fields).

- [ ] **Step 3: `rfq.service.ts` F1 gate** — swap the cargo-presence check:

```ts
// validateLegForDistribution, in the F1 condition:
leg.legPackages.length === 0 ||
```

- [ ] **Step 4: `ff-portal.service.ts` `resolveScope`** — the `seededDensity` map now reads `packageId` from the per-package manifest (density value unchanged):

```ts
seededDensity:
  density == null
    ? []
    : manifest.cargo.map((c) => ({ cargoItemId: c.packageId, freightDensity: density })),
```

- [ ] **Step 5: `ff-portal.service.ts` `submit`** — rebuild `draft.cargo` from the per-package manifest (density model intact; `isDangerous` derived from tags; `cargoItemId` field carries the packageId):

```ts
cargo: manifest.cargo.map((c) => ({
  cargoItemId: c.packageId,
  grossWtT: Number(c.grossWt) / 1000, // manifest grossWt is canonical kg
  cbm: Number(c.volumeCbm ?? 0),
  isDangerous: c.tags.includes("DG"),
  freightDensity: stored.cargo?.find((s) => s.cargoItemId === c.packageId)?.freightDensity ?? null,
})),
```

And the `quoteCargoLine.createMany` writes `packageId` (the column already exists):

```ts
await tx.quoteCargoLine.createMany({
  data: draft.cargo.map((c) => ({
    quoteId: q.id,
    packageId: c.cargoItemId, // field carries the packageId this unit
    freightDensity: c.freightDensity!,
    chargeableWeightT: computeChargeableWeight(c.grossWtT, c.cbm, c.freightDensity!),
  })),
});
```

- [ ] **Step 6: Run the e2e — expect PASS.**

- [ ] **Step 7: Verify the deploy-unblocker gate** — Run: `pnpm --filter @svyft/shared build && pnpm --filter @svyft/api build`. Expected: **build succeeds** (0 src errors — the 112 tsc errors that remain are all in the ~25 legacy specs, cleared in Unit 5).

- [ ] **Step 8: Report to controller** — files: `apps/api/src/modules/rfq/rfq.service.ts`, `apps/api/src/modules/ff-portal/ff-portal.service.ts`, `apps/api/test/ff-portal-grain.e2e-spec.ts`. Message: `fix(api): re-point RFQ eligibility + FF portal to package grain — nest build green`.

> **✅ UNIT 1 EXIT:** `pnpm --filter @svyft/api build` compiles. The branch is deployable (modulo the destructive go-live gate). Density model still present; removed in Unit 2.

---

# UNIT 2 — Model / engine v2 (additive migration + shared engine)

Additive schema (kg rename + dual-rate models/enums + calc columns), the shared engine's per-variant totals + Heavy-Weight calc, the submit-gate v2, the tag two-gate resolver, and the catalogue seed additions. No api wiring yet (Unit 3).

### Task 4: Prisma migration — kg rename, dual-rate models, calc columns

**Files:**
- Create: `prisma/migrations/<timestamp>_ff_portal_v2/migration.sql` (hand-authored)
- Modify: `prisma/schema.prisma` (models/enums below)
- Test: `apps/api/test/ff-portal-v2-model.e2e-spec.ts` (create)

**Interfaces:**
- Produces: `QuoteCargoLine.chargedWeightKg Decimal(12,3)` (was `freightDensity`; `chargeableWeightT` dropped); enums `ChargeRateVariant{DEDICATED,GROUPAGE,FCL,LCL}`, `TruckTonnage`(11 values), `ContainerSize{TWENTY,FORTY,FORTY_FIVE_HC}`, `BillOfLadingType{ORIGINAL,TELEX}`, `WarehouseSide{DROP,PICKUP}`, `HEAVY_WEIGHT_CALC` on `ChargeLineInputType`; `TruckingCharge.rateVariant`/`tonnage`; new `SeaFreightRate`; `ChargeLine.pieceWeightKg`/`airlineLimitKg`/`ratePerExcessKg`/`billOfLadingType`; `WarehouseStagingLine.cfsCode`/`side`; `TransitPlan` mode-specific columns. Consumed by Tasks 5–11, Unit 3, Unit 5.

- [ ] **Step 1: Write the failing model e2e** — assert the new columns/enum labels exist via a round-trip insert.

```ts
// apps/api/test/ff-portal-v2-model.e2e-spec.ts (isolated config) — PFX = "V2MODEL_"
it("stores chargedWeightKg, a dual-rate trucking row, and a SeaFreightRate", async () => {
  // ...create query/leg/package/quote (helper)...
  await prisma.quoteCargoLine.create({ data: { quoteId, packageId, chargedWeightKg: "123.5" } });
  await prisma.truckingCharge.create({
    data: { quoteId, legEndpointPointId: pid, truckingType: "DEDICATED", basis: "PER_TRUCK",
      amount: "500", rateVariant: "DEDICATED", tonnage: "TRAILER_30_40T" },
  });
  await prisma.seaFreightRate.create({
    data: { quoteId, rateVariant: "FCL", containerSize: "FORTY", amount: "1800" },
  });
  const line = await prisma.quoteCargoLine.findFirstOrThrow({ where: { quoteId } });
  expect(line).not.toHaveProperty("freightDensity");
  expect(Number(line.chargedWeightKg)).toBe(123.5);
});
```

- [ ] **Step 2: Run it — expect FAIL** (columns/models absent).

- [ ] **Step 3: Edit `prisma/schema.prisma`.** Enums (append near the existing charge enums, ~line 542):

```prisma
enum ChargeLineInputType {
  PLAIN
  TRUCKING
  WAREHOUSE_STAGING
  HEAVY_WEIGHT_CALC
}

enum ChargeRateVariant {
  DEDICATED
  GROUPAGE
  FCL
  LCL
}

enum TruckTonnage {
  T_1
  T_2
  T_3_5
  T_5
  T_7
  T_9
  T_12
  T_16
  T_20
  T_25
  TRAILER_30_40T
}

enum ContainerSize {
  TWENTY
  FORTY
  FORTY_FIVE_HC
}

enum BillOfLadingType {
  ORIGINAL
  TELEX
}

enum WarehouseSide {
  DROP
  PICKUP
}
```

`QuoteCargoLine` (replace `freightDensity`/`chargeableWeightT`):

```prisma
model QuoteCargoLine {
  id              String   @id @default(uuid()) @db.Uuid
  tenantId        String?  @db.Uuid
  quoteId         String   @db.Uuid
  quote           Quote    @relation(fields: [quoteId], references: [id], onDelete: Cascade)
  packageId       String   @db.Uuid
  package         Package  @relation(fields: [packageId], references: [id], onDelete: Restrict)
  chargedWeightKg Decimal  @db.Decimal(12, 3)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([quoteId, packageId])
  @@index([quoteId])
  @@index([tenantId])
}
```

`TruckingCharge` — add `rateVariant` (required, default DEDICATED for existing rows) + `tonnage`:

```prisma
  rateVariant   ChargeRateVariant @default(DEDICATED)
  tonnage       TruckTonnage?
```

New `SeaFreightRate` (place after `TruckingCharge`) + back-relation on `Quote`:

```prisma
model SeaFreightRate {
  id            String            @id @default(uuid()) @db.Uuid
  tenantId      String?           @db.Uuid
  quoteId       String            @db.Uuid
  quote         Quote             @relation(fields: [quoteId], references: [id], onDelete: Cascade)
  rateVariant   ChargeRateVariant // FCL | LCL
  containerSize ContainerSize?    // FCL only
  amount        Decimal           @db.Decimal(14, 2)
  remarks       String?
  createdAt     DateTime          @default(now())
  updatedAt     DateTime          @updatedAt

  @@index([quoteId])
  @@index([tenantId])
}
// On model Quote, add:  seaFreightRates SeaFreightRate[]
```

`ChargeLine` — add the calc inputs + B/L:

```prisma
  pieceWeightKg    Decimal?         @db.Decimal(12, 3)
  airlineLimitKg   Decimal?         @db.Decimal(12, 3)
  ratePerExcessKg  Decimal?         @db.Decimal(14, 2)
  billOfLadingType BillOfLadingType?
```

`WarehouseStagingLine` — add `cfsCode` + `side`:

```prisma
  cfsCode String?
  side    WarehouseSide?
```

`TransitPlan` — add mode-specific optional columns (keep `carrier`/`flightVoyageNo`/`departureDate`/`arrivalDate`/`guaranteedTransitDays`):

```prisma
  plannedPickupDate DateTime?
  airline           String?
  flightNumber      String?
  plannedDeparture  DateTime?
  plannedArrival    DateTime?
  shippingLine      String?
  vesselVoyage      String?
  etd               DateTime?
  eta               DateTime?
```

- [ ] **Step 4: Hand-author `migration.sql`.** Use a real timestamp folder name (pass it in; scripts can't call `Date.now()`). The `ALTER TYPE ... ADD VALUE` for `ChargeLineInputType` must run in its own statement (Postgres commits enum additions before use):

```sql
-- new enums
CREATE TYPE "ChargeRateVariant" AS ENUM ('DEDICATED', 'GROUPAGE', 'FCL', 'LCL');
CREATE TYPE "TruckTonnage" AS ENUM ('T_1','T_2','T_3_5','T_5','T_7','T_9','T_12','T_16','T_20','T_25','TRAILER_30_40T');
CREATE TYPE "ContainerSize" AS ENUM ('TWENTY', 'FORTY', 'FORTY_FIVE_HC');
CREATE TYPE "BillOfLadingType" AS ENUM ('ORIGINAL', 'TELEX');
CREATE TYPE "WarehouseSide" AS ENUM ('DROP', 'PICKUP');
ALTER TYPE "ChargeLineInputType" ADD VALUE 'HEAVY_WEIGHT_CALC';

-- QuoteCargoLine: drop density model, add FF-entered kg
ALTER TABLE "QuoteCargoLine" DROP COLUMN "freightDensity";
ALTER TABLE "QuoteCargoLine" DROP COLUMN "chargeableWeightT";
ALTER TABLE "QuoteCargoLine" ADD COLUMN "chargedWeightKg" DECIMAL(12,3) NOT NULL DEFAULT 0;
ALTER TABLE "QuoteCargoLine" ALTER COLUMN "chargedWeightKg" DROP DEFAULT;

-- TruckingCharge: dual-rate
ALTER TABLE "TruckingCharge" ADD COLUMN "rateVariant" "ChargeRateVariant" NOT NULL DEFAULT 'DEDICATED';
ALTER TABLE "TruckingCharge" ADD COLUMN "tonnage" "TruckTonnage";

-- SeaFreightRate
CREATE TABLE "SeaFreightRate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "quoteId" UUID NOT NULL,
  "rateVariant" "ChargeRateVariant" NOT NULL,
  "containerSize" "ContainerSize",
  "amount" DECIMAL(14,2) NOT NULL,
  "remarks" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SeaFreightRate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SeaFreightRate_quoteId_idx" ON "SeaFreightRate"("quoteId");
CREATE INDEX "SeaFreightRate_tenantId_idx" ON "SeaFreightRate"("tenantId");
ALTER TABLE "SeaFreightRate" ADD CONSTRAINT "SeaFreightRate_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ChargeLine: heavy-weight calc inputs + Sea B/L
ALTER TABLE "ChargeLine" ADD COLUMN "pieceWeightKg" DECIMAL(12,3);
ALTER TABLE "ChargeLine" ADD COLUMN "airlineLimitKg" DECIMAL(12,3);
ALTER TABLE "ChargeLine" ADD COLUMN "ratePerExcessKg" DECIMAL(14,2);
ALTER TABLE "ChargeLine" ADD COLUMN "billOfLadingType" "BillOfLadingType";

-- WarehouseStagingLine: richer zones
ALTER TABLE "WarehouseStagingLine" ADD COLUMN "cfsCode" TEXT;
ALTER TABLE "WarehouseStagingLine" ADD COLUMN "side" "WarehouseSide";

-- TransitPlan: mode-specific
ALTER TABLE "TransitPlan" ADD COLUMN "plannedPickupDate" TIMESTAMP(3);
ALTER TABLE "TransitPlan" ADD COLUMN "airline" TEXT;
ALTER TABLE "TransitPlan" ADD COLUMN "flightNumber" TEXT;
ALTER TABLE "TransitPlan" ADD COLUMN "plannedDeparture" TIMESTAMP(3);
ALTER TABLE "TransitPlan" ADD COLUMN "plannedArrival" TIMESTAMP(3);
ALTER TABLE "TransitPlan" ADD COLUMN "shippingLine" TEXT;
ALTER TABLE "TransitPlan" ADD COLUMN "vesselVoyage" TEXT;
ALTER TABLE "TransitPlan" ADD COLUMN "etd" TIMESTAMP(3);
ALTER TABLE "TransitPlan" ADD COLUMN "eta" TIMESTAMP(3);
```

> Local `QuoteCargoLine`/`ChargeLine` rows are empty on :5433, so the `NOT NULL DEFAULT 0`-then-`DROP DEFAULT` dance is belt-and-suspenders. On Neon prod the destructive Stage-3 migration already `DELETE`d `QuoteCargoLine` (go-live gate), so no rows exist there either.

- [ ] **Step 5: Apply + generate.**

Run: `set -a; . apps/api/.env; set +a && pnpm --filter @svyft/api exec prisma migrate deploy --schema ../../prisma/schema.prisma && pnpm --filter @svyft/api exec prisma generate --schema ../../prisma/schema.prisma`

- [ ] **Step 6: Run the model e2e — expect PASS.** Then verify no unexpected drift: `pnpm --filter @svyft/api exec prisma migrate diff --from-schema-datasource ../../prisma/schema.prisma --to-schema-datamodel ../../prisma/schema.prisma --exit-code` (expect only the pre-existing repo-wide `uuid()` id-default convention diff, as documented in the ledger).

- [ ] **Step 7: Report to controller** — files: `prisma/schema.prisma`, `prisma/migrations/<ts>_ff_portal_v2/migration.sql`, `apps/api/test/ff-portal-v2-model.e2e-spec.ts`. Message: `feat(db): FF Portal v2 schema — chargedWeightKg, dual-rate models, calc columns`.

---

### Task 5: Shared enums + dual-rate/calc types (`charge-config.ts`, `quote.ts`)

**Files:**
- Modify: `packages/shared/src/charge-config.ts` (`ChargeLineInputType` += `HEAVY_WEIGHT_CALC`; `ResolvedChargeLine` calc fields)
- Modify: `packages/shared/src/quote.ts` (new const-enums; `QuoteDraft*` v2 shapes)
- Test: `packages/shared/src/quote.test.ts` (extend — enum-value pins)

**Interfaces:**
- Produces (const-enums, in `quote.ts`): `ChargeRateVariant{DEDICATED,GROUPAGE,FCL,LCL}` + `CHARGE_RATE_VARIANTS`; `TruckTonnage` (11) + `TRUCK_TONNAGES` + `truckTonnageLabel`; `ContainerSize{TWENTY,FORTY,FORTY_FIVE_HC}` + `CONTAINER_SIZES` + `containerSizeLabel`; `BillOfLadingType{ORIGINAL,TELEX}` + `BILL_OF_LADING_TYPES`; `WarehouseSide{DROP,PICKUP}` + `WAREHOUSE_SIDES`.
- Produces (draft shapes): `QuoteDraftCargo = { packageId, grossWtKg, cbm, chargedWeightKg: number|null }`; `QuoteDraftCharge += { billOfLadingType?, pieceWeightKg?, airlineLimitKg?, ratePerExcessKg? }`; `QuoteDraftTrucking += { rateVariant, tonnage: TruckTonnage|null }`; new `QuoteDraftSeaRate = { rateVariant, containerSize: ContainerSize|null, amount: number|null, remarks? }`; `QuoteDraftWarehouse += { cfsCode?, side?: WarehouseSide|null }`; `QuoteDraftTransit` += mode-specific optional fields; `QuoteDraft += seaRates: QuoteDraftSeaRate[]`. Consumed by Tasks 6–11, Unit 3, Unit 4.

- [ ] **Step 1: Write the failing test** — pin the enum values + the v2 draft cargo shape.

```ts
// packages/shared/src/quote.test.ts
import { CHARGE_RATE_VARIANTS, TRUCK_TONNAGES, CONTAINER_SIZES, type QuoteDraftCargo } from "./quote";
it("exposes dual-rate option-sets", () => {
  expect(CHARGE_RATE_VARIANTS).toEqual(["DEDICATED", "GROUPAGE", "FCL", "LCL"]);
  expect(TRUCK_TONNAGES).toContain("TRAILER_30_40T");
  expect(CONTAINER_SIZES).toEqual(["TWENTY", "FORTY", "FORTY_FIVE_HC"]);
  const c: QuoteDraftCargo = { packageId: "p", grossWtKg: 100, cbm: 0.9, chargedWeightKg: 120 };
  expect(c.chargedWeightKg).toBe(120);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Add const-enums to `quote.ts`** (mirror the existing `TruckingType` idiom) + label maps:

```ts
export const ChargeRateVariant = { DEDICATED: "DEDICATED", GROUPAGE: "GROUPAGE", FCL: "FCL", LCL: "LCL" } as const;
export type ChargeRateVariant = (typeof ChargeRateVariant)[keyof typeof ChargeRateVariant];
export const CHARGE_RATE_VARIANTS = Object.values(ChargeRateVariant) as [ChargeRateVariant, ...ChargeRateVariant[]];

export const TruckTonnage = {
  T_1: "T_1", T_2: "T_2", T_3_5: "T_3_5", T_5: "T_5", T_7: "T_7", T_9: "T_9",
  T_12: "T_12", T_16: "T_16", T_20: "T_20", T_25: "T_25", TRAILER_30_40T: "TRAILER_30_40T",
} as const;
export type TruckTonnage = (typeof TruckTonnage)[keyof typeof TruckTonnage];
export const TRUCK_TONNAGES = Object.values(TruckTonnage) as [TruckTonnage, ...TruckTonnage[]];
const TRUCK_TONNAGE_LABELS: Record<TruckTonnage, string> = {
  T_1: "1 T", T_2: "2 T", T_3_5: "3.5 T", T_5: "5 T", T_7: "7 T", T_9: "9 T",
  T_12: "12 T", T_16: "16 T", T_20: "20 T", T_25: "25 T", TRAILER_30_40T: "Trailer 30–40 T",
};
export function truckTonnageLabel(t: TruckTonnage): string { return TRUCK_TONNAGE_LABELS[t] ?? t; }

export const ContainerSize = { TWENTY: "TWENTY", FORTY: "FORTY", FORTY_FIVE_HC: "FORTY_FIVE_HC" } as const;
export type ContainerSize = (typeof ContainerSize)[keyof typeof ContainerSize];
export const CONTAINER_SIZES = Object.values(ContainerSize) as [ContainerSize, ...ContainerSize[]];
const CONTAINER_SIZE_LABELS: Record<ContainerSize, string> = {
  TWENTY: `20'`, FORTY: `40'`, FORTY_FIVE_HC: `45' HC`,
};
export function containerSizeLabel(c: ContainerSize): string { return CONTAINER_SIZE_LABELS[c] ?? c; }

export const BillOfLadingType = { ORIGINAL: "ORIGINAL", TELEX: "TELEX" } as const;
export type BillOfLadingType = (typeof BillOfLadingType)[keyof typeof BillOfLadingType];
export const BILL_OF_LADING_TYPES = Object.values(BillOfLadingType) as [BillOfLadingType, ...BillOfLadingType[]];

export const WarehouseSide = { DROP: "DROP", PICKUP: "PICKUP" } as const;
export type WarehouseSide = (typeof WarehouseSide)[keyof typeof WarehouseSide];
export const WAREHOUSE_SIDES = Object.values(WarehouseSide) as [WarehouseSide, ...WarehouseSide[]];
```

- [ ] **Step 4: Rewrite the `QuoteDraft*` shapes in `quote.ts`** (drop tonnes/density):

```ts
export interface QuoteDraftCargo {
  packageId: string;
  grossWtKg: number;             // display only (canonical kg from the manifest)
  cbm: number;                   // m³ (display only)
  chargedWeightKg: number | null; // FF-entered chargeable weight (kg)
}
export interface QuoteDraftCharge {
  zone: ChargeZone | null; definitionKey?: string | null; presetKey: string | null;
  label: string; amount: number | null; note?: string;
  billOfLadingType?: BillOfLadingType | null;            // Sea B/L line
  pieceWeightKg?: number | null;                         // HEAVY_WEIGHT_CALC inputs
  airlineLimitKg?: number | null;
  ratePerExcessKg?: number | null;
}
export interface QuoteDraftTrucking {
  legEndpointPointId: string; truckingType: TruckingType; basis: TruckingBasis;
  amount: number | null; remarks?: string;
  rateVariant: ChargeRateVariant;        // DEDICATED | GROUPAGE
  tonnage: TruckTonnage | null;          // Dedicated only
}
export interface QuoteDraftSeaRate {
  rateVariant: ChargeRateVariant;        // FCL | LCL
  containerSize: ContainerSize | null;   // FCL only
  amount: number | null; remarks?: string;
}
export interface QuoteDraftWarehouse {
  warehousePointId: string; position: WarehousePosition; label: string;
  amount: number | null; cargoAcceptanceWindow?: string;
  cfsCode?: string | null; side?: WarehouseSide | null;
}
export interface QuoteDraftTransit {
  departureDate: string | null; arrivalDate: string | null;
  carrier?: string | null; flightVoyageNo?: string | null;
  carrierSurcharge?: number | null; guaranteedTransitDays: number | null; // now mandatory (gate)
  plannedPickupDate?: string | null;                                       // Road
  airline?: string | null; flightNumber?: string | null; plannedDeparture?: string | null; plannedArrival?: string | null; // Air
  shippingLine?: string | null; vesselVoyage?: string | null; etd?: string | null; eta?: string | null; // Sea
}
export interface QuoteDraft {
  legId: string; mode: FreightMode | null; currency: string | null; quoteValidityUntil: string | null;
  cargo: QuoteDraftCargo[];
  charges: QuoteDraftCharge[];
  trucking: QuoteDraftTrucking[];
  seaRates: QuoteDraftSeaRate[];   // NEW
  warehouse: QuoteDraftWarehouse[];
  transit: QuoteDraftTransit | null;
  dgSurchargeNote: string | null;
  termsConditions: string | null;
}
```

- [ ] **Step 5: `charge-config.ts` — add the calc inputType + carry it on `ResolvedChargeLine`:**

```ts
export const ChargeLineInputType = {
  PLAIN: "PLAIN", TRUCKING: "TRUCKING", WAREHOUSE_STAGING: "WAREHOUSE_STAGING",
  HEAVY_WEIGHT_CALC: "HEAVY_WEIGHT_CALC",
} as const;
// ResolvedChargeLine already carries `inputType`; no field add needed — the portal reads it to render the calc widget.
```

- [ ] **Step 6: Rebuild shared, run test + typecheck — expect PASS.** Then update `src/index.ts` re-exports if new symbols aren't picked up by a barrel (check — `quote.ts` is re-exported wholesale, so new named exports flow automatically).

- [ ] **Step 7: Report to controller** — files: `packages/shared/src/quote.ts`, `packages/shared/src/charge-config.ts`, `packages/shared/src/quote.test.ts`. Message: `feat(shared): v2 draft shapes + dual-rate/calc option-sets`.

---

### Task 6: Engine — per-variant totals + Heavy-Weight calc

**Files:**
- Modify: `packages/shared/src/quote-engine.ts` (`computeQuoteTotals`; remove `computeChargeableWeight`; add `computeHeavyWeightAmount`)
- Test: `packages/shared/src/quote-engine.test.ts` (extend)

**Interfaces:**
- Consumes: `QuoteDraft` v2 (Task 5).
- Produces: `computeHeavyWeightAmount(pieceWeightKg: number, airlineLimitKg: number, ratePerExcessKg: number): number` = `max(0, pieceWt − limit) × rate`; `computeQuoteTotals(draft): QuoteTotals` where `QuoteTotals = { variants: { key: string; rateAmount: number | null; grandTotal: number }[]; sharedSubtotal: number; chargeableWeightKg: number }`. Consumed by Task 8 (portal submit), Unit 4 (live totals), Unit 5.

- [ ] **Step 1: Write the failing tests** — dual Road totals, single Air variant, chargeable = Σ chargedWeightKg, calc.

```ts
import { computeQuoteTotals, computeHeavyWeightAmount } from "./quote-engine";
import type { QuoteDraft } from "./quote";
const base = (over: Partial<QuoteDraft>): QuoteDraft => ({
  legId: "l", mode: "ROAD", currency: "USD", quoteValidityUntil: null,
  cargo: [{ packageId: "p", grossWtKg: 100, cbm: 1, chargedWeightKg: 250 }],
  charges: [{ zone: null, presetKey: null, label: "Tail lift", amount: 50 }],
  trucking: [], seaRates: [], warehouse: [{ warehousePointId: "w", position: "ORIGIN", label: "WH", amount: 30 }],
  transit: null, dgSurchargeNote: null, termsConditions: null, ...over,
});
it("computes one grand total per Road rate variant over a shared subtotal", () => {
  const t = computeQuoteTotals(base({ trucking: [
    { legEndpointPointId: "e", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: 500, rateVariant: "DEDICATED", tonnage: "T_5" },
    { legEndpointPointId: "e", truckingType: "GROUPAGE", basis: "PER_CBM", amount: 200, rateVariant: "GROUPAGE", tonnage: null },
  ] }));
  expect(t.sharedSubtotal).toBe(80); // 50 + 30
  expect(t.chargeableWeightKg).toBe(250);
  expect(t.variants).toEqual([
    { key: "DEDICATED", rateAmount: 500, grandTotal: 580 },
    { key: "GROUPAGE", rateAmount: 200, grandTotal: 280 },
  ]);
});
it("Air is a single AIR variant equal to the shared subtotal", () => {
  const t = computeQuoteTotals(base({ mode: "AIR", charges: [{ zone: "MAIN_FREIGHT", presetKey: null, label: "Air Freight", amount: 900 }] }));
  expect(t.variants).toEqual([{ key: "AIR", rateAmount: null, grandTotal: 930 }]);
});
it("computes the Heavy-Weight excess amount", () => {
  expect(computeHeavyWeightAmount(1200, 1000, 2)).toBe(400);
  expect(computeHeavyWeightAmount(800, 1000, 2)).toBe(0);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Rewrite the engine top** (delete `computeChargeableWeight` + the old `QuoteTotals`):

```ts
export function computeHeavyWeightAmount(pieceWeightKg: number, airlineLimitKg: number, ratePerExcessKg: number): number {
  return Math.max(0, pieceWeightKg - airlineLimitKg) * ratePerExcessKg;
}

export interface QuoteVariantTotal { key: string; rateAmount: number | null; grandTotal: number; }
export interface QuoteTotals {
  variants: QuoteVariantTotal[];
  sharedSubtotal: number;
  chargeableWeightKg: number;
}

export function computeQuoteTotals(draft: QuoteDraft): QuoteTotals {
  const chargesSum = draft.charges.reduce((s, c) => s + (c.amount ?? 0), 0);
  const warehouseSum = draft.warehouse.reduce((s, w) => s + (w.amount ?? 0), 0);
  const sharedSubtotal = chargesSum + warehouseSum;
  const chargeableWeightKg = draft.cargo.reduce((s, c) => s + (c.chargedWeightKg ?? 0), 0);

  const variants: QuoteVariantTotal[] = [];
  if (draft.mode === "ROAD") {
    const byVariant = new Map<string, number>();
    for (const t of draft.trucking)
      byVariant.set(t.rateVariant, (byVariant.get(t.rateVariant) ?? 0) + (t.amount ?? 0));
    for (const [key, rateAmount] of byVariant)
      variants.push({ key, rateAmount, grandTotal: rateAmount + sharedSubtotal });
  } else if (draft.mode === "SEA") {
    for (const r of draft.seaRates)
      variants.push({ key: r.rateVariant, rateAmount: r.amount, grandTotal: (r.amount ?? 0) + sharedSubtotal });
  } else {
    variants.push({ key: "AIR", rateAmount: null, grandTotal: sharedSubtotal });
  }
  return { variants, sharedSubtotal, chargeableWeightKg };
}
```

- [ ] **Step 4: Rebuild shared, run test + typecheck — expect PASS.** *(The submit-gate `validateQuote` below still lives in this file; Task 7 rewrites it — expect its old body to have compile errors against the new draft until Task 7. Run this task's engine tests in isolation via `-t`.)*

- [ ] **Step 5: Report to controller** — files: `packages/shared/src/quote-engine.ts`, `packages/shared/src/quote-engine.test.ts`. Message: `feat(shared): per-variant quote totals + heavy-weight calc; drop density`.

---

### Task 7: Submit-gate v2 (`validateQuote`)

**Files:**
- Modify: `packages/shared/src/quote-engine.ts` (`validateQuote`)
- Test: `packages/shared/src/quote-engine.test.ts` (extend — one case per rule)

**Interfaces:**
- Consumes: `QuoteDraft` v2, `ResolvedChargeLine[]` (the frozen active lines).
- Produces: `validateQuote(draft: QuoteDraft, deadlineIso: string, nowIso: string, activeLines?: ResolvedChargeLine[]): Finding[]` — the 6 blocking rules from design §7. Consumed by Task 8 (portal submit), Unit 4 (live findings), Unit 5.

- [ ] **Step 1: Write the failing tests** — currency/validity; unpriced active line; 0-without-remark; custom line missing remark; missing guaranteed transit; dual-rate none filled; past deadline. (One `it` per rule; assert the `rule` code appears.)

```ts
it("blocks when a Road leg has no rate filled", () => {
  const f = validateQuote(draftRoadNoRates(), future, now, activeLines);
  expect(f.some((x) => x.rule === "Q_RATE")).toBe(true);
});
it("blocks a zero-amount active line unless it carries a remark", () => { /* amount:0, note undefined → Q_PRICED */ });
it("blocks a custom [+Add] line without a remark", () => { /* definitionKey null & presetKey null & note '' → Q_CUSTOM_REMARK */ });
it("blocks a leg missing Guaranteed Transit Time", () => { /* transit.guaranteedTransitDays null → Q_TRANSIT */ });
it("passes a fully-priced single-variant Air quote", () => { expect(validateQuote(airOk, future, now, air)).toHaveLength(0); });
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Rewrite `validateQuote`** (replace the whole Q1–Q8 body):

```ts
export function validateQuote(
  draft: QuoteDraft, deadlineIso: string, nowIso: string, activeLines: ResolvedChargeLine[] = [],
): Finding[] {
  const f: Finding[] = [];
  const blk = (rule: string, message: string, scope: Finding["scope"]): Finding => ({ rule, severity: "blocking", scope, message });
  const leg = { type: "leg", id: draft.legId } as const;

  // (6) submission before the deadline
  if (new Date(nowIso).getTime() > new Date(deadlineIso).getTime())
    f.push(blk("Q_DEADLINE", "The submission deadline has passed", leg));

  // (1) currency + validity (validity ≥ deadline)
  if (!draft.currency) f.push(blk("Q_CURRENCY", "Currency is required", { type: "field", id: "currency" }));
  if (!draft.quoteValidityUntil) f.push(blk("Q_VALIDITY", "Quote Validity Until is required", { type: "field", id: "quoteValidityUntil" }));
  else if (new Date(draft.quoteValidityUntil).getTime() < new Date(deadlineIso).getTime())
    f.push(blk("Q_VALIDITY", "Quote Validity Until must be on or after the submission deadline", { type: "field", id: "quoteValidityUntil" }));

  // (2) every active charge line priced — amount present; 0 allowed ONLY with a remark
  const byKey = new Map(draft.charges.filter((c) => c.definitionKey).map((c) => [c.definitionKey!, c]));
  for (const line of activeLines) {
    if (line.inputType === "HEAVY_WEIGHT_CALC") {
      const c = byKey.get(line.definitionKey);
      if (!c || c.pieceWeightKg == null || c.airlineLimitKg == null || c.ratePerExcessKg == null)
        f.push(blk("Q_PRICED", `Heavy-Weight inputs are required for "${line.label}"`, leg));
      continue;
    }
    if (line.inputType !== "PLAIN") continue;
    const c = byKey.get(line.definitionKey);
    if (!c || c.amount == null) f.push(blk("Q_PRICED", `Charge line "${line.label}" must be priced`, leg));
    else if (c.amount === 0 && !c.note?.trim())
      f.push(blk("Q_PRICED", `A remark is required to quote "${line.label}" at 0`, leg));
  }

  // (3) remark mandatory on every custom [+ Add Charge] line
  for (const c of draft.charges)
    if (!c.definitionKey && !c.presetKey && !c.note?.trim())
      f.push(blk("Q_CUSTOM_REMARK", `A remark is required on the custom charge "${c.label}"`, leg));

  // (4) Guaranteed Transit Time present on every leg
  if (draft.transit?.guaranteedTransitDays == null)
    f.push(blk("Q_TRANSIT", "Guaranteed Transit Time is required", { type: "field", id: "guaranteedTransitDays" }));

  // (5) dual-rate — ≥1 of the two rates filled (each filled rate yields its own grand total)
  if (draft.mode === "ROAD" && !draft.trucking.some((t) => t.amount != null))
    f.push(blk("Q_RATE", "Enter at least one trucking rate (Dedicated or Groupage)", leg));
  if (draft.mode === "SEA" && !draft.seaRates.some((r) => r.amount != null))
    f.push(blk("Q_RATE", "Enter at least one sea freight rate (FCL or LCL)", leg));

  // warehouse: every included warehouse line priced
  for (const w of draft.warehouse)
    if (w.amount == null) f.push(blk("Q_PRICED", `Warehousing must be priced for ${w.label}`, leg));

  return f;
}
```

- [ ] **Step 4: Rebuild shared, run the full `quote-engine.test.ts` + typecheck — expect PASS.**

- [ ] **Step 5: Report to controller** — files: `packages/shared/src/quote-engine.ts`, `packages/shared/src/quote-engine.test.ts`. Message: `feat(shared): submit-gate v2 (dual-rate, mandatory transit, 0-needs-remark)`.

---

### Task 8: Tag two-gate resolver + catalogue seed additions

**Files:**
- Modify: `packages/shared/src/charge-config.ts` (`resolveChargeConfig` → tag-gated; include `HEAVY_WEIGHT_CALC`)
- Modify: `apps/api/src/seed/reference-seed.ts` (add FSC/Peak cores; flip Heavy-Weight to `HEAVY_WEIGHT_CALC`)
- Test: `packages/shared/src/charge-config.test.ts` (extend); `apps/api/test/reference-seed.e2e-spec.ts` (extend)

**Interfaces:**
- Consumes: `ChargeLineDefinitionDto[]`, `ReferenceTag[]` (the leg's union of package `effectiveTags`).
- Produces: `resolveChargeConfig(defs, selectedKeys, warehouseIncluded, packageTags: ReferenceTag[]): ChargeConfigSnapshot` — CORE always; STANDARD when selected; **TAG_DRIVEN when selected AND `tagKey ∈ packageTags`**; `lines` include `PLAIN` and `HEAVY_WEIGHT_CALC` inputTypes. Consumed by Unit 3 Task 12.

- [ ] **Step 1: Write the failing tests.**

```ts
// charge-config.test.ts
it("activates a tag-driven line only when selected AND a package carries the tag", () => {
  const defs = [
    { key: "AIR_TAG_DG", role: "TAG_DRIVEN", inputType: "PLAIN", tagKey: "DG", isActive: true, zone: "DESTINATION", label: "DG handling", mode: "AIR", id: "1", sortOrder: 16 },
    { key: "AIR_TAG_FRAGILE", role: "TAG_DRIVEN", inputType: "PLAIN", tagKey: "FRAGILE", isActive: true, zone: "DESTINATION", label: "Fragile", mode: "AIR", id: "2", sortOrder: 15 },
  ] as ChargeLineDefinitionDto[];
  const snap = resolveChargeConfig(defs, ["AIR_TAG_DG", "AIR_TAG_FRAGILE"], false, ["DG"]);
  expect(snap.lines.map((l) => l.definitionKey)).toEqual(["AIR_TAG_DG"]); // FRAGILE selected but no package carries it
});
it("includes a HEAVY_WEIGHT_CALC core line", () => {
  const defs = [{ key: "AIR_MAIN_HEAVY_WEIGHT", role: "CORE", inputType: "HEAVY_WEIGHT_CALC", tagKey: null, isActive: true, zone: "MAIN_FREIGHT", label: "Heavy Weight", mode: "AIR", id: "3", sortOrder: 9 }] as ChargeLineDefinitionDto[];
  expect(resolveChargeConfig(defs, [], false, []).lines).toHaveLength(1);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Rewrite `resolveChargeConfig`:**

```ts
import type { ReferenceTag } from "./cargo";

export function resolveChargeConfig(
  definitions: ChargeLineDefinitionDto[],
  selectedKeys: string[],
  warehouseIncluded: boolean,
  packageTags: ReferenceTag[] = [],
): ChargeConfigSnapshot {
  const selected = new Set(selectedKeys);
  const tagSet = new Set<string>(packageTags);
  const lines: ResolvedChargeLine[] = definitions
    .filter((d) => d.isActive && (d.inputType === "PLAIN" || d.inputType === "HEAVY_WEIGHT_CALC"))
    .filter((d) => {
      if (d.role === "CORE") return true;
      if (d.role === "STANDARD") return selected.has(d.key);
      if (d.role === "TAG_DRIVEN") return selected.has(d.key) && d.tagKey != null && tagSet.has(d.tagKey);
      return false;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => ({ definitionKey: d.key, role: d.role, inputType: d.inputType, zone: d.zone, label: d.label }));
  return { lines, warehouseIncluded };
}
```

- [ ] **Step 4: Seed additions in `reference-seed.ts`** — insert two Air cores after `AIR_MAIN_HEAVY_WEIGHT` (line 39) and change that line's `inputType`. The `ChargeDef` type (line 25) already has an optional `inputType`; add the two rows and set the calc inputType:

```ts
{ key: "AIR_MAIN_HEAVY_WEIGHT", mode: "AIR", role: "CORE", inputType: "HEAVY_WEIGHT_CALC", zone: "MAIN_FREIGHT", label: "Heavy Weight Surcharge", sortOrder: 9 },
{ key: "AIR_MAIN_FSC", mode: "AIR", role: "CORE", zone: "MAIN_FREIGHT", label: "Fuel Surcharge (FSC)", sortOrder: 9.1 },
{ key: "AIR_MAIN_PEAK_SEASON", mode: "AIR", role: "CORE", zone: "MAIN_FREIGHT", label: "Peak Season Surcharge", sortOrder: 9.2 },
```

*(Sea B/L `SEA_ORIGIN_BILL_OF_LADING` already exists as a CORE line — no seed change; the B/L dropdown is a portal-side attribute on that line's `ChargeLine.billOfLadingType`.)*

- [ ] **Step 5: Extend `reference-seed.e2e-spec.ts`** — assert the two new keys exist and `AIR_MAIN_HEAVY_WEIGHT.inputType === "HEAVY_WEIGHT_CALC"`. Run both suites — expect PASS. Rebuild shared first.

- [ ] **Step 6: Report to controller** — files: `packages/shared/src/charge-config.ts`, `packages/shared/src/charge-config.test.ts`, `apps/api/src/seed/reference-seed.ts`, `apps/api/test/reference-seed.e2e-spec.ts`. Message: `feat(shared,api): tag two-gate resolver + FSC/Peak/heavy-weight-calc catalogue`.

> **✅ UNIT 2 EXIT:** shared builds + typechecks; the v2 schema is migrated on :5433; the engine, submit-gate, two-gate, and catalogue are done. `apps/api` still `build`s green (Unit-1 code paths untouched; the portal service still uses the density writes — Task 9 rewrites them).

---

# UNIT 3 — API v2 wiring (freeze the two-gate; portal for kg + dual-rate + calc)

### Task 9: FF portal service v2 — kg, dual-rate, calc, per-variant totals

**Files:**
- Modify: `apps/api/src/modules/ff-portal/ff-portal.service.ts` (`resolveScope` seeds; `submit` draft rebuild + materialize)
- Modify: `packages/shared/src/ff-portal.ts` (`FfPortalLegDto` seeds → `chargedWeightKg`; `quoteDraftSchema` v2; drop `FfPortalSeededDensity`)
- Test: `apps/api/test/ff-portal.e2e-spec.ts` is rewritten in Unit 5; here add `apps/api/test/ff-portal-v2.e2e-spec.ts`

**Interfaces:**
- Consumes: v2 `QuoteDraft`, `computeQuoteTotals`, `computeHeavyWeightAmount`, `validateQuote` (Unit 2).
- Produces: portal serves per-package manifest + seeded lines (no density); submit materializes `QuoteCargoLine.chargedWeightKg`, dual `TruckingCharge`(rateVariant/tonnage) + `SeaFreightRate`, calc `ChargeLine` columns, and writes the per-variant `grandTotal` (persist the max variant as `Quote.grandTotal` for the Stage-4 grid; carry all variants in `draftJson`-free columns is out of scope — Stage-5 owns comparison). Consumed by Unit 4, Unit 5.

- [ ] **Step 1: `ff-portal.ts` DTO + schema v2.** Replace `FfPortalSeededDensity` usage with the package-grain seed the portal actually needs, and extend `quoteDraftSchema` to the v2 shape (cargo `packageId`/`chargedWeightKg`; `trucking.rateVariant`/`tonnage`; new `seaRates`; charge calc/B-L fields; transit mode-specific; `guaranteedTransitDays`). Full replacement of the `z.object` in `quoteDraftSchema` — mirror the Task-5 `QuoteDraft` shape field-for-field. Update `FfPortalLegDto`: drop `seededDensity`, keep `seededCharges` (now may include `HEAVY_WEIGHT_CALC` lines), add `seaRateVariants` hint if needed (optional).

- [ ] **Step 2: Write the failing e2e** (`ff-portal-v2.e2e-spec.ts`, isolated) — distribute a Road leg with a Dedicated+Groupage requirement + a DG package; GET portal; submit a draft pricing both trucking variants, a tag-driven DG line, and Charged Wt per package; assert:
  - `QuoteCargoLine.chargedWeightKg` persisted per package;
  - two `TruckingCharge` rows with distinct `rateVariant`;
  - `Quote.grandTotal` equals the engine's max variant total;
  - re-submitting a draft with an unpriced Guaranteed Transit → 422 with `Q_TRANSIT`.

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: `resolveScope`** — drop `seededDensity`; seed cargo Charged Wt as `null` (FF enters it). The `seededCharges` map already comes from `snap.lines`; keep it (now includes calc/tag lines). Remove the `densities`/`densityOf` block.

- [ ] **Step 5: `submit` — rebuild the v2 draft + materialize.** Replace the cargo/trucking/materialize blocks:

```ts
cargo: manifest.cargo.map((c) => ({
  packageId: c.packageId,
  grossWtKg: Number(c.grossWt),
  cbm: Number(c.volumeCbm ?? 0),
  chargedWeightKg: stored.cargo?.find((s) => s.packageId === c.packageId)?.chargedWeightKg ?? null,
})),
trucking: (stored.trucking ?? []).map((t) => ({ ...t })),
seaRates: (stored.seaRates ?? []).map((r) => ({ ...r })),
// ...charges/warehouse/transit from stored...
```

`validateQuote(draft, deadline, now, snap.lines)`. Then materialize:

```ts
const totals = computeQuoteTotals(draft);
// ...inside tx, after deleting child rows (add seaFreightRate.deleteMany):
await tx.quoteCargoLine.createMany({
  data: draft.cargo.map((c) => ({ quoteId: q.id, packageId: c.packageId, chargedWeightKg: c.chargedWeightKg! })),
});
await tx.chargeLine.createMany({
  data: draft.charges.map((c, i) => ({
    quoteId: q.id, zone: c.zone, definitionKey: c.definitionKey ?? null, label: c.label,
    isPreset: c.presetKey != null, presetKey: c.presetKey,
    amount: chargeAmount(c), // computeHeavyWeightAmount(...) for calc lines, else c.amount!
    note: c.note, sortOrder: i,
    pieceWeightKg: c.pieceWeightKg ?? null, airlineLimitKg: c.airlineLimitKg ?? null,
    ratePerExcessKg: c.ratePerExcessKg ?? null, billOfLadingType: c.billOfLadingType ?? null,
  })),
});
for (const t of draft.trucking)
  await tx.truckingCharge.create({ data: { quoteId: q.id, legEndpointPointId: t.legEndpointPointId,
    truckingType: t.truckingType, basis: t.basis, amount: t.amount!, remarks: t.remarks,
    rateVariant: t.rateVariant, tonnage: t.tonnage } });
for (const r of draft.seaRates)
  await tx.seaFreightRate.create({ data: { quoteId: q.id, rateVariant: r.rateVariant,
    containerSize: r.containerSize, amount: r.amount!, remarks: r.remarks } });
// warehouse rows: add cfsCode/side
await tx.quote.update({ where: { id: q.id }, data: {
  grandTotal: Math.max(...totals.variants.map((v) => v.grandTotal), 0),
  totalChargeableWeightT: null, // column kept for now; kg lives on QuoteCargoLine
  dgSurchargeNote: draft.dgSurchargeNote, termsConditions: draft.termsConditions,
  submittedAt: new Date(), draftJson: Prisma.DbNull,
} });
```

where `chargeAmount(c)` computes the calc line’s amount:

```ts
const chargeAmount = (c: QuoteDraftCharge): number =>
  c.pieceWeightKg != null && c.airlineLimitKg != null && c.ratePerExcessKg != null
    ? computeHeavyWeightAmount(c.pieceWeightKg, c.airlineLimitKg, c.ratePerExcessKg)
    : c.amount!;
```

Also add `TransitPlan` mode-specific fields to its `create`. Remove the `computeChargeableWeight` import.

- [ ] **Step 6: Run the e2e — expect PASS.** Rebuild shared first; `pnpm --filter @svyft/api build` still green.

- [ ] **Step 7: Report to controller** — files: `apps/api/src/modules/ff-portal/ff-portal.service.ts`, `packages/shared/src/ff-portal.ts`, `apps/api/test/ff-portal-v2.e2e-spec.ts`. Message: `feat(api): FF portal v2 — chargedWeightKg, dual-rate + sea rate, heavy-weight calc`.

---

### Task 10: Distribute freeze — resolve the tag two-gate against the frozen manifest

**Files:**
- Modify: `apps/api/src/modules/rfq/charge-config.snapshot.ts` (`buildChargeConfigSnapshot` takes the manifest cargo → passes `packageTags`)
- Modify: `apps/api/src/modules/rfq/rfq.service.ts:373-374` (pass `snapshot.cargo` into the snapshot builder)
- Test: `apps/api/test/charge-config-distribute.e2e-spec.ts` is rewritten in Unit 5; here add a focused `apps/api/test/tag-two-gate.e2e-spec.ts`

**Interfaces:**
- Consumes: `ManifestSnapshotCargo[]` (Task 2), `resolveChargeConfig` v2 (Task 8).
- Produces: `buildChargeConfigSnapshot(prisma, leg, manifestCargo: ManifestSnapshotCargo[])` — freezes the tag-gated active lines. Consumed by Unit 5 change-order/charge-config specs.

- [ ] **Step 1: Write the failing e2e** — Exec selects `AIR_TAG_DG` + `AIR_TAG_FRAGILE`; the leg's packages carry only DG; distribute; assert the frozen `chargeConfigSnapshot.lines` include `AIR_TAG_DG` but **not** `AIR_TAG_FRAGILE`.

- [ ] **Step 2: Run — expect FAIL** (today's `buildChargeConfigSnapshot` ignores tags → both appear).

- [ ] **Step 3: Re-point the builder:**

```ts
import type { ManifestSnapshotCargo } from "@svyft/shared";

export async function buildChargeConfigSnapshot(
  prisma: Pick<PrismaService, "chargeLineDefinition">,
  leg: LegRfqRow,
  manifestCargo: ManifestSnapshotCargo[],
): Promise<ChargeConfigSnapshot> {
  const defs = await prisma.chargeLineDefinition.findMany({ where: { mode: leg.mode ?? undefined, isActive: true } });
  const dtos: ChargeLineDefinitionDto[] = defs.map((d) => ({ /* …unchanged map… */ }));
  const selectedKeys = leg.chargeSelections.map((s) => s.definition.key);
  const packageTags = [...new Set(manifestCargo.flatMap((c) => c.tags))];
  return resolveChargeConfig(dtos, selectedKeys, leg.warehouseHandlingIncluded === true, packageTags);
}
```

- [ ] **Step 4: `rfq.service.performDistribution`** — pass the just-built manifest cargo:

```ts
const snapshot = buildManifestSnapshot(legCtx, query, frozenAt);
const chargeConfig = await buildChargeConfigSnapshot(this.prisma, legCtx.leg, snapshot.cargo);
```

- [ ] **Step 5: Run the e2e — expect PASS.** Verify the change-order re-freeze path (`change-order.strategy` / SB6) still compiles — it calls the same two builders, so the two-gate flows through automatically; add a `// two-gate re-resolves on re-freeze` assertion only if the strategy already has a cascade e2e (rewritten in Unit 5).

- [ ] **Step 6: Report to controller** — files: `apps/api/src/modules/rfq/charge-config.snapshot.ts`, `apps/api/src/modules/rfq/rfq.service.ts`, `apps/api/test/tag-two-gate.e2e-spec.ts`. Message: `feat(api): freeze the tag two-gate against the per-package manifest at distribute`.

> **✅ UNIT 3 EXIT:** distribute freezes per-package tags + tag-gated lines; the portal serves + submits the full v2 model. `pnpm --filter @svyft/api build` green. (Legacy specs still red → Unit 5.)

---

# UNIT 4 — Web (Executive re-point + FF Portal v5 + Route-SVG/PDF/Preview)

> **Mechanical-re-point unit.** Each task lists exact files, the DTO fields to consume, the test pattern, and acceptance. Web tests = **vitest** (`pnpm --filter @svyft/web test -- <path>`); pattern = `renderHook`/`render` + `vi.stubGlobal("fetch", …)` + a manual `QueryClientProvider` wrapper; Radix `Select` is jsdom-flaky → drive the hidden native `<select>`. `@svyft/shared` resolves from **dist** → `pnpm --filter @svyft/shared build` before web typecheck/build. Full real code is given for new pure helpers; existing component JSX is edited in place against the live file.

### Task 11: Executive `rfq-workspace` re-point to package grain

**Files (all under `apps/web/src/features/rfq-workspace/`):** `QueryOverviewHeader.tsx`, `CargoTagIcons.tsx` (already DG-as-tag — verify), `PreviewRfqDialog.tsx`, `RfqWorkspace.tsx`, `LegPanel.tsx`; tests colocated.

**Consumes:** `QueryDetail.cargos: CargoDto[]` (was `cargo`), `PackageDto`, `QueryLegDto.assignedPackageIds` (already renamed in Stage-3 T16).

- [ ] **Step 1:** Update each component to read `detail.cargos` / `PackageDto` / `assignedPackageIds`. The Preview dialog renders the manifest per package (packageNo, type, canonical dims via `fromCanonicalDim`, gross/net kg, CBM, effectiveTags badges). `CargoTagIcons` already handles DG (Stage-3) — confirm no `isDangerous` prop remains.
- [ ] **Step 2:** Update each colocated `*.test.tsx` fixture to the `CargoDto`/`PackageDto` shape (typed fixtures so drift is a compile error). Run each suite green.
- [ ] **Step 3:** `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web typecheck` — the `rfq-workspace/*` red clears.
- [ ] **Step 4: Report** — message: `fix(web): re-point rfq-workspace to Cargo→Package grain`.

### Task 12: FF Portal — package list + Charged Wt (kg) + read-only tags

**Files:** `apps/web/src/features/ff-portal/CargoManifestTable.tsx` (+ test); replace `DensityChargeableGrid.tsx`/`.test.tsx` with a `ChargedWeightGrid.tsx`; `draftFromDto.ts` (+ test), `useFfPortal.ts`.

**Consumes:** `FfPortalLegDto.manifest.cargo` (per-package: packageNo, packageType, packageCount, canonical dims/kg, volumeCbm, tags).

- [ ] **Step 1:** `CargoManifestTable` renders read-only cols **SN · Count · Type · L/W/H · Net · Gross · CBM · Tags** (no PO/product). Tags render via the shared tag-badge component (DG included), read-only.
- [ ] **Step 2:** New `ChargedWeightGrid` — one editable **Charged Wt (kg)** `NumberField` per package, writing `draft.cargo[i].chargedWeightKg`. Remove all density UI/labels.
- [ ] **Step 3:** `draftFromDto.ts` — build `draft.cargo` as `{ packageId, grossWtKg, cbm, chargedWeightKg: null }` from the manifest; add `seaRates: []`. Update its test.
- [ ] **Step 4:** Run the ff-portal suites; `pnpm --filter @svyft/web typecheck`. **Report** — `feat(web): FF portal package list + Charged Wt (kg)`.

### Task 13: FF Portal — dual-rate Road (Dedicated[tonnage] / Groupage) + two totals

**Files:** `RoadChargesPanel.tsx`, `TruckingBlocks.tsx` (+ tests), `QuoteSummary.tsx` (+ test), `WarehouseStaging.tsx` (+ test), `numeric.ts` if a helper is needed.

**Consumes:** `TRUCK_TONNAGES`/`truckTonnageLabel`, `CHARGE_RATE_VARIANTS` (shared); `computeQuoteTotals` (per-variant).

- [ ] **Step 1:** `TruckingBlocks` renders two rate rows — **Dedicated** (with a `tonnage` Select from `TRUCK_TONNAGES`) and **Groupage** — each writing a `draft.trucking[]` entry with `rateVariant` set; `basis`/`amount`/`remarks` as today.
- [ ] **Step 2:** `WarehouseStaging` (mode-agnostic; shared by Road & Sea panels) renders `cfsCode` **read-only** + the **side-specific** seeded warehouse lines when `warehouseIncluded` (Drop: Warehousing-In + onward-truck; Pickup: Warehousing-Out + storage-before-dispatch) + the FF `[+ Add Charge]`, writing `draft.warehouse[]` with `cfsCode`/`side`.
- [ ] **Step 3:** `QuoteSummary` shows **two grand totals side-by-side** from `computeQuoteTotals(draft).variants`; a variant with `rateAmount == null` renders `–`.
- [ ] **Step 4:** Tests: two priced variants → two totals over the shared subtotal; blank Groupage → `–`; warehouse lines roll into both totals when included. Drive the hidden native `<select>` for tonnage. **Report** — `feat(web): FF portal dual-rate Road + warehouse zones + two grand totals`.

### Task 14: FF Portal — Air (FSC/Peak + Heavy-Weight calculator)

**Files:** `ChargeZonePanel.tsx` (+ test); a new `HeavyWeightCalcRow.tsx` (+ test).

**Consumes:** the frozen `seededCharges` (now includes `AIR_MAIN_FSC`, `AIR_MAIN_PEAK_SEASON`, and the `HEAVY_WEIGHT_CALC` line by `inputType`); `computeHeavyWeightAmount` (shared).

- [ ] **Step 1:** `ChargeZonePanel` renders a seeded line by `inputType`: `PLAIN` → amount field (as today); `HEAVY_WEIGHT_CALC` → the `HeavyWeightCalcRow` (three inputs: `pieceWeightKg`, `airlineLimitKg`, `ratePerExcessKg`) with a **live computed amount** = `computeHeavyWeightAmount(...)`, read-only, written back onto the draft charge.
- [ ] **Step 2:** Tests: FSC/Peak appear as normal priceable lines; the calc row shows 400 for (1200, 1000, 2) and 0 for (800, 1000, 2). **Report** — `feat(web): FF portal Air FSC/Peak + heavy-weight calculator`.

### Task 15: FF Portal — Sea (dual FCL[container]/LCL + B/L dropdown)

**Files:** a new `SeaChargesPanel.tsx` (+ test) mirroring `RoadChargesPanel`; `ChargeZonePanel` for the B/L line; `QuoteSummary` (reuse Task 13's two-total UI).

**Consumes:** `CONTAINER_SIZES`/`containerSizeLabel`, `BILL_OF_LADING_TYPES`, `CHARGE_RATE_VARIANTS` (shared).

- [ ] **Step 1:** Two sea rate rows — **FCL** (with a `containerSize` Select) and **LCL** — each writing `draft.seaRates[]` with `rateVariant` set.
- [ ] **Step 2:** The Zone-1 **Bill of Lading** line gets a `billOfLadingType` dropdown (ORIGINAL/TELEX) written onto that charge.
- [ ] **Step 3:** `QuoteSummary` shows the two sea totals (FCL/LCL) from `variants`. Tests as Task 13. **Report** — `feat(web): FF portal dual-rate Sea + B/L dropdown`.

### Task 16: FF Portal — mode-specific transit + submit-gate v2 wiring

**Files:** `TransitPlanForm.tsx` (+ test), `SubmissionBar.tsx`/`QuoteFindingsSummary.tsx` (+ tests), `useFfPortal.ts`.

**Consumes:** `validateQuote` v2 (shared) for live findings; `QuoteDraftTransit` v2 fields.

- [ ] **Step 1:** `TransitPlanForm` renders mode-specific fields — Road: `plannedPickupDate`; Air: `airline`/`flightNumber`/`plannedDeparture`/`plannedArrival`; Sea: `shippingLine`/`vesselVoyage`/`etd`/`eta` — and a **mandatory Guaranteed Transit Time** field for every mode.
- [ ] **Step 2:** Wire the live `validateQuote(draft, deadline, now, activeLines)` findings into `QuoteFindingsSummary`/`SubmissionBar` (the new rule codes `Q_*`); a missing Guaranteed Transit blocks submit.
- [ ] **Step 3:** Tests per mode + the transit-required gate. **Report** — `feat(web): FF portal mode-specific transit + submit-gate v2`.

### Task 17: Route Overview SVG on the portal (`ScopedRouteDiagram`)

**Files:** new `apps/web/src/features/ff-portal/ScopedRouteDiagram.tsx` (+ test); reuse the existing client route-graph builder (`apps/web/src/features/query-wizard/.../routeGraph.ts` — already re-modelled to package grain in Stage-3 W5) and the `RouteDiagram` SVG primitive.

- [ ] **Step 1:** Render an assignment-scoped, **address-masked** route diagram (nodes = the FF's leg endpoints; mask street address, show city/country/type; node-detail-on-click). Build the graph from the frozen manifest legs, not the full query.
- [ ] **Step 2:** Test: renders N nodes for N endpoints; no street address in the DOM. **Report** — `feat(web): scoped Route Overview SVG on the FF portal`.

### Task 18: RFQ PDF download + FF Preview

**Files:** new `apps/web/src/features/ff-portal/rfqPdf.ts` (+ test) and a **Download PDF** action in `PortalShell.tsx`/`SubmissionBar.tsx`; a Preview affordance in `SubmissionBar.tsx`.

- [ ] **Step 1:** Generate a print-friendly RFQ document (header + per-leg package list + priced charges + two totals + transit + T&C). Prefer a self-contained client render (`window.print()` of a print stylesheet, or an inlined jsPDF-free HTML-to-print) — **no new heavy deps** unless the repo already ships one (check `apps/web/package.json` first; if a PDF lib exists, use it).
- [ ] **Step 2:** Preview opens the same rendered document read-only before submit.
- [ ] **Step 3:** Test: the document includes the priced lines + both totals. **Report** — `feat(web): RFQ PDF download + preview`.

> **✅ UNIT 4 EXIT:** `pnpm --filter @svyft/web typecheck` green; `pnpm --filter @svyft/web test` green on the ff-portal + rfq-workspace surfaces. (The pre-existing `Step1Client` date-rollover flake stays parked — see Unit 6.)

---

# UNIT 5 — Rewrite the ~25 Stage-4 e2e specs

The legacy specs build cargo via `prisma.cargoItem` / `legCargo.create` / old fields (`freightDensity`, `chargeableWeightT`, `assignedCargoIds`, `.qty`). They must build `Cargo → Package → Item` + `LegPackage` + `assignedPackageIds`, and price at the v2 grain. **First ship a shared test helper, then re-point the specs in clusters** so a reviewer can gate each cluster.

### Task 19: Shared e2e cargo-builder helper

**Files:** new `apps/api/test/helpers/cargo.ts`.

- [ ] **Step 1:** Write `createCargoWithPackages(prisma, { queryId, tenantId, packages: [{ packageNo, packageType, dimL,W,H, grossWt, netWt?, tags?, items?: [{ qty?, uom?, tags? }] }] })` → creates one `Cargo` (+ dimUnit/weightUnit) and its `Package`s/`Item`s at canonical units, returns the created ids. Add `assignPackagesToLeg(prisma, legId, packageIds)` → `LegPackage` rows. Model the shape on `apps/api/test/rfq-manifest.e2e-spec.ts` (Task 2) so it's already proven.
- [ ] **Step 2:** A trivial self-test spec that creates a cargo+2 packages+1 DG item and asserts `effectiveTags` include DG. Run green. **Report** — `test(api): shared package-grain cargo builder for e2e`.

### Task 20: Re-point the RFQ-distribution cluster

**Files:** `rfq-distribute.e2e-spec.ts`, `rfq-distribute-all.e2e-spec.ts`, `rfq-distribution-flow.e2e-spec.ts`, `rfq-distribute-comms.e2e-spec.ts`, `rfq-eligibility.e2e-spec.ts`, `rfq-selection.e2e-spec.ts`, `rfq-expiry.e2e-spec.ts`, `rfq-reissue-token.e2e-spec.ts`, `redistribute-reactivate.e2e-spec.ts`, `query-no-response.e2e-spec.ts`.

- [ ] **Step 1:** Replace each `prisma.cargoItem.create` + `legCargo.create` with `createCargoWithPackages` + `assignPackagesToLeg` (Task 19). Assert the per-package manifest shape where the spec inspects `manifestSnapshot`. Run each green via the isolated config. **Report** — `test(api): re-point RFQ-distribution specs to package grain`.

### Task 21: Re-point the pricing / charge-config / portal / warehouse cluster

**Files:** `quote-pricing-schema.e2e-spec.ts`, `charge-config-distribute.e2e-spec.ts`, `charge-config-lock.e2e-spec.ts`, `ff-portal.e2e-spec.ts`, `warehouse-attribution.e2e-spec.ts`.

- [ ] **Step 1:** Build cargo via the helper; price at the v2 grain (`chargedWeightKg`, dual-rate trucking/seaRates, calc lines); assert the two-gate + per-variant totals. Fold the focused specs from Tasks 9/10 (`ff-portal-v2`, `tag-two-gate`) into these canonical files or keep them alongside — reviewer's call. Run green. **Report** — `test(api): re-point pricing/charge-config/portal/warehouse specs`.

### Task 22: Re-point the change-order / mediator cluster

**Files:** `change-mediator.e2e-spec.ts`, `change-order-apply.e2e-spec.ts`, `change-order-http.e2e-spec.ts`, `change-order-cascade.e2e-spec.ts`, `change-order-preview.e2e-spec.ts`.

- [ ] **Step 1:** Build cargo/packages via the helper; drive Structural/RfqDefining changes at package grain; assert the change-order re-freeze carries the per-package manifest + re-resolved two-gate. Run green. **Report** — `test(api): re-point change-order/mediator specs to package grain`.

### Task 23: Re-point the model / query / route cluster

**Files:** `create-query-route.e2e-spec.ts`, `queries.e2e-spec.ts`, `query-cargo-model.e2e-spec.ts`, `points-legs-model.e2e-spec.ts`, `prisma-change-log.e2e-spec.ts`.

- [ ] **Step 1:** Re-point to `Cargo/Package/Item`/`LegPackage`/`assignedPackageIds`. Some of these may already be Stage-3-green (item/query-tree/legs) — only the ones still referencing the old model need edits. Run the **full** api suite. **Report** — `test(api): re-point remaining model/query/route specs`.

- [ ] **Step 2: Unit-5 gate** — `set -a; . apps/api/.env; set +a && pnpm --filter @svyft/shared build && pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api test`. Expected: **typecheck 0 errors** (the 112 cleared) + **all e2e green**.

> **✅ UNIT 5 EXIT:** `apps/api` fully typechecks + all e2e pass on :5433.

---

# UNIT 6 — Final gate + whole-branch review + finish/PR

### Task 24: Full CI green + prettier normalization + carried Minors

**Files:** repo-wide.

- [ ] **Step 1:** Address the carried Minors from the ledger's final-review triage list (only the still-relevant ones): `assignApplied` helper for the `ConflictException`-on-`needsConfirmation` boilerplate; `FindingScope.type` add `"item"`; stale comments (`package.service.ts:43`); LegEditor "Assigned Cargo" → "Assigned Packages" label; the doc §8.6 contradiction. Skip anything already resolved.
- [ ] **Step 2:** Branch-wide `pnpm exec prettier --write .` (consolidates the per-unit prettier drift noted across the Stage-3 ledger). Review the diff is whitespace-only on untouched files.
- [ ] **Step 3:** `pnpm run ci` (lint + typecheck + test + build across all workspaces) — **green**. Fix anything red. Note: the pre-existing `Step1Client` UTC-vs-local date-boundary flake is **parked** (passes on CI's UTC runner; untouched file) — do not chase it locally.
- [ ] **Step 4: Report** — message: `chore: branch-wide prettier + carried-minor cleanup; ci green`.

### Task 25: Opus whole-branch review → finish/PR

- [ ] **Step 1:** Run the **REQUIRED SUB-SKILL** `superpowers:requesting-code-review` for a whole-branch opus review (`main@497e0d2..HEAD`): the Cargo→Package ripple + the full v2 upgrade. Feed the reviewer this plan + the design doc. Fix any Critical/Important; re-review if needed.
- [ ] **Step 2:** Run the **REQUIRED SUB-SKILL** `superpowers:finishing-a-development-branch`. **PR body MUST include the 🔴 go-live gate** (destructive migration; verify/accept the Neon-prod `CargoItem`/`LegCargo`/`QuoteCargoLine` wipe; staging Neon-branch test path; `count(*)` prod-loss quantification) and state the branch is **not to be merged** until the user approves the cutover.
- [ ] **Step 3:** Update `docs/Stage 4 - Session Handoff.md` (mark the Cargo→Package ripple + FF Portal v2 DELIVERED; link the PR) and `.superpowers/sdd/progress.md` (final ledger line). Update the memory `[[ff-portal-v2-blocked-on-cargo-remodel]]` → resolved.

> **✅ UNIT 6 EXIT / BRANCH DONE:** `pnpm run ci` green, opus-reviewed, PR open with the go-live gate, awaiting the user's merge/cutover decision.

---

## Self-Review (spec coverage · placeholders · type consistency)

**Spec coverage** (design §5–§16 → task):
- §5.1 chargedWeightKg / drop density → Tasks 4, 5, 6, 9 ✓
- §5.2 dual-rate (TruckingCharge.rateVariant/tonnage, SeaFreightRate, enums) → Tasks 4, 5, 6, 9, 13, 15 ✓
- §5.3 catalogue (FSC/Peak, HEAVY_WEIGHT_CALC, Sea B/L) → Tasks 4, 8, 14, 15 ✓
- §5.4 per-package manifest + two-gate → Tasks 1, 2, 8, 10 ✓
- §5.5 warehouse cfsCode/side → Tasks 4, 5, 9 (materialize), web warehouse (folded into Task 13/16 panels — **see note**) ✓
- §5.6 mode-specific + mandatory transit → Tasks 4, 5, 7, 16 ✓
- §6 engine per-variant + calc → Task 6 ✓
- §7 submit-gate v2 → Task 7 (+ web wiring Task 16) ✓
- §8 FF portal v5 → Tasks 12–18 ✓
- §9 ripple re-point → Tasks 1–3 ✓
- §10 exec web → Task 11 ✓
- §13 migration → Task 4 ✓
- §14 testing → distributed across every task + Unit 5 ✓
- §15 build sequence → Units 1–6 map 1:1 ✓
- §16 go-live → Global Constraints + Task 25 ✓

**Gap found + fixed:** §5.5 warehouse **web** rendering (cfsCode read-only + side-specific lines) had no explicit web task. → **Fold into Task 13 (Road panel) and Task 16**, and add the WarehouseStaging component to their file lists. *(Editing inline: Task 13 file list += `WarehouseStaging.tsx`; Task 13 Step 1 += "render `cfsCode` read-only + the side-specific seeded warehouse lines when `warehouseIncluded`.")*

**Placeholder scan:** no "TBD/TODO/handle edge cases". Units 4–5 intentionally describe edits to existing files rather than reproducing 40 components verbatim — flagged explicitly in each unit header and the Global Constraints "How to read" note; every *new* helper carries full code.

**Type consistency:** `chargedWeightKg` (not `chargeWeightKg`), `rateVariant`/`ChargeRateVariant`, `QuoteVariantTotal.{key,rateAmount,grandTotal}`, `computeHeavyWeightAmount(pieceWeightKg, airlineLimitKg, ratePerExcessKg)`, `resolveChargeConfig(defs, selectedKeys, warehouseIncluded, packageTags)`, `ManifestSnapshotCargo.{packageId,tags}`, `buildChargeConfigSnapshot(prisma, leg, manifestCargo)` — all used identically across Tasks 4→25. Unit 1 deliberately keeps `QuoteDraftCargo.cargoItemId` (holding a packageId) and renames it to `packageId` in Task 5 — the one intentional two-step, flagged in Task 3's churn note.
