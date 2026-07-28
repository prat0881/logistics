# Stage 4 · Sub-build 4a — Quote Model & Chargeable-Weight Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Work in the **fresh git worktree** already set up on branch `feat/stage-4-sb4a` (off `main`).

**Goal:** Build the persistence + pure-computation foundation for FF quoting — the five pricing child tables, the new `Quote` pricing columns, the four pricing enums, the O-S4-3 column drop, and the isomorphic `@svyft/shared` quote engine (chargeable weight, totals, §10.4 Q1–Q8 validation, warehouse-position inference). **No HTTP, no guard, no UI** (those are SB4b/4c).

**Architecture:** Prisma models hang the pricing tables off `Quote` (`onDelete: Cascade`); enums follow the settled shared-const + Prisma-enum mirror. The engine lives in `packages/shared/src/quote.ts` (vocab, `QuoteDraft` shapes, charge presets) + `packages/shared/src/quote-engine.ts` (the four pure functions) — no Nest/DB deps, so it unit-tests in `@svyft/shared` and (in 4b/4c) runs server-authoritatively and client-live over one `QuoteDraft` shape with zero drift (Technical Design §6.3). Density defaults come from the **existing** `FreightDensityFactor` config table (not re-added here).

**Tech Stack:** Prisma 5 (PostgreSQL) · TypeScript (`@svyft/shared`, pure) · Vitest (shared unit tests) · Jest e2e (api smoke) · pnpm monorepo.

## Global Constraints

Every task implicitly includes this. Values copied verbatim from the design doc (`docs/plans/stage-4/Stage 4 - Sub-build 4 - Decomposition & 4a Design.md`) + Technical Design §4/§6 + spec §7.4/§8/§10.4.

- **Schema at the repo root** `prisma/schema.prisma`; migrate from repo root `pnpm exec prisma migrate dev --name <name>`; generate `pnpm exec prisma generate`. **DB safety:** local Postgres on **`:5433`** (Docker/colima). Migrations additive except the sanctioned O-S4-3 drop. **If Prisma proposes a RESET/DROP you did not author, STOP** — it's a shared dev DB.
- **Shared rebuild:** after editing `packages/shared/src/`, run `pnpm --filter @svyft/shared build` (api/web resolve the BUILT `@svyft/shared`; Vitest reads dist). Add every new export to `packages/shared/src/index.ts`.
- **Shared-enum pattern (never a TS `enum`):** a `const` object + a union type `(typeof X)[keyof typeof X]` + `Object.values(X) as [X, ...X[]]`, pinned by a `toEqual` test. Mirror each with a Prisma `enum` whose members match exactly.
- **Decimals:** money (`amount`, `grandTotal`, `carrierSurcharge`) `@db.Decimal(14, 2)`; density + weights `@db.Decimal(12, 3)`. Serialize Decimal → string in any DTO (Stage-3 convention). Prisma `Json` for nothing here.
- **Chargeable-weight formula (§6.1, §7.4.2):** `chargeableWeightT = max(grossWtT, cbm × densityKgPerCbm / 1000)` — density kg/CBM, cbm m³, result **tonnes**. Density seeds (S12): Air 167 / Sea 1000 / Road 333 kg/CBM (already in `FreightDensityFactor`).
- **Findings envelope:** the engine emits `Finding[]` — `{ rule, severity: "blocking"|"warning", scope: { type: "query"|"leg"|"cargo"|"point"|"field", id? }, message }` (from `@svyft/shared` `findings.ts`), the SAME shape as the route engine (§5.3), so portal + workspace render one path. All §10.4 submit rules are **blocking**.
- **Engine is pure:** `packages/shared/src/quote*.ts` import only from other `@svyft/shared` files and standard JS — **no** `@prisma/client`, no Nest, no `Date.now()` inside pure fns (pass `nowIso`).
- **e2e teardown:** any api e2e that boots `AppModule` MUST `await app.close()` in `afterAll` (cron-hang; no forceExit) and be self-contained (create+delete its own fixtures).
- **LINT is verification:** run `pnpm --filter @svyft/shared lint` + `pnpm --filter @svyft/api lint` before commits; no `@typescript-eslint/no-unused-vars`.
- **Commits:** conventional (`feat(quote):`, `chore(prisma):`, `test(quote):`) + co-author trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Fresh-worktree setup — ALREADY DONE

The worktree `feat/stage-4-sb4a` is set up: deps installed, `.env` copied, `prisma generate` + `@svyft/shared build` run, DB up on `:5433`. Baseline verified green: shared **186** tests + lint + typecheck; api typecheck + lint + rfq e2e **23**. If resuming fresh, re-run: `pnpm install` · copy `apps/api/.env` from the main checkout · `pnpm exec prisma generate` · `pnpm --filter @svyft/shared build`.

---

## File Structure

**New:** `packages/shared/src/quote.ts` (enums, `QuoteDraft` shapes, charge presets) + `quote.test.ts`; `packages/shared/src/quote-engine.ts` (the four pure fns) + `quote-engine.test.ts`.
**Modified:** `prisma/schema.prisma` (4 enums + 5 tables + `Quote` cols + back-relations; drop 4 cols) + two migrations; `packages/shared/src/index.ts` (exports); `packages/shared/src/cargo.ts` + `query.ts` (drop DTO fields); `apps/api/src/modules/cargo/cargo.service.ts` (drop export cols); the ~15 web test mocks referencing the dropped fields.

---

## Task 1: Shared quote vocabulary — enums, `QuoteDraft`, charge presets

**Goal:** the pure shared data shapes the engine + Prisma + later sub-builds all reference.

**Files:** Create `packages/shared/src/quote.ts`, `packages/shared/src/quote.test.ts`; Modify `packages/shared/src/index.ts`.

**Interfaces:**
- Produces: enums `ChargeZone`/`TruckingType`/`TruckingBasis`/`WarehousePosition` (+ `*_VALUES` arrays); types `QuoteDraftCargo`/`QuoteDraftCharge`/`QuoteDraftTrucking`/`QuoteDraftWarehouse`/`QuoteDraftTransit`/`QuoteDraft`; `ChargePreset` + `AIR_CHARGE_PRESETS`/`SEA_CHARGE_PRESETS`.

- [ ] **Step 1: Write the failing test** `packages/shared/src/quote.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  CHARGE_ZONES, TRUCKING_TYPES, TRUCKING_BASES, WAREHOUSE_POSITIONS,
  AIR_CHARGE_PRESETS, SEA_CHARGE_PRESETS,
} from "./quote";

describe("quote vocabulary", () => {
  it("pins the enum value sets", () => {
    expect(CHARGE_ZONES).toEqual(["ORIGIN", "MAIN_FREIGHT", "DESTINATION"]);
    expect(TRUCKING_TYPES).toEqual(["DEDICATED", "GROUPAGE"]);
    expect(TRUCKING_BASES).toEqual(["PER_TRUCK", "PER_CBM", "PER_TON", "FIXED"]);
    expect(WAREHOUSE_POSITIONS).toEqual(["ORIGIN", "DESTINATION"]);
  });
  it("has the mandatory Air/Sea preset lines from spec §7.4.3.1/.2", () => {
    expect(AIR_CHARGE_PRESETS.map((p) => p.label)).toEqual([
      "Export Customs Clearance", "Documentation Charges", "Origin THC / Airport Handling",
      "Security / Screening Charges", "Warehouse / Pre-storage at OAP",
      "Air Freight Charges", "Security Exchange (SEC)", "Airline / Carrier Surcharge", "Heavy Weight Surcharge",
      "Destination THC / Airport Handling", "Import Customs Clearance", "Last Mile Handling / Lift Gate", "Storage 1 Free Day Charges",
    ]);
    expect(AIR_CHARGE_PRESETS.filter((p) => p.zone === "MAIN_FREIGHT")).toHaveLength(4);
    expect(SEA_CHARGE_PRESETS.filter((p) => p.zone === "MAIN_FREIGHT")).toHaveLength(1);
    expect(new Set(SEA_CHARGE_PRESETS.map((p) => p.presetKey)).size).toBe(SEA_CHARGE_PRESETS.length); // keys unique
  });
});
```

- [ ] **Step 2: Run — RED.** `pnpm --filter @svyft/shared test -- quote` → fail (module missing).

- [ ] **Step 3: Create `packages/shared/src/quote.ts`.** Enums (shared-const pattern), then `QuoteDraft` shapes, then presets:
```ts
import type { FreightMode } from "./config";

export const ChargeZone = { ORIGIN: "ORIGIN", MAIN_FREIGHT: "MAIN_FREIGHT", DESTINATION: "DESTINATION" } as const;
export type ChargeZone = (typeof ChargeZone)[keyof typeof ChargeZone];
export const CHARGE_ZONES = Object.values(ChargeZone) as [ChargeZone, ...ChargeZone[]];

export const TruckingType = { DEDICATED: "DEDICATED", GROUPAGE: "GROUPAGE" } as const;
export type TruckingType = (typeof TruckingType)[keyof typeof TruckingType];
export const TRUCKING_TYPES = Object.values(TruckingType) as [TruckingType, ...TruckingType[]];

export const TruckingBasis = { PER_TRUCK: "PER_TRUCK", PER_CBM: "PER_CBM", PER_TON: "PER_TON", FIXED: "FIXED" } as const;
export type TruckingBasis = (typeof TruckingBasis)[keyof typeof TruckingBasis];
export const TRUCKING_BASES = Object.values(TruckingBasis) as [TruckingBasis, ...TruckingBasis[]];

export const WarehousePosition = { ORIGIN: "ORIGIN", DESTINATION: "DESTINATION" } as const;
export type WarehousePosition = (typeof WarehousePosition)[keyof typeof WarehousePosition];
export const WAREHOUSE_POSITIONS = Object.values(WarehousePosition) as [WarehousePosition, ...WarehousePosition[]];

// ── QuoteDraft: the single engine input (server-authoritative + client-live, §6.3) ──
export interface QuoteDraftCargo {
  cargoItemId: string;
  grossWtT: number;       // TONNES (caller converts the manifest's grossWt kg → /1000)
  cbm: number;            // m³
  isDangerous: boolean;
  freightDensity: number | null; // kg/CBM (seeded from FreightDensityFactor, editable)
}
export interface QuoteDraftCharge {
  zone: ChargeZone; presetKey: string | null; label: string; amount: number | null; note?: string;
}
export interface QuoteDraftTrucking {
  legEndpointPointId: string; truckingType: TruckingType; basis: TruckingBasis; amount: number | null; remarks?: string;
}
export interface QuoteDraftWarehouse {
  warehousePointId: string; position: WarehousePosition; label: string; amount: number | null; cargoAcceptanceWindow?: string;
}
export interface QuoteDraftTransit {
  departureDate: string | null; arrivalDate: string | null;
  carrier?: string | null; flightVoyageNo?: string | null; carrierSurcharge?: number | null; guaranteedTransitDays?: number | null;
}
export interface QuoteDraft {
  legId: string;
  mode: FreightMode | null;
  currency: string | null;
  quoteValidityUntil: string | null; // ISO
  cargo: QuoteDraftCargo[];
  charges: QuoteDraftCharge[];        // Air/Sea zone lines
  trucking: QuoteDraftTrucking[];     // Road blocks
  warehouse: QuoteDraftWarehouse[];
  transit: QuoteDraftTransit | null;
  dgSurchargeNote: string | null;
  termsConditions: string | null;
}

// ── Charge-line presets (spec §7.4.3.1 Air / §7.4.3.2 Sea), in display order ──
export interface ChargePreset { zone: ChargeZone; presetKey: string; label: string; }
export const AIR_CHARGE_PRESETS: ChargePreset[] = [
  { zone: "ORIGIN", presetKey: "AIR_ORIGIN_EXPORT_CLEARANCE", label: "Export Customs Clearance" },
  { zone: "ORIGIN", presetKey: "AIR_ORIGIN_DOCUMENTATION", label: "Documentation Charges" },
  { zone: "ORIGIN", presetKey: "AIR_ORIGIN_THC", label: "Origin THC / Airport Handling" },
  { zone: "ORIGIN", presetKey: "AIR_ORIGIN_SECURITY", label: "Security / Screening Charges" },
  { zone: "ORIGIN", presetKey: "AIR_ORIGIN_WAREHOUSE_PRESTORAGE", label: "Warehouse / Pre-storage at OAP" },
  { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_FREIGHT", label: "Air Freight Charges" },
  { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_SEC", label: "Security Exchange (SEC)" },
  { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_CARRIER_SURCHARGE", label: "Airline / Carrier Surcharge" },
  { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_HEAVY_WEIGHT", label: "Heavy Weight Surcharge" },
  { zone: "DESTINATION", presetKey: "AIR_DEST_THC", label: "Destination THC / Airport Handling" },
  { zone: "DESTINATION", presetKey: "AIR_DEST_IMPORT_CLEARANCE", label: "Import Customs Clearance" },
  { zone: "DESTINATION", presetKey: "AIR_DEST_LAST_MILE", label: "Last Mile Handling / Lift Gate" },
  { zone: "DESTINATION", presetKey: "AIR_DEST_STORAGE", label: "Storage 1 Free Day Charges" },
];
export const SEA_CHARGE_PRESETS: ChargePreset[] = [
  { zone: "ORIGIN", presetKey: "SEA_ORIGIN_EXPORT_CLEARANCE", label: "Export Customs Clearance" },
  { zone: "ORIGIN", presetKey: "SEA_ORIGIN_DOCUMENTATION", label: "Documentation Charges" },
  { zone: "ORIGIN", presetKey: "SEA_ORIGIN_THC", label: "Origin THC (Terminal Handling Charge)" },
  { zone: "ORIGIN", presetKey: "SEA_ORIGIN_BILL_OF_LADING", label: "Bill of Lading" },
  { zone: "ORIGIN", presetKey: "SEA_ORIGIN_WAREHOUSE", label: "Warehouse Charges" },
  { zone: "MAIN_FREIGHT", presetKey: "SEA_MAIN_FREIGHT", label: "Sea Freight Charges" },
  { zone: "DESTINATION", presetKey: "SEA_DEST_THC", label: "Destination THC / Handling Charges" },
  { zone: "DESTINATION", presetKey: "SEA_DEST_IMPORT_CLEARANCE", label: "Import Customs Clearance" },
  { zone: "DESTINATION", presetKey: "SEA_DEST_DELIVERY", label: "Delivery (Last Mile — Door to Door)" },
  { zone: "DESTINATION", presetKey: "SEA_DEST_LAST_MILE", label: "Last Mile Handling / Lift Gate" },
  { zone: "DESTINATION", presetKey: "SEA_DEST_STORAGE", label: "Storage 1 Free Day Charges" },
];
```

- [ ] **Step 4: Export from `packages/shared/src/index.ts`** — add `export * from "./quote";` (alongside the existing `export * from "./rfq";` etc.).

- [ ] **Step 5: Run — GREEN + build.**
```bash
pnpm --filter @svyft/shared test -- quote && pnpm --filter @svyft/shared build && pnpm --filter @svyft/shared lint
```

- [ ] **Step 6: Commit.**
```bash
git add packages/shared/src/quote.ts packages/shared/src/quote.test.ts packages/shared/src/index.ts
git commit -m "feat(quote): shared quote vocabulary — enums, QuoteDraft, charge presets"
```

---

## Task 2: Prisma pricing schema + additive migration

**Goal:** the four Prisma enums + five pricing tables + `Quote` pricing columns + back-relations, applied via one additive migration.

**Files:** Modify `prisma/schema.prisma`; Create `prisma/migrations/<ts>_add_quote_pricing/`; Test `apps/api/test/quote-pricing-schema.e2e-spec.ts`.

**Interfaces:**
- Produces: Prisma models `QuoteCargoLine`/`ChargeLine`/`TruckingCharge`/`WarehouseStagingLine`/`TransitPlan`; `Quote.totalChargeableWeightT`/`grandTotal`/`dgSurchargeNote`/`termsConditions` + the child back-relations; Prisma enums `ChargeZone`/`TruckingType`/`TruckingBasis`/`WarehousePosition`; `Point.truckingCharges`/`warehouseStagingLines` back-relations.

- [ ] **Step 1: Add the four Prisma enums** to `prisma/schema.prisma` (immediately after the `QuoteStatus` enum block, ~line 331):
```prisma
enum ChargeZone {
  ORIGIN
  MAIN_FREIGHT
  DESTINATION
}
enum TruckingType {
  DEDICATED
  GROUPAGE
}
enum TruckingBasis {
  PER_TRUCK
  PER_CBM
  PER_TON
  FIXED
}
enum WarehousePosition {
  ORIGIN
  DESTINATION
}
```

- [ ] **Step 2: Add the pricing columns + back-relations to `model Quote`** (before its `@@unique`/`@@index` block, after `updatedAt` at ~line 196):
```prisma
  totalChargeableWeightT Decimal? @db.Decimal(12, 3)
  grandTotal             Decimal? @db.Decimal(14, 2)
  dgSurchargeNote        String?
  termsConditions        String?

  quoteCargoLines       QuoteCargoLine[]
  chargeLines           ChargeLine[]
  truckingCharges       TruckingCharge[]
  warehouseStagingLines WarehouseStagingLine[]
  transitPlan           TransitPlan?
```

- [ ] **Step 3: Add the two `Point` back-relations** to `model Point` (after `destinationLegs` at ~line 465):
```prisma
  truckingCharges       TruckingCharge[]
  warehouseStagingLines WarehouseStagingLine[]
```

- [ ] **Step 4: Add the five tables** (anywhere after `model Quote`, e.g. after `RfqSequence` ~line 209):
```prisma
model QuoteCargoLine {
  id               String    @id @default(uuid()) @db.Uuid
  tenantId         String?   @db.Uuid
  quoteId          String    @db.Uuid
  quote            Quote     @relation(fields: [quoteId], references: [id], onDelete: Cascade)
  cargoItemId      String    @db.Uuid
  cargoItem        CargoItem @relation(fields: [cargoItemId], references: [id], onDelete: Restrict)
  freightDensity   Decimal   @db.Decimal(12, 3)
  chargeableWeightT Decimal  @db.Decimal(12, 3)
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  @@unique([quoteId, cargoItemId])
  @@index([quoteId])
  @@index([tenantId])
}

model ChargeLine {
  id        String     @id @default(uuid()) @db.Uuid
  tenantId  String?    @db.Uuid
  quoteId   String     @db.Uuid
  quote     Quote      @relation(fields: [quoteId], references: [id], onDelete: Cascade)
  zone      ChargeZone
  label     String
  isPreset  Boolean    @default(false)
  presetKey String?
  amount    Decimal    @db.Decimal(14, 2)
  note      String?
  sortOrder Int        @default(0)
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt

  @@index([quoteId])
  @@index([tenantId])
}

model TruckingCharge {
  id                 String        @id @default(uuid()) @db.Uuid
  tenantId           String?       @db.Uuid
  quoteId            String        @db.Uuid
  quote              Quote         @relation(fields: [quoteId], references: [id], onDelete: Cascade)
  legEndpointPointId String        @db.Uuid
  legEndpointPoint   Point         @relation(fields: [legEndpointPointId], references: [id], onDelete: Restrict)
  truckingType       TruckingType
  basis              TruckingBasis
  amount             Decimal       @db.Decimal(14, 2)
  remarks            String?
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt

  @@index([quoteId])
  @@index([tenantId])
}

model WarehouseStagingLine {
  id                   String            @id @default(uuid()) @db.Uuid
  tenantId             String?           @db.Uuid
  quoteId              String            @db.Uuid
  quote                Quote             @relation(fields: [quoteId], references: [id], onDelete: Cascade)
  warehousePointId     String            @db.Uuid
  warehousePoint       Point             @relation(fields: [warehousePointId], references: [id], onDelete: Restrict)
  position             WarehousePosition
  label                String
  isPreset             Boolean           @default(false)
  amount               Decimal           @db.Decimal(14, 2)
  note                 String?
  cargoAcceptanceWindow String?
  createdAt            DateTime          @default(now())
  updatedAt            DateTime          @updatedAt

  @@index([quoteId])
  @@index([tenantId])
}

model TransitPlan {
  id                   String   @id @default(uuid()) @db.Uuid
  tenantId             String?  @db.Uuid
  quoteId              String   @unique @db.Uuid
  quote                Quote    @relation(fields: [quoteId], references: [id], onDelete: Cascade)
  carrier              String?
  flightVoyageNo       String?
  departureDate        DateTime
  arrivalDate          DateTime
  carrierSurcharge     Decimal? @db.Decimal(14, 2)
  guaranteedTransitDays Int?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@index([tenantId])
}
```

- [ ] **Step 5: Generate the migration.**
```bash
pnpm exec prisma migrate dev --name add_quote_pricing
```
Expected: a new `prisma/migrations/<ts>_add_quote_pricing/migration.sql` creating the 4 enum types, 5 tables, the `Quote` columns, and the FKs. Prisma applies it + regenerates. **If it proposes a reset, STOP.**

- [ ] **Step 6: Write the smoke e2e** `apps/api/test/quote-pricing-schema.e2e-spec.ts` — boots `AppModule`, creates a query→leg→FF→quote fixture, inserts one row per pricing table (+ a `Point` for the trucking/warehouse FKs), reads them back, then cleans up (children first, then quote/leg/FF/query) and `await app.close()`. Assert e.g. `chargeableWeightT`, `zone: "ORIGIN"`, the `TransitPlan` 1:1. Mirror the harness of `apps/api/test/rfq-state.e2e-spec.ts` (self-contained fixtures, PFX-scoped cleanup).

- [ ] **Step 7: Run — GREEN + verify.**
```bash
pnpm exec prisma generate && pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api test -- quote-pricing-schema
```

- [ ] **Step 8: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations apps/api/test/quote-pricing-schema.e2e-spec.ts
git commit -m "chore(prisma): quote pricing tables + Quote pricing columns (SB4a)"
```

---

## Task 3: O-S4-3 — drop the vestigial Stage-3 density columns (+ ripple)

**Goal:** drop `CargoItem.freightDensity`/`chargeableWeight`, `Leg.totalChargeableWeight`, `LegCargo.manifestSnapshot` (all null in every Stage-3 row → non-destructive, §4.3.1); remove them from the shared DTOs + serializer + xlsx export + test mocks so typecheck/tests stay green.

**Files:** Modify `prisma/schema.prisma` (drop 4 cols) + migration; `packages/shared/src/cargo.ts`, `query.ts`; `apps/api/src/modules/cargo/cargo.service.ts`; the web test mocks the grep below lists.

- [ ] **Step 1: Delete the four columns** from `prisma/schema.prisma`: `CargoItem.freightDensity` (line ~428) + `CargoItem.chargeableWeight` (~429); `Leg.totalChargeableWeight` (~487); `LegCargo.manifestSnapshot` (~508). Leave `CargoItem.volumeCbm` (the generated column) and everything else intact.

- [ ] **Step 2: Generate the drop migration.**
```bash
pnpm exec prisma migrate dev --name drop_stage3_density_columns
```
Expected: `ALTER TABLE ... DROP COLUMN` for the four. Non-destructive (all null). **If it warns about data loss on non-null data, STOP** (would mean a column was populated — it should not be).

- [ ] **Step 3: Remove the fields from the shared DTOs.**
  - `packages/shared/src/cargo.ts`: delete `freightDensity: string | null;` + `chargeableWeight: string | null;` from `CargoDto` (lines ~76–77) and update the stale comment at ~line 13.
  - `packages/shared/src/query.ts`: delete `totalChargeableWeight: string | null;` from `QueryLegDto` (line ~341).
  - Rebuild: `pnpm --filter @svyft/shared build`.

- [ ] **Step 4: Fix the api serializer + export.** Run `git grep -nE 'freightDensity|chargeableWeight|totalChargeableWeight' -- apps/api/src` — if the query/cargo serializer spreads the Prisma row (`...rest`) the dropped fields vanish automatically; if it maps them explicitly, remove those lines. In `apps/api/src/modules/cargo/cargo.service.ts`, remove the two xlsx export columns (`{ header: "Freight Density", key: "freightDensity", ... }` + `{ header: "Chargeable Wt (T)", key: "chargeableWeight", ... }`, ~lines 168–169) and their `freightDensity: ""`/`chargeableWeight: ""` row values (~lines 188–189). Update the `cargo.impact.ts:5` comment if it names the dropped fields.

- [ ] **Step 5: Fix the web test mocks.** These specs set the dropped fields to `null` in `QueryDetail`/`CargoDto`/`QueryLegDto` mocks — remove those keys. Then `pnpm --filter @svyft/web typecheck` will flag any remaining excess property; delete exactly what it names. Files (from `git grep`):
  `apps/web/src/features/query-wizard/`: `QueryWizard.e2e.test.tsx`, `QueryWizardPage.test.tsx`, `WizardShell.test.tsx`, `steps/Step3Cargo.test.tsx`, `steps/cargo/useCargo.test.ts`, `steps/legs/CargoAssignmentControl.test.tsx`, `steps/legs/LegEditor.test.tsx`, `steps/legs/LegsStep.test.tsx`, `steps/legs/PointEditor.test.tsx`, `steps/legs/RouteDiagram.test.tsx`, `steps/legs/routeGraph.test.ts` (+ any the typecheck surfaces).

- [ ] **Step 6: Verify green across the ripple.**
```bash
pnpm --filter @svyft/shared build
pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint
pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web test
```
Expected: all pass (the dropped fields are gone with no remaining references).

- [ ] **Step 7: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations packages/shared apps/api apps/web
git commit -m "chore(prisma): drop vestigial Stage-3 density columns (O-S4-3) + ripple"
```

---

## Task 4: `computeChargeableWeight`

**Goal:** the pure per-row chargeable-weight function.

**Files:** Create `packages/shared/src/quote-engine.ts`, `packages/shared/src/quote-engine.test.ts`; Modify `packages/shared/src/index.ts`.

**Interfaces:** Produces `computeChargeableWeight(grossWtT: number, cbm: number, densityKgPerCbm: number): number`.

- [ ] **Step 1: Write the failing test** `quote-engine.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeChargeableWeight } from "./quote-engine";

describe("computeChargeableWeight", () => {
  it("returns the gross weight when it exceeds the volumetric weight", () => {
    // 2 T gross, 1 m³ × 167 kg/CBM = 0.167 T volumetric ⇒ gross wins
    expect(computeChargeableWeight(2, 1, 167)).toBe(2);
  });
  it("returns the volumetric weight when it exceeds gross (Air 167)", () => {
    // 0.1 T gross, 5 m³ × 167 / 1000 = 0.835 T volumetric ⇒ volumetric wins
    expect(computeChargeableWeight(0.1, 5, 167)).toBeCloseTo(0.835, 6);
  });
  it("uses the mode density (Sea 1000 kg/CBM)", () => {
    expect(computeChargeableWeight(0.5, 2, 1000)).toBe(2); // 2×1000/1000 = 2 T
  });
});
```

- [ ] **Step 2: Run — RED** (`pnpm --filter @svyft/shared test -- quote-engine`).

- [ ] **Step 3: Create `quote-engine.ts`:**
```ts
/** Chargeable weight (tonnes) = max(actual gross T, volumetric T). Volumetric = cbm(m³) × density(kg/CBM) / 1000. */
export function computeChargeableWeight(grossWtT: number, cbm: number, densityKgPerCbm: number): number {
  const volumetricT = (cbm * densityKgPerCbm) / 1000;
  return Math.max(grossWtT, volumetricT);
}
```

- [ ] **Step 4: Export** — add `export * from "./quote-engine";` to `packages/shared/src/index.ts`.

- [ ] **Step 5: GREEN + build + commit.**
```bash
pnpm --filter @svyft/shared test -- quote-engine && pnpm --filter @svyft/shared build && pnpm --filter @svyft/shared lint
git add packages/shared/src/quote-engine.ts packages/shared/src/quote-engine.test.ts packages/shared/src/index.ts
git commit -m "feat(quote): computeChargeableWeight engine fn"
```

---

## Task 5: `computeQuoteTotals`

**Goal:** zone/trucking/warehouse subtotals + total chargeable weight + grand total over a `QuoteDraft`.

**Files:** Modify `packages/shared/src/quote-engine.ts`, `quote-engine.test.ts`.

**Interfaces:**
- Consumes: `QuoteDraft` (Task 1), `computeChargeableWeight` (Task 4).
- Produces: `computeQuoteTotals(draft: QuoteDraft): QuoteTotals` where `QuoteTotals = { zoneSubtotals: { origin: number; mainFreight: number; destination: number }; truckingSubtotal: number; warehouseSubtotal: number; totalChargeableWeightT: number; grandTotal: number }`.

- [ ] **Step 1: Write the failing test** (append to `quote-engine.test.ts`):
```ts
import { computeQuoteTotals } from "./quote-engine";
import type { QuoteDraft } from "./quote";

const base: QuoteDraft = {
  legId: "l1", mode: "AIR", currency: "USD", quoteValidityUntil: null,
  cargo: [{ cargoItemId: "c1", grossWtT: 0.1, cbm: 5, isDangerous: false, freightDensity: 167 }],
  charges: [
    { zone: "ORIGIN", presetKey: "AIR_ORIGIN_THC", label: "Origin THC", amount: 100 },
    { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_FREIGHT", label: "Air Freight", amount: 500 },
    { zone: "DESTINATION", presetKey: "AIR_DEST_THC", label: "Dest THC", amount: 50 },
  ],
  trucking: [], warehouse: [], transit: null, dgSurchargeNote: null, termsConditions: null,
};

describe("computeQuoteTotals", () => {
  it("sums zone subtotals, total chargeable weight, and grand total (Air)", () => {
    const t = computeQuoteTotals(base);
    expect(t.zoneSubtotals).toEqual({ origin: 100, mainFreight: 500, destination: 50 });
    expect(t.totalChargeableWeightT).toBeCloseTo(0.835, 6); // 5×167/1000
    expect(t.grandTotal).toBe(650);
  });
  it("adds trucking + warehouse into the grand total (Road-only) and treats null amounts as 0", () => {
    const road: QuoteDraft = { ...base, mode: "ROAD", charges: [],
      cargo: [{ cargoItemId: "c1", grossWtT: 1, cbm: 1, isDangerous: false, freightDensity: null }],
      trucking: [{ legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: 300 }],
      warehouse: [{ warehousePointId: "w1", position: "ORIGIN", label: "Warehousing (In/Out)", amount: null }] };
    const t = computeQuoteTotals(road);
    expect(t.truckingSubtotal).toBe(300);
    expect(t.warehouseSubtotal).toBe(0);       // null amount → 0
    expect(t.totalChargeableWeightT).toBe(0);  // null density → 0 (not yet priced)
    expect(t.grandTotal).toBe(300);
  });
});
```

- [ ] **Step 2: Run — RED.**

- [ ] **Step 3: Implement** (append to `quote-engine.ts`):
```ts
import type { QuoteDraft } from "./quote";

export interface QuoteTotals {
  zoneSubtotals: { origin: number; mainFreight: number; destination: number };
  truckingSubtotal: number;
  warehouseSubtotal: number;
  totalChargeableWeightT: number;
  grandTotal: number;
}

export function computeQuoteTotals(draft: QuoteDraft): QuoteTotals {
  const zoneSubtotals = { origin: 0, mainFreight: 0, destination: 0 };
  for (const c of draft.charges) {
    const amt = c.amount ?? 0;
    if (c.zone === "ORIGIN") zoneSubtotals.origin += amt;
    else if (c.zone === "MAIN_FREIGHT") zoneSubtotals.mainFreight += amt;
    else zoneSubtotals.destination += amt;
  }
  const truckingSubtotal = draft.trucking.reduce((s, t) => s + (t.amount ?? 0), 0);
  const warehouseSubtotal = draft.warehouse.reduce((s, w) => s + (w.amount ?? 0), 0);
  const totalChargeableWeightT = draft.cargo.reduce(
    (s, c) => s + (c.freightDensity != null ? computeChargeableWeight(c.grossWtT, c.cbm, c.freightDensity) : 0),
    0,
  );
  const grandTotal =
    zoneSubtotals.origin + zoneSubtotals.mainFreight + zoneSubtotals.destination + truckingSubtotal + warehouseSubtotal;
  return { zoneSubtotals, truckingSubtotal, warehouseSubtotal, totalChargeableWeightT, grandTotal };
}
```
> `grandTotal` sums every line once (each line lives in exactly one bucket), so it is correct regardless of how §7.4.6 groups warehouse staging for display — that grouping is a 4c presentation concern.

- [ ] **Step 4: GREEN + build + commit** (`feat(quote): computeQuoteTotals engine fn`).

---

## Task 6: `validateQuote` — spec §10.4 Q1–Q8

**Goal:** the authoritative submit-validation, emitting `Finding[]` for each unmet rule.

**Files:** Modify `packages/shared/src/quote-engine.ts`, `quote-engine.test.ts`.

**Interfaces:**
- Consumes: `QuoteDraft`, `AIR_CHARGE_PRESETS`/`SEA_CHARGE_PRESETS` (Task 1), `Finding` (`./findings`).
- Produces: `validateQuote(draft: QuoteDraft, deadlineIso: string, nowIso: string): Finding[]`.

- [ ] **Step 1: Write the failing test** (append). Cover a fully-valid Air draft → `[]`, and each rule firing:
```ts
import { validateQuote } from "./quote-engine";
import { AIR_CHARGE_PRESETS } from "./quote";

const deadline = "2026-08-10T00:00:00.000Z";
const now = "2026-08-01T00:00:00.000Z";
function validAir(): QuoteDraft {
  return {
    legId: "l1", mode: "AIR", currency: "USD", quoteValidityUntil: "2026-08-20T00:00:00.000Z",
    cargo: [{ cargoItemId: "c1", grossWtT: 1, cbm: 2, isDangerous: false, freightDensity: 167 }],
    charges: AIR_CHARGE_PRESETS.map((p) => ({ zone: p.zone, presetKey: p.presetKey, label: p.label, amount: 10 })),
    trucking: [], warehouse: [],
    transit: { departureDate: "2026-08-12T00:00:00.000Z", arrivalDate: "2026-08-14T00:00:00.000Z" },
    dgSurchargeNote: null, termsConditions: null,
  };
}

describe("validateQuote (§10.4 Q1–Q8)", () => {
  it("passes a complete Air quote", () => {
    expect(validateQuote(validAir(), deadline, now)).toEqual([]);
  });
  it("Q1: flags an unpriced mandatory Air line", () => {
    const d = validAir(); d.charges = d.charges.filter((c) => c.presetKey !== "AIR_MAIN_FREIGHT");
    expect(validateQuote(d, deadline, now).some((f) => f.rule === "Q1")).toBe(true);
  });
  it("Q2: flags a cargo row missing density", () => {
    const d = validAir(); d.cargo[0].freightDensity = null;
    const f = validateQuote(d, deadline, now).find((x) => x.rule === "Q2");
    expect(f?.scope).toEqual({ type: "cargo", id: "c1" });
  });
  it("Q3: validity before the deadline", () => {
    const d = validAir(); d.quoteValidityUntil = "2026-08-05T00:00:00.000Z";
    expect(validateQuote(d, deadline, now).some((f) => f.rule === "Q3")).toBe(true);
  });
  it("Q4/Q5/Q6/Q7: currency, DG note, transit dates, past-deadline", () => {
    const d = validAir(); d.currency = null; d.cargo[0].isDangerous = true; d.transit = null;
    const rules = validateQuote(d, deadline, "2026-08-11T00:00:00.000Z").map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["Q4", "Q5", "Q6", "Q7"]));
  });
  it("Q8: flags an unpriced warehouse line", () => {
    const d = validAir();
    d.warehouse = [{ warehousePointId: "w1", position: "ORIGIN", label: "Warehousing (In/Out)", amount: null }];
    expect(validateQuote(d, deadline, now).some((f) => f.rule === "Q8")).toBe(true);
  });
  it("Q1 (Road): flags an unpriced trucking block", () => {
    const d = validAir(); d.mode = "ROAD"; d.charges = [];
    d.trucking = [{ legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "FIXED", amount: null }];
    expect(validateQuote(d, deadline, now).some((f) => f.rule === "Q1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run — RED.**

- [ ] **Step 3: Implement** (append to `quote-engine.ts`):
```ts
import type { Finding } from "./findings";
import { AIR_CHARGE_PRESETS, SEA_CHARGE_PRESETS } from "./quote";

export function validateQuote(draft: QuoteDraft, deadlineIso: string, nowIso: string): Finding[] {
  const f: Finding[] = [];
  const blk = (rule: string, message: string, scope: Finding["scope"]): Finding => ({ rule, severity: "blocking", scope, message });
  const leg = { type: "leg", id: draft.legId } as const;

  // Q7 — submission not past the deadline
  if (new Date(nowIso).getTime() > new Date(deadlineIso).getTime())
    f.push(blk("Q7", "The submission deadline has passed", leg));

  // Q1 — mandatory charge lines per mode
  if (draft.mode === "AIR" || draft.mode === "SEA") {
    const presets = draft.mode === "AIR" ? AIR_CHARGE_PRESETS : SEA_CHARGE_PRESETS;
    const priced = new Set(draft.charges.filter((c) => c.amount != null).map((c) => c.presetKey));
    for (const p of presets)
      if (!priced.has(p.presetKey)) f.push(blk("Q1", `Charge line "${p.label}" must be priced`, leg));
  } else if (draft.mode === "ROAD") {
    for (const t of draft.trucking)
      if (t.amount == null) f.push(blk("Q1", "A trucking charge is required for every pickup/drop block", leg));
  }

  // Q8 — warehousing in/out priced for every warehouse endpoint
  for (const w of draft.warehouse)
    if (w.amount == null) f.push(blk("Q8", `Warehousing (In/Out) must be priced for ${w.label}`, leg));

  // Q2 — density on every cargo row
  for (const c of draft.cargo)
    if (c.freightDensity == null) f.push(blk("Q2", "Freight density is required for every cargo row", { type: "cargo", id: c.cargoItemId }));

  // Q3 — validity present + ≥ deadline
  if (!draft.quoteValidityUntil) f.push(blk("Q3", "Quote Validity Until is required", { type: "field", id: "quoteValidityUntil" }));
  else if (new Date(draft.quoteValidityUntil).getTime() < new Date(deadlineIso).getTime())
    f.push(blk("Q3", "Quote Validity Until must be on or after the submission deadline", { type: "field", id: "quoteValidityUntil" }));

  // Q4 — currency
  if (!draft.currency) f.push(blk("Q4", "Currency is required", { type: "field", id: "currency" }));

  // Q5 — DG surcharge note when any assigned row is DG
  if (draft.cargo.some((c) => c.isDangerous) && !draft.dgSurchargeNote?.trim())
    f.push(blk("Q5", "A DG Surcharge Note is required when the shipment includes dangerous goods", { type: "field", id: "dgSurchargeNote" }));

  // Q6 — transit departure + arrival
  if (!draft.transit?.departureDate) f.push(blk("Q6", "Transit Plan departure date is required", { type: "field", id: "departureDate" }));
  if (!draft.transit?.arrivalDate) f.push(blk("Q6", "Transit Plan arrival date is required", { type: "field", id: "arrivalDate" }));

  return f;
}
```

- [ ] **Step 4: GREEN + build + commit** (`feat(quote): validateQuote — §10.4 Q1–Q8`).

---

## Task 7: `classifyWarehousePositions` — §6.4 origin/destination inference

**Goal:** classify each warehouse endpoint as `ORIGIN` or `DESTINATION` staging by its position in the FF's assigned-leg chain relative to the main (Air/Sea) carriage — the label + roll-up driver (§7.4.3.3, §7.4.6). Pure; reuses the `route.ts` chain primitives conceptually.

**Files:** Modify `packages/shared/src/quote-engine.ts`, `quote-engine.test.ts`.

**Interfaces:**
- Consumes: `FreightMode` (`./config`), `WarehousePosition` (`./quote`).
- Produces: `classifyWarehousePositions(legs: WhLeg[], warehousePointIds: string[]): Record<string, WarehousePosition>` where `WhLeg = { originPointId: string | null; destinationPointId: string | null; mode: FreightMode | null }`.

**Algorithm:** order the FF's legs into a point sequence by walking the edges from the source (a point that is only ever an origin) to the sink; the **pivot** = the index of the first `AIR`/`SEA` leg's origin point (the main carriage start), or the sequence midpoint when the FF has no main carriage (Road-only). A warehouse point at sequence index `< pivot` ⇒ `ORIGIN`, else `DESTINATION`. Non-contiguous assignments (disjoint segments) are ordered per segment; a warehouse not reachable in any ordered segment defaults to `ORIGIN`.

- [ ] **Step 1: Write the failing test** (append):
```ts
import { classifyWarehousePositions } from "./quote-engine";

describe("classifyWarehousePositions (§6.4)", () => {
  it("labels warehouses before/after the main air carriage", () => {
    // WH(w1) → OriginAirport(a1) --AIR--> DestAirport(a2) → WH(w2)
    const legs = [
      { originPointId: "w1", destinationPointId: "a1", mode: "ROAD" as const },
      { originPointId: "a1", destinationPointId: "a2", mode: "AIR" as const },
      { originPointId: "a2", destinationPointId: "w2", mode: "ROAD" as const },
    ];
    expect(classifyWarehousePositions(legs, ["w1", "w2"])).toEqual({ w1: "ORIGIN", w2: "DESTINATION" });
  });
  it("Road-only: splits warehouses by the chain midpoint", () => {
    const legs = [
      { originPointId: "w1", destinationPointId: "m", mode: "ROAD" as const },
      { originPointId: "m", destinationPointId: "w2", mode: "ROAD" as const },
    ];
    expect(classifyWarehousePositions(legs, ["w1", "w2"])).toEqual({ w1: "ORIGIN", w2: "DESTINATION" });
  });
});
```

- [ ] **Step 2: Run — RED.**

- [ ] **Step 3: Implement** (append to `quote-engine.ts`):
```ts
import type { FreightMode } from "./config";
import { WarehousePosition } from "./quote";

export interface WhLeg { originPointId: string | null; destinationPointId: string | null; mode: FreightMode | null; }

/** Order the leg edges into a single point sequence (source→sink); returns [] if no orderable chain. */
function orderPointSequence(legs: WhLeg[]): string[] {
  const edges = legs.filter((l): l is WhLeg & { originPointId: string; destinationPointId: string } =>
    !!l.originPointId && !!l.destinationPointId);
  if (edges.length === 0) return [];
  const next = new Map<string, string>();
  const indeg = new Map<string, number>();
  const nodes = new Set<string>();
  for (const e of edges) {
    next.set(e.originPointId, e.destinationPointId);
    indeg.set(e.destinationPointId, (indeg.get(e.destinationPointId) ?? 0) + 1);
    nodes.add(e.originPointId); nodes.add(e.destinationPointId);
  }
  const source = [...nodes].find((n) => (indeg.get(n) ?? 0) === 0);
  if (!source) return []; // cyclic / non-orderable
  const seq: string[] = [source];
  const seen = new Set<string>([source]);
  let cur = source;
  while (next.has(cur)) {
    const nxt = next.get(cur)!;
    if (seen.has(nxt)) break;
    seq.push(nxt); seen.add(nxt); cur = nxt;
  }
  return seq;
}

export function classifyWarehousePositions(legs: WhLeg[], warehousePointIds: string[]): Record<string, WarehousePosition> {
  const seq = orderPointSequence(legs);
  const idxOf = new Map(seq.map((p, i) => [p, i] as const));
  const mainLeg = legs.find((l) => l.mode === "AIR" || l.mode === "SEA");
  const pivot =
    mainLeg && mainLeg.originPointId != null && idxOf.has(mainLeg.originPointId)
      ? idxOf.get(mainLeg.originPointId)!
      : Math.floor(seq.length / 2);
  const out: Record<string, WarehousePosition> = {};
  for (const w of warehousePointIds) {
    const i = idxOf.get(w);
    out[w] = i != null && i < pivot ? WarehousePosition.ORIGIN : WarehousePosition.DESTINATION;
  }
  return out;
}
```
> Reuses the same source/sink chain-walk shape as `route.ts` (indeg-0 source, single forward walk). Non-contiguous/broken chains degrade gracefully (unreachable warehouses → `DESTINATION` unless before the pivot); SB4b/4c refine display if a richer segmentation is needed — flagged, not silently assumed.

- [ ] **Step 4: GREEN + build + commit** (`feat(quote): classifyWarehousePositions — §6.4 warehouse inference`).

---

## Task 8: Final verification + barrel exports

**Goal:** confirm the whole 4a surface is exported + every package green together.

- [ ] **Step 1: Confirm exports.** `packages/shared/src/index.ts` has `export * from "./quote";` + `export * from "./quote-engine";`. Grep that all new public symbols resolve: `node -e "const s=require('./packages/shared/dist/index.js'); ['ChargeZone','TruckingType','TruckingBasis','WarehousePosition','AIR_CHARGE_PRESETS','SEA_CHARGE_PRESETS','computeChargeableWeight','computeQuoteTotals','validateQuote','classifyWarehousePositions'].forEach(k=>{ if(!(k in s)) throw new Error('missing '+k) }); console.log('ok')"` (after a shared build).

- [ ] **Step 2: Full matrix.**
```bash
pnpm --filter @svyft/shared build
pnpm --filter @svyft/shared test && pnpm --filter @svyft/shared lint
pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint && pnpm --filter @svyft/api test -- quote-pricing-schema rfq
pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web test
```
Expected: all green; api jest exits.

- [ ] **Step 3: Commit any barrel fix** (`chore(quote): barrel exports + final 4a verification`), then this is ready for the **opus whole-branch review** + PR `feat/stage-4-sb4a` → `main`.

---

## Self-Review

**Spec coverage:** §4.2 tables → Task 2; §4.3.1 / O-S4-3 drop → Task 3; §6.1 `computeChargeableWeight` → Task 4, `computeQuoteTotals` → Task 5; §10.4 Q1–Q8 `validateQuote` → Task 6; §6.4 warehouse inference → Task 7; enums + `QuoteDraft` + presets (§7.4.3.1/.2) → Task 1. Density factors: **not re-added** (existing `FreightDensityFactor`; engine takes density as a param). Deferred (documented): PDF, route diagram, FF Preview; and SB4b/4c own the guard, endpoints, seeding, and UI.

**Placeholder scan:** every code step ships real code; no TBD/"handle edge cases". The Task-3 web-mock list is explicit (from `git grep`) with a typecheck backstop.

**Type consistency:** `QuoteDraft`/`QuoteTotals`/`WhLeg`/`ChargePreset` and the enum names (`ChargeZone`/`TruckingType`/`TruckingBasis`/`WarehousePosition`) are used identically across Tasks 1/5/6/7; `computeChargeableWeight(grossWtT, cbm, densityKgPerCbm)` matches its consumer in `computeQuoteTotals`; the `Finding` shape (`rule`/`severity`/`scope`/`message`) matches `@svyft/shared` `findings.ts`; Prisma table/column names match the design doc + the `Quote`/`Point` back-relations added in Task 2.
