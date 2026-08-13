# Stage 4 — FF Portal Round 4: Charge Model & UX Refinements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Design:** `docs/Stage 4 - FF Portal Round 4 - Charge Model & UX Refinements - Design.md`. **Audit:** `round4-audit` (scratchpad).

**Goal:** Refine the FF quoting screen per Test Round 4 (11 items): only freight per-variant (rest common), grand total split (freight + additional subtotal), Road transit per-variant / Sea common, restore Add-Charge-Line, leg accordion in route order, conditional warehousing + label/datetime fixes, no-past-date on all datetime fields, and heavy-weight piece ≤ total cargo gross.

**Architecture:** `draft.trucking`/`draft.seaRates` (already separate from `draft.charges`) stay per-variant; `draft.charges` become common (`rateVariant: null`, one row per definition). The engine folds a `commonChargeSum` into each variant's grand total (like the existing `warehouseSum`) and exposes the additional-charges subtotal. Transit collapses to one common row for Sea, stays per-variant for Road. All new rules land in `validateQuote`. UI redesigns `ChargeMatrix` into one integrated table and ports the executive accordion.

**Tech Stack:** `@svyft/shared` (TS + Zod), NestJS/Prisma (apps/api), React + Vitest (apps/web).

## Global Constraints

- **Branch `feat/stage-3-cargo-packing-list` (PR #51).** 🔴 GIT PROTOCOL: implementers **NEVER touch git**. The **controller commits**: `git checkout feat/stage-3-cargo-packing-list`, `git add <specific files>`, commit, verify parent. **Never stage `CLAUDE.md` / `docs/README.md`.** Folds into the go-live-gated PR #51 (do NOT merge).
- **NO DB migration** — `ChargeLine.rateVariant` and `TransitPlan.rateVariant` are already nullable; `null` is already live (Air). If any task thinks it needs a migration, STOP and flag.
- After any `packages/shared` edit: `pnpm --filter @svyft/shared build` (consumers read `dist`).
- api e2e: Postgres `:5433`, `set -a; . apps/api/.env; set +a`.
- **The gate is `pnpm run ci` GREEN** (lint + typecheck + test + build). The ~815 KB web-chunk advisory is not a failure.
- **Masking (design §4.8) stays intact** in `ScopedRouteDiagram`/`RfqPrintView` — never expose address/contact.
- **Design decisions:** D1 one integrated table (freight per-variant + common rows + Additional-charges subtotal + Grand total per variant = freight(v) + additional subtotal + warehouse). D2 Road transit per-variant, Sea transit common (one `null`-variant row), Air single. D3 all FF datetime fields reject past date/time (field `min` + submit-gate). D4 heavy-weight piece ≤ Σ`draft.cargo[].grossWtKg`. Custom lines are common; keep the `Q_CUSTOM` $0-remark rule.

---

## File Structure

- `packages/shared/src/quote.ts` — `QuoteDraftCharge` common shaping; transit per-mode helper.
- `packages/shared/src/quote-engine.ts` — `computeQuoteTotals` (commonChargeSum + additional subtotal), `validateQuote` (common-once, freight per-variant, Sea-GTT-common/Road-per-variant, no-past-date, piece≤gross).
- `packages/shared/src/quote-seed.ts` — seed charges common.
- `apps/api/src/modules/ff-portal/ff-portal.service.ts` — materialize/seed to match.
- `apps/web/src/features/ff-portal/ChargeMatrix.tsx` + `RfqPrintView.tsx` + `HeavyWeightCalcRow.tsx` — integrated table, Add Charge Line, piece-weight client.
- `apps/web/src/features/ff-portal/TransitPlanForm.tsx`, `WarehouseStaging.tsx`, `LegSection.tsx` — per-mode GTT, warehouse conditional/labels/datetime, past-date min.
- `apps/web/src/features/ff-portal/FfPortalPage.tsx` (+ `findingNav.ts`) — leg order + accordion.

---

### Task 1: Shared model + engine + seed (charges common, per-mode transit, totals split, all gate rules)

**Files:** Modify `packages/shared/src/{quote.ts,quote-engine.ts,quote-seed.ts}`; Test `quote-engine.test.ts`, `quote.test.ts`.

**Interfaces (Produces — Tasks 2/3/4 rely on these):**
- `QuoteDraftCharge.rateVariant` semantics: **non-freight charges are `null` (common)** — one row per `definitionKey`. Freight stays in `trucking`/`seaRates` (per-variant). Custom line = `{ definitionKey: null, presetKey: null, rateVariant: null, label, amount, remark? }`.
- Transit: **Sea uses one common entry**, **Road stays per-variant**, Air single. Model the transit-days key so `variantsForTransit(mode)` returns `[DEDICATED,GROUPAGE]` for Road, `[null]`(common) for Sea, `[null]` for Air. (Reuse `guaranteedTransitDaysByVariant`; Sea writes the `null`/common key.)
- `computeQuoteTotals(draft)` gains `additionalChargeSum` (Σ common `charges` via `effectiveChargeAmount`) and per-variant `grandTotal = variantFreight(v) + additionalChargeSum + warehouseSum`. Keep `warehouseSum`.
- `validateQuote` v4 rules (below).

- [ ] **Step 1 — failing engine tests.** In `quote-engine.test.ts`: (a) a ROAD draft with `trucking:[{rateVariant:DEDICATED,amount:4200},{GROUPAGE,3800}]`, common `charges:[{definitionKey:"DOC",rateVariant:null,amount:150},{"CUSTOMS",null,300}]`, `warehouse:[{amount:0}]` → `additionalChargeSum===450`, `grandTotal(DEDICATED)===4650`, `grandTotal(GROUPAGE)===4250`. (b) a SEA draft with one common transit entry → `validateQuote` requires exactly one Sea GTT (not per-variant); a ROAD draft requires GTT per priced variant. (c) past-date: a `plannedPickupDate`/`cargoAcceptanceWindow`/`departureDate` in the past → a finding; future → none. (d) piece-weight: a HEAVY_WEIGHT_CALC charge whose `pieceWeightKg` > Σ`cargo.grossWtKg` → a finding.
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — model** (`quote.ts`): make `charges` common (drop the per-variant fan-out shape; `rateVariant: null` for all non-freight). Add/adjust a `variantsForTransit(mode)` helper (Road→variants, Sea/Air→`[null]`). Custom-line shape as above.
- [ ] **Step 4 — engine** (`quote-engine.ts`): `computeQuoteTotals` — `additionalChargeSum = Σ effectiveChargeAmount(common charges)`; `grandTotal(v) = variantFreight(v) + additionalChargeSum + warehouseSum`; expose `additionalChargeSum`. `validateQuote`: **Q_PRICED** for common charges gated ONCE (not per-variant); freight gated per priced variant; **Q_TRANSIT** — Sea one common value, Road per priced variant, Air single; keep **Q_CUSTOM_REMARK/AMOUNT**; **Q_PAST_DATE** — any FF datetime field (`plannedPickupDate`, `cargoAcceptanceWindow`, `departureDate`, `arrivalDate`, ETD/ETA) earlier than `nowIso` → finding scoped to that field (route via `findingNav`); **Q_PIECE_WEIGHT** — `pieceWeightKg > Σ cargo.grossWtKg` → finding scoped to the charge/field.
- [ ] **Step 5 — seed** (`quote-seed.ts`): seed `charges` as ONE common row per definition (`rateVariant: null`), freight per-variant as today.
- [ ] **Step 6 — green + typecheck + build shared.** Commit `feat(shared): FF quote round-4 — common charges, per-mode transit, split totals, new gate rules`.

---

### Task 2: API materialize + seed (`ff-portal.service.ts`)

**Files:** Modify `apps/api/src/modules/ff-portal/ff-portal.service.ts`; Test an `apps/api/test/ff-portal*.e2e-spec.ts`.

**Consumes:** Task 1 model.

- [ ] **Step 1 — failing e2e.** Distribute → price a common charge + custom line + per-variant freight + Sea (one GTT) → submit → GET → assert: common `ChargeLine`s persisted with `rateVariant: null`; a custom line round-trips; one Sea `TransitPlan` (null variant); `grandTotal = max variant (freight + additional + warehouse)`.
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** `resolveScope` seed: common `charges` one row each; freight per-variant as today. `submit()` materialize: common `ChargeLine`s `rateVariant: null`; freight per-variant; Sea one `TransitPlan` (null), Road per-variant; `Quote.grandTotal = max` over `computeQuoteTotals` variants. Keep the custom-line tolerance (already present).
- [ ] **Step 4 — build shared, api spec green + typecheck.** Commit `feat(api): FF portal round-4 materialize (common charges, per-mode transit)`.

---

### Task 3: ChargeMatrix redesign + RfqPrintView twin + heavy-weight client (#3/#4/#6/#11-UI)

**Files:** Modify `apps/web/src/features/ff-portal/{ChargeMatrix,RfqPrintView,HeavyWeightCalcRow}.tsx`; Tests colocated.

**Consumes:** Task 1 totals (`additionalChargeSum`), common charges.

- [ ] **Step 1 — failing tests.** (a) a ROAD leg renders freight rows WITH Dedicated/Groupage columns AND common charge rows as a SINGLE input (assert one amount field per common charge, not two). (b) an **Additional charges** subtotal row renders the common sum; the **Grand total** row per variant = freight + subtotal + warehouse. (c) an **"Add Charge Line"** button adds a common custom row (label + amount [+ remark]). (d) `HeavyWeightCalcRow`: entering `pieceWeightKg` > the leg's total cargo gross shows an inline error and blocks (client mirror of the Task-1 gate).
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement** the D1 integrated table in `ChargeMatrix`: freight rows (per-variant columns), common charge rows (single input spanning), Additional-charges subtotal, Add-Charge-Line (`useFieldArray` on `charges`), Grand total per variant. Mirror in `RfqPrintView` (read-only). `HeavyWeightCalcRow` takes the leg total-gross prop and validates piece ≤ gross.
- [ ] **Step 4 — green + typecheck.** Commit `feat(ff-portal): round-4 charge table (freight per-variant + common + subtotal + add-line)`.

---

### Task 4: Leg-form fields — transit per-mode + warehouse + past-date min (#5/#7/#8/#9/#10-UI)

**Files:** Modify `apps/web/src/features/ff-portal/{TransitPlanForm,WarehouseStaging,LegSection}.tsx`; Tests colocated.

**Consumes:** Task 1 transit shape + Q_PAST_DATE rule.

- [ ] **Step 1 — failing tests.** (a) `TransitPlanForm`: a SEA leg shows ONE Guaranteed Transit Time field; a ROAD leg shows one per variant. (b) `LegSection`: a leg with NO warehouse renders no "Warehousing" heading/section; with a warehouse it does. (c) `WarehouseStaging`: labels read "Amount for Warehouse" / "Cargo Acceptance Window for Warehouse"; the acceptance window is a `datetime-local` input with a `min` of now. (d) every datetime field here (pickup, departure/arrival, ETD/ETA, acceptance window) has a `min` = now (no past).
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** `TransitPlanForm`: render GTT per `variantsForTransit(mode)` (Sea one, Road per-variant). `LegSection`: wrap the Warehousing section in a `hasWarehouse` conditional. `WarehouseStaging`: relabel; Cargo Acceptance Window → `datetime-local` (portal `toDatetimeLocal`/`fromDatetimeLocal` convention) with `min`. Add `min={nowLocal}` to all FF datetime inputs in these forms.
- [ ] **Step 4 — green + typecheck.** Commit `feat(ff-portal): round-4 leg fields — per-mode transit, conditional warehouse, warehouse labels/datetime, no-past dates`.

---

### Task 5: Leg accordion + route order (#1/#2)

**Files:** Modify `apps/web/src/features/ff-portal/{FfPortalPage,LegSection,findingNav}.tsx`; Tests colocated.

- [ ] **Step 1 — failing tests.** (a) legs render in route-topology order (a fixture whose assignment order ≠ topology order proves reordering). (b) only ONE leg body is expanded at a time; clicking another leg's header collapses the first (assert one open body). (c) first leg open by default; collapsed header shows leg code + status. (d) triggering a validation finding on a collapsed leg force-opens it before scroll.
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** In `FfPortalPage`: compute leg order from the route topology (reuse/extract `ScopedRouteDiagram`'s `buildScopedGraph` + `computeLongestPathDepth` into a small exported `orderLegsByRoute(legs)` helper); add `openLegId` state (default first). `LegSection` gets a button header (leg code · route · status) + `open` prop gating the body (port the executive `LegPanel` pattern). `findingNav`: before scroll, set `openLegId` to the finding's leg.
- [ ] **Step 4 — green + typecheck + FULL `pnpm run ci`.** Commit `feat(ff-portal): round-4 leg accordion in route order`.

---

## Self-Review

- **Spec coverage:** #3/#6 → T1+T3; #4 → T1+T3; #5 → T1+T4; #7/#8/#9 → T4; #10/all-dates → T1(gate)+T4(min); #11 → T1(gate)+T3(client); #1/#2 → T5. ✓
- **Type consistency:** `additionalChargeSum` (T1) → T3; `variantsForTransit` (T1) → T2/T4; common `charges` shape (T1) → T2/T3; `orderLegsByRoute` (T5). ✓
- **No migration** (all nullable columns). **Sequencing:** T1→T2 (backend), T3/T4 (UI), T5 last (wraps leg sections). ✓
- **Risk:** T1 (engine + 838-line test file) and T3 (ChargeMatrix redesign) are the heavy tasks — TDD + task review gate each.
