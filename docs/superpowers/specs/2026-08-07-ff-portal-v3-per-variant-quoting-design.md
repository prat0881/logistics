# FF Portal v3 — Per-variant quoting (Test Round 2)

**Date:** 2026-08-07 · **Branch:** `feat/stage-3-cargo-packing-list` (folded into PR #51, before the go-live cutover) · **Status:** design, pending user review.

## 1. Context & motivation

FF acceptance testing of the delivered v2 portal surfaced 8 findings. Three of them (#2/#3/#4) are not tweaks — they change the shape of the FF quote from the v2 model to a **per-variant** model. The user chose to fold this into PR #51 before go-live (so the cutover ships the corrected UX rather than v2-then-redo).

**v2 model (today):** zone charges are a single **shared** set; only the trucking (Dedicated/Groupage) and sea (FCL/LCL) _rates_ differ per variant; chargeable weight is **per-package** (`QuoteCargoLine.chargedWeightKg`, NOT NULL); there is **one** transit block per leg. Engine grand-total per variant = `variant rate + shared subtotal (charges + warehouse)`.

**v3 model (this spec):** each rate variant is a full **column** the FF prices independently; chargeable weight is **one informational value per leg**; **Guaranteed Transit Time is per variant**; warehousing stays **shared**.

## 2. Decisions (locked in brainstorming, 2026-08-07)

- **D1 — Charges per variant (full columns).** Each variant (Road: Dedicated/Groupage; Sea: FCL/LCL; Air: single) carries its own amount for every applicable charge header. A header not applicable to a variant is greyed/disabled. Each variant's grand total = its own column.
- **D2 — Chargeable weight: one per leg, informational.** The FF enters a single Chargeable Weight (kg) for the whole leg, informed by total gross + CBM. It is captured, **not** auto-multiplied into any total (grand total = Σ charges).
- **D3 — Guaranteed Transit Time per variant.** One transit-days figure per variant; the rest of the schedule (carrier/dates/mode-specific) stays once per leg.
- **D4 — Warehousing shared.** One per-leg warehouse section (CFS/side + amount); added once to every priced variant's grand total.
- **D5 — Land in PR #51** (adds one migration to its already-destructive, unmerged set).

## 3. Domain model (`packages/shared`)

### 3.1 `quote.ts` — `QuoteDraft`

- **Chargeable weight → leg-level:** remove `chargedWeightKg` from `QuoteDraftCargo` (it stays read-only display: `packageId`, `grossWtKg`, `cbm`). Add `chargedWeightKg: number | null` to `QuoteDraft`.
- **Charges → per-variant:** add `rateVariant: ChargeRateVariant | null` to `QuoteDraftCharge` (`null` = a single-column/Air line or a non-variant line). The matrix is `charges` grouped by `definitionKey` (row) × `rateVariant` (column).
- **Main-freight rate stays per-variant, unified into the matrix presentation.** Keep `QuoteDraftTrucking` (Dedicated/Groupage + `tonnage`) and `QuoteDraftSeaRate` (FCL/LCL + `containerSize`) as the main-freight row's per-variant cells — they already carry the variant-specific attributes. The matrix UI renders the freight-rate row from these; all other rows from `charges`. (No fold/merge of these arrays in v3 — lower churn; the UI unifies the presentation. The plan may revisit folding all three into one per-variant `charges` array if it proves cleaner.)
- **Column count by mode:** **Air = a single column** (no comparison — one set of amounts; matrix degrades to a one-column list); **Road/Sea = two columns** (Dedicated/Groupage, FCL/LCL). The freight-rate row's source differs by mode: **Road ← `trucking`, Sea ← `seaRates`, Air ← the `AIR_MAIN_FREIGHT` charge line**; every other row ← `charges` keyed by `rateVariant`.
- **Transit-days per variant:** replace `transit.guaranteedTransitDays: number | null` with `transit.guaranteedTransitDaysByVariant: Partial<Record<ChargeRateVariant, number>>` (Air uses a single implicit variant key). All other `QuoteDraftTransit` fields stay per-leg.
- **Notes (#5):** add `notes: string | null` to `QuoteDraft` (distinct from `dgSurchargeNote` and `termsConditions`).
- Remove the now-unused `AIR_CHARGE_PRESETS`/`SEA_CHARGE_PRESETS`/`ChargePreset` (already dead; confirmed by the Unit-6 review) while touching this file.

### 3.2 `quote-engine.ts`

- `computeQuoteTotals`: **grand total per variant = Σ (that variant's charge cells) + variant freight rate + shared warehouse.** The old `sharedSubtotal + rate` split is replaced by per-column sums; warehouse is the only shared addend. `chargeableWeightKg` becomes the single leg value (display only; not summed). `effectiveChargeAmount` (HEAVY_WEIGHT_CALC fold) is unchanged, applied per cell.
- `validateQuote` (submit-gate v3): (a) **Q_WEIGHT** — one leg-level chargeable weight required; (b) **Q_RATE** — ≥1 variant fully priced; (c) **Q_PRICED** — for each priced variant, every applicable charge header has an amount; (d) **Q_TRANSIT** — each priced variant has a transit-days value; (e) currency/validity/custom-remark rules unchanged.

## 4. Schema & migration (`prisma/`, one new migration in PR #51's set)

- `QuoteCargoLine`: **drop `chargedWeightKg`** (per-package). `Quote`: **add `chargedWeightKg Decimal(12,3)?`** (leg-level) + **add `notes String?`**.
- Per-variant charges at materialize: **add `rateVariant ChargeRateVariant?` to `ChargeLine`** (null = single/Air).
- Per-variant transit-days: **add `rateVariant ChargeRateVariant?` to `TransitPlan` and write one row per priced variant** (the non-days schedule fields repeat or stay on the primary row — plan detail). Chosen over a JSON blob for query-ability and to mirror the per-variant `ChargeLine`.
- Pre-go-live + data-disposable (the branch already wipes `QuoteCargoLine`), so drops are safe. Hand-authored SQL + `migrate deploy` (never `migrate dev`).

## 5. API (`apps/api`)

- **`ff-portal.service.ts` submit/materialize:** write one `Quote.chargedWeightKg` (leg-level) instead of per-`QuoteCargoLine`; write `ChargeLine` rows with `rateVariant`; write per-variant transit; persist `notes`; grand total = max over variants of the v3 per-column total. Keep the stale-charge drop-filter + `assertApplied` patterns.
- **`resolveScope` (portal GET):** seed the per-variant matrix from `chargeConfigSnapshot.lines` × the mode's variants; seed one leg-level chargeable-weight slot; seed per-variant transit-days.
- **Manifest / masking unchanged** (`ManifestSnapshotCargo` already per-package, no cargo/item leak).
- Submit-gate v3 (§3.2) enforced server-side via `validateQuote`.

## 6. Findings → changes

1. **FF route order (#1)** — `ScopedRouteDiagram` orders assigned legs by the **executive route topology** (reuse the longest-path layering from `RouteDiagram`/`routeGraph`), read-only + hover; assigned legs only.
2. **Merged cargo/weight table (#2)** — replace `CargoManifestTable` + `ChargedWeightGrid` with one table: per-package read-only rows → Totals row (Σ Gross, Σ CBM) → one Chargeable Weight (kg) input. Drop per-package count + per-package charged-wt columns.
3. **Per-variant charge matrix (#3, #6)** — new matrix component: header rows × variant columns; per-cell amount inputs; N/A cells greyed; per-column grand total aligned on the totals line. Replaces the separate `ChargeZonePanel` / `TruckingBlocks` / `SeaChargesPanel` entry with a unified matrix (those may be refactored into the matrix or its cell renderers).
4. **Per-variant transit-days (#4)** — a transit-days input under each variant column header; other schedule fields once per leg (`TransitPlanForm`).
5. **Notes (#5)** — a notes textarea immediately before the Accept-terms control.
6. **Alignment (#6)** — charge rows and per-variant totals share a column grid so each total lines up under its column.
7. **Sections/density (#7)** — `LegSection` groups fields into labelled sections (Cargo & weight · Charges · Transit · Currency/validity · Notes · Terms), multiple fields per row.
8. **Preview bug (#8)** — `RfqPrintView` reads the **submitted** quote (materialized per-variant charges + leg chargeable weight + notes), not the empty seed. Root-cause during implementation (likely it renders `seededCharges` amounts, which are null, rather than the submitted draft).

## 7. Testing

- shared: `quote-engine.test.ts` (per-variant totals, submit-gate v3), `quote.test.ts` (draft shape).
- api e2e: distribute → per-variant submit → assert per-variant `ChargeLine` rows, one `Quote.chargedWeightKg`, per-variant transit, `notes`; submit-gate v3 (each priced variant fully priced + has transit-days; leg weight required). Rewrite the affected ff-portal + pricing specs.
- web: the merged cargo/weight table, the charge matrix (per-cell entry, N/A greyed, per-column totals), per-variant transit, notes, route order, and the preview (non-empty charges).

## 8. Scope, risk, sequencing

- **Big change to a just-opus-reviewed layer.** Build via SDD units (shared model+engine → migration → api → web matrix → web rest → spec rewrites), each reviewed, `pnpm run ci` green per unit.
- **Migration is destructive-adjacent** but pre-go-live/data-disposable; it joins PR #51's migration set. The 🔴 go-live gate (verify/accept Neon-prod wipe) is unchanged and still blocks merge.
- **Out of scope:** the parked items (DG `Corrective`-vs-`RfqDefining`, the leg-status-rollup follow-up `task_2ffe1ce4`) and the go-live cutover itself.
