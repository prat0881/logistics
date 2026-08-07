# FF Portal v3 — Per-variant quoting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the FF portal quote to a per-variant model — a charge matrix (headers × Dedicated/Groupage / FCL/LCL / Air columns), one leg-level informational chargeable weight, per-variant guaranteed-transit-days, shared warehouse — plus 5 UX/bug fixes (route order, notes, layout, alignment, preview-empty).

**Architecture:** Domain-first. `@svyft/shared` holds the model (`QuoteDraft`), engine (`computeQuoteTotals` per-column), and submit-gate (`validateQuote` v3); a Prisma migration adds the per-variant columns; `apps/api` freezes/materializes/validates; `apps/web` renders the matrix + merged table + fixes. Lands on `feat/stage-3-cargo-packing-list` (PR #51), before the go-live cutover.

**Tech Stack:** pnpm monorepo · NestJS + Prisma/Postgres (api) · React/Vite + shadcn/Radix + react-hook-form + Zod + TanStack Query (web) · Vitest (shared/web) · Jest e2e (api). Spec: `docs/superpowers/specs/2026-08-07-ff-portal-v3-per-variant-quoting-design.md`.

## Global Constraints

- **Branch `feat/stage-3-cargo-packing-list` (PR #51).** 🔴 GIT PROTOCOL: implementers **NEVER touch git** (no add/commit/stash/status). The **controller commits**: start every commit with `git checkout feat/stage-3-cargo-packing-list`, `git add <specific files>`, commit, verify parent == prior tip. **Never stage `CLAUDE.md` / `docs/README.md`** (untracked artifacts — leave them).
- After any `packages/shared` edit: `pnpm --filter @svyft/shared build` (consumers read `dist`).
- Migrations: **hand-authored** `prisma/migrations/<ts>_<name>/migration.sql` + `pnpm --filter @svyft/api exec prisma migrate deploy --schema ../../prisma/schema.prisma` + `prisma generate`. **Never `migrate dev`; never `prisma format`.** DB = container `svyft-postgres-task4` on `:5433`; export env `set -a; . apps/api/.env; set +a`.
- api e2e run via the standard `pnpm --filter @svyft/api test -- <spec>` (tree compiles). vitest/jest don't type-check → run `tsc`/typecheck per task.
- **The gate is `pnpm run ci`** (lint + typecheck + test + build, all workspaces) GREEN. web build's 807 KB-chunk advisory is not a failure.
- **Design decisions (spec §2):** D1 charges per-variant (full columns); D2 chargeable weight one-per-leg, informational (not summed); D3 transit-days per variant; D4 warehouse shared; D5 land in PR #51. Air = 1 column; Road/Sea = 2 columns. Freight-rate row source: Road ← `trucking`, Sea ← `seaRates`, Air ← `AIR_MAIN_FREIGHT` charge.

---

## Unit 1 — shared quote-layer v3 (model + engine + submit-gate)

### Task 1: `@svyft/shared` per-variant model, engine, submit-gate

**Files:**

- Modify: `packages/shared/src/quote.ts` (QuoteDraft shapes)
- Modify: `packages/shared/src/quote-engine.ts` (`computeQuoteTotals`, `validateQuote`)
- Modify: `packages/shared/src/ff-portal.ts` (`quoteDraftSchema` — the Zod mirror)
- Test: `packages/shared/src/quote-engine.test.ts`, `packages/shared/src/quote.test.ts`, `packages/shared/src/ff-portal.test.ts`

**Interfaces (Produces — later tasks rely on these exact shapes):**

- `QuoteDraft` loses `QuoteDraftCargo.chargedWeightKg`; gains `chargedWeightKg: number | null` (leg-level) and `notes: string | null`.
- `QuoteDraftCharge` gains `rateVariant: ChargeRateVariant | null`.
- `QuoteDraftTransit.guaranteedTransitDays` → `guaranteedTransitDaysByVariant: Partial<Record<ChargeRateVariant, number>>`.
- `computeQuoteTotals(draft): QuoteTotals` — `variants[].grandTotal = Σ(charges where rateVariant===v via effectiveChargeAmount) + variantRate(v) + Σ warehouse`. `chargeableWeightKg = draft.chargedWeightKg ?? 0`.
- `validateQuote(draft, deadlineIso, nowIso, activeLines): Finding[]` — v3 rules (below).
- `variantsForMode(mode): ChargeRateVariant[] | ["AIR"-sentinel]` helper (Road→[DEDICATED,GROUPAGE], Sea→[FCL,LCL], Air→single). Define an `AIR` sentinel or model Air as `rateVariant: null` (pick: **Air uses `rateVariant: null`**; `variantsForMode("AIR") = [null]`). Export it.

- [ ] **Step 1 — failing engine test.** In `quote-engine.test.ts`, add: a ROAD draft with charges `[{definitionKey:"X",rateVariant:"DEDICATED",amount:100},{...rateVariant:"GROUPAGE",amount:120}]`, `trucking:[{rateVariant:"DEDICATED",amount:500},{rateVariant:"GROUPAGE",amount:400}]`, `warehouse:[{amount:50}]`, `chargedWeightKg:900`. Assert `computeQuoteTotals` → variants `DEDICATED.grandTotal===650` (100+500+50), `GROUPAGE.grandTotal===570` (120+400+50), `chargeableWeightKg===900`. Add an AIR draft (rateVariant null, `AIR_MAIN_FREIGHT` in charges) → single variant grandTotal = Σ charges + warehouse.
- [ ] **Step 2 — run, expect fail** (`pnpm --filter @svyft/shared test -- quote-engine`) — shape/field errors.
- [ ] **Step 3 — implement model** (`quote.ts`): apply the interface changes above; remove dead `AIR_CHARGE_PRESETS`/`SEA_CHARGE_PRESETS`/`ChargePreset`; add `variantsForMode`.
- [ ] **Step 4 — implement engine** (`quote-engine.ts`): rewrite `computeQuoteTotals` to per-column sums (charges grouped by `rateVariant`; Road adds `trucking` rate per variant, Sea adds `seaRates` per variant, Air single). `effectiveChargeAmount` unchanged, applied per charge. `chargeableWeightKg = draft.chargedWeightKg ?? 0`.
- [ ] **Step 5 — submit-gate v3** (`validateQuote`): **Q_WEIGHT** `draft.chargedWeightKg == null` → one leg finding (scope `{type:"field",id:"chargedWeightKg"}`). **Q_RATE** no variant has any priced charge → leg finding. For each **priced variant** (has ≥1 amount): **Q_PRICED** every applicable active line for that variant lacks an amount → per-line finding; **Q_TRANSIT** `guaranteedTransitDaysByVariant[v] == null` → finding scope `{type:"field",id:"guaranteedTransitDays"}` (keep the `findingNav` routing working). Currency/validity/custom-remark rules unchanged.
- [ ] **Step 6 — sync Zod** (`ff-portal.ts` `quoteDraftSchema`) to the new shapes; update `ff-portal.test.ts` fixture. Update `quote.test.ts` for the new `QuoteDraft` shape.
- [ ] **Step 7 — run green + typecheck.** `pnpm --filter @svyft/shared build && pnpm --filter @svyft/shared typecheck && pnpm --filter @svyft/shared test`. Report files + suggested commit `feat(shared): FF quote v3 — per-variant engine + submit-gate`.

---

## Unit 2 — Prisma migration

### Task 2: per-variant schema migration (applied to :5433)

**Files:**

- Modify: `prisma/schema.prisma` (Quote, QuoteCargoLine, ChargeLine, TransitPlan)
- Create: `prisma/migrations/20260807000000_ff_portal_v3/migration.sql`
- Test: `apps/api/test/ff-portal-v3-model.e2e-spec.ts`

**Interfaces (Produces):** `Quote.chargedWeightKg Decimal(12,3)?`, `Quote.notes String?`; `QuoteCargoLine` **drops** `chargedWeightKg`; `ChargeLine.rateVariant ChargeRateVariant?`; `TransitPlan.rateVariant ChargeRateVariant?` (+ its `@@unique`/index adjusted to allow one row per (leg-scope, rateVariant)).

- [ ] **Step 1 — pre-flight**: `set -a; . apps/api/.env; set +a`; confirm row counts (Quote/QuoteCargoLine/ChargeLine/TransitPlan) on :5433 (expected 0 or disposable). Record.
- [ ] **Step 2 — edit `schema.prisma`** with the interface changes; `ChargeRateVariant` enum already exists.
- [ ] **Step 3 — hand-author `migration.sql`**: `ALTER TABLE "Quote" ADD COLUMN "chargedWeightKg" DECIMAL(12,3), ADD COLUMN "notes" TEXT;` · `ALTER TABLE "QuoteCargoLine" DROP COLUMN "chargedWeightKg";` · `ALTER TABLE "ChargeLine" ADD COLUMN "rateVariant" "ChargeRateVariant";` · `ALTER TABLE "TransitPlan" ADD COLUMN "rateVariant" "ChargeRateVariant";` (+ drop/replace the old TransitPlan unique-on-leg constraint with one keyed to include `rateVariant`; verify the exact constraint name via `\d "TransitPlan"`).
- [ ] **Step 4 — apply**: `pnpm --filter @svyft/api exec prisma migrate deploy --schema ../../prisma/schema.prisma` + `prisma generate`. Verify columns via container `psql`.
- [ ] **Step 5 — model e2e**: assert the columns/enum/constraints exist (mirror `ff-portal-v2-model.e2e-spec.ts`). Run via the standard api test runner.
- [ ] **Step 6** — report files + `feat(db): FF portal v3 per-variant schema`.

---

## Unit 3 — API v3 wiring

### Task 3: `ff-portal.service` v3 — resolveScope seeding + submit materialize + gate

**Files:**

- Modify: `apps/api/src/modules/ff-portal/ff-portal.service.ts`
- Test: `apps/api/test/ff-portal-v3.e2e-spec.ts` (new); keep `ff-portal-grain.e2e-spec.ts` green

**Interfaces (Consumes):** Task-1 `QuoteDraft`/`computeQuoteTotals`/`validateQuote`/`variantsForMode`; Task-2 schema.

- [ ] **Step 1 — failing e2e**: distribute a ROAD leg (charge-config with ≥1 line), FF saves a draft pricing BOTH variants' charges + a per-variant transit-days + a leg `chargedWeightKg` + `notes`, submits → assert: one `Quote.chargedWeightKg`, per-variant `ChargeLine` rows (`rateVariant` set), per-variant `TransitPlan` rows, `Quote.notes`, `grandTotal` = max variant column, `QuoteCargoLine` has NO chargedWeightKg. Add a gate test (submit missing one priced variant's transit-days → 422 Q_TRANSIT; missing leg weight → 422 Q_WEIGHT).
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — resolveScope**: seed `charges` as the matrix (each active line × `variantsForMode(mode)` → one `QuoteDraftCharge` per (line, variant), amount null; Air → rateVariant null). Seed `chargedWeightKg: null` (leg), `transit.guaranteedTransitDaysByVariant: {}`, `notes: null`. Keep the existing masking/manifest untouched.
- [ ] **Step 4 — submit materialize**: write `Quote.chargedWeightKg` (leg) + `Quote.notes`; `ChargeLine.createMany` with `rateVariant`; one `TransitPlan` per priced variant with its days; `grandTotal = max(variants.grandTotal)`. Keep the stale-charge drop-filter + `assertApplied`. Run `validateQuote` v3 before materialize.
- [ ] **Step 5 — run green** (`pnpm --filter @svyft/api test -- ff-portal`) + `pnpm --filter @svyft/api typecheck` + `pnpm --filter @svyft/api build` (nest). Report + `feat(api): FF portal v3 per-variant submit + seeding`.

> Note: `buildChargeConfigSnapshot`/`rfq.service`/`change-order.strategy` need no signature change (the snapshot is still the per-leg line set; variants are derived from mode at seed/submit). Confirm both callers still compile.

---

## Unit 4 — Web (matrix + merged table + fixes)

### Task 4: merged Cargo + Chargeable-Weight table (#2)

**Files:** Create `apps/web/src/features/ff-portal/CargoWeightTable.tsx` (+ test); modify `LegSection.tsx` (mount it, drop `CargoManifestTable`+`ChargedWeightGrid` usage); modify `draftFromDto.ts` (seed leg `chargedWeightKg`, drop per-package). Remove/retire `ChargedWeightGrid.tsx` + its test; keep `CargoManifestTable` only if still referenced elsewhere (else remove).
**Interfaces (Consumes):** Task-1 `QuoteDraft.chargedWeightKg`. **Produces:** `<CargoWeightTable manifest={ManifestSnapshotCargo[]} />` reading `chargedWeightKg` via RHF.

- [ ] Step 1 — failing test: renders per-package rows + a Totals row (Σ gross, Σ CBM) + one "Chargeable Weight (kg)" input bound to `chargedWeightKg`; no per-package charged-wt column.
- [ ] Step 2 — run fail. Step 3 — implement (per-package read-only rows from `manifest`; totals via `reduce`; one `NumberField` → `setValue("chargedWeightKg", …)`). Step 4 — run pass.
- [ ] Step 5 — `draftFromDto`: seed `chargedWeightKg` (leg), remove per-package `chargedWeightKg`. Update its test. Step 6 — report + `feat(ff-portal): merged cargo + chargeable-weight table`.

### Task 5: per-variant charge matrix (#3, #6)

**Files:** Create `apps/web/src/features/ff-portal/ChargeMatrix.tsx` (+ test); modify `LegSection.tsx` to render it; retire/refactor `ChargeZonePanel.tsx`/`TruckingBlocks.tsx`/`SeaChargesPanel.tsx` into the matrix (or its cell renderers — keep `HeavyWeightCalcRow` for the calc cell).
**Interfaces (Consumes):** Task-1 model + `variantsForMode`, `rateVariantLabel`; `computeQuoteTotals` for per-column totals. **Produces:** `<ChargeMatrix seededCharges={…} mode={…} />`.

- [ ] Step 1 — failing test: for a ROAD leg with 2 seeded lines, renders columns [header, Dedicated, Groupage]; entering an amount in a cell updates that `(line, variant)` charge; a non-applicable cell is greyed/disabled; each column shows a grand total = its column sum aligned under the column. Air → single column. Sea → FCL/LCL (container on FCL, B/L on the SEA_ORIGIN_BILL_OF_LADING row).
- [ ] Step 2 — run fail. Step 3 — implement the matrix: rows = distinct headers (definitionKey/label) from `seededCharges` + the freight-rate row (Road `trucking`, Sea `seaRates`, Air `AIR_MAIN_FREIGHT`); columns = `variantsForMode(mode)`; cells = `NumberField` bound to the `(header,variant)` charge (or `HeavyWeightCalcRow` for HEAVY_WEIGHT_CALC); disabled/greyed where N/A; per-column total row via `computeQuoteTotals`. Keep en-dash for blank rate. Step 4 — run pass.
- [ ] Step 5 — align totals under columns (#6). Step 6 — report + `feat(ff-portal): per-variant charge matrix`.

### Task 6: per-variant transit-days (#4) + notes (#5) + sections/layout (#7)

**Files:** modify `TransitPlanForm.tsx` (a transit-days input per variant column header; other fields once), `LegSection.tsx` (section grouping + a notes textarea before the Accept-terms control; multiple fields per row). Add `notes` to `draftFromDto`.
**Interfaces (Consumes):** Task-1 `transit.guaranteedTransitDaysByVariant`, `QuoteDraft.notes`.

- [ ] Step 1 — failing tests: a transit-days field per variant bound to `guaranteedTransitDaysByVariant[v]`; a Notes textarea rendered before "Accept terms"; sections present. Step 2 — fail. Step 3 — implement. Step 4 — pass. Step 5 — report + `feat(ff-portal): per-variant transit-days, notes, section layout`.

### Task 7: FF route diagram order (#1)

**Files:** modify `apps/web/src/features/ff-portal/ScopedRouteDiagram.tsx` (order legs by the executive route topology — reuse the layering from `query-wizard/steps/legs/routeGraph.ts`/`RouteDiagram.tsx`; read-only + hover; assigned legs only). Test: `ScopedRouteDiagram.test.tsx`.

- [ ] Step 1 — failing test: given legs assigned in order [L2, L1] but a topology L1→L2, the diagram renders L1 before L2 (assert x-position / order); hover shows details; read-only. Step 2 — fail. Step 3 — implement (apply the same longest-path layering to the assigned-leg subgraph). Step 4 — pass. Step 5 — report + `fix(ff-portal): order route diagram by executive topology`.

### Task 8: preview-empty charges bug (#8)

**Files:** modify `apps/web/src/features/ff-portal/RfqPrintView.tsx` (render the SUBMITTED per-variant charges + leg chargeable weight + notes, not the empty seed). Test: `RfqPrintView.test.tsx`.

- [ ] Step 1 — reproduce in a failing test: a submitted (QUOTED) leg with priced per-variant charges → the print view currently shows empty; assert it shows the amounts per variant + the chargeable weight + notes. Step 2 — fail (confirms the bug). Step 3 — root-cause + fix (read from the submitted quote/draft, not `seededCharges`). Step 4 — pass. Step 5 — report + `fix(ff-portal): RFQ preview shows submitted charges`.

---

## Unit 5 — spec rewrites + full gate

### Task 9: rewrite affected e2e/web specs → `pnpm run ci` green

**Files:** the v2 ff-portal/pricing specs that assume the old model (`apps/api/test/quote-pricing-schema.e2e-spec.ts`, `ff-portal.e2e-spec.ts`, `charge-config-*` as needed; web `QuoteSummary`/`LegSection`/`terminalStates`/`ff-portal` suites).

- [ ] Step 1 — inventory the red specs (`pnpm --filter @svyft/api typecheck`, `pnpm --filter @svyft/web typecheck`, run suites). Step 2 — rewrite to the v3 model (per-variant charges, one leg weight, per-variant transit) preserving intent (no gutted assertions). Step 3 — **full `pnpm run ci` GREEN.** Step 4 — report + `test: re-point FF-portal/pricing specs to v3`.

---

## Self-Review

**Spec coverage:** §3 model → Task 1; §4 migration → Task 2; §5 api → Task 3; §6 findings #2→T4, #3/#6→T5, #4/#5/#7→T6, #1→T7, #8→T8; §7 testing → every task + T9. ✓
**Placeholders:** none — each task names files, exact interface shapes, and concrete test assertions; TransitPlan constraint name to be read live (noted). ✓
**Type consistency:** `chargedWeightKg` leg-level (T1) consumed by T3/T4; `rateVariant` on charges (T1) → matrix (T5) + materialize (T3); `guaranteedTransitDaysByVariant` (T1) → T3/T6. ✓
