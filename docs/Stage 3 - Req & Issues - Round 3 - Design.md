# Stage 3 — Req & Issues — Round 3 — Cargo UI, Units & Small Fixes — Design

> Third "Req & Issues" round from the business/testing team. Sits next to
> `Stage 3 - Req & Issues - Round 1 - Design.md` and `… Round 2 …`. Covers Step‑1 label
> renames, an Incoterms default + a persistence **bug**, the larger **Cargo‑details**
> rework (optional PO, a new reference tag, per‑row **measurement‑unit selectors** for
> dimensions and weights), and a global **datetime‑minute default**.
> **Scope this round: docs *and* implementation** (carries a Prisma migration).

## Issue list (business/testing, verbatim intent)
1. **Client & Query:** (a) rename section heading **"Delivery" → "Shipment Dates"**; (b) rename field **"Ready Date" → "Target Pickup"**.
2. **Shipment Details:** (a) Incoterms field **default = "N/A"**; (b) **bug:** the Incoterms "N/A" option **is not saving**.
3. **Cargo Details (Add/Edit):** (a) make **PO Reference optional** (remove the mandatory validation); (b) add **"Out of Gauge Cargo"** to the Reference Tags list (wired through backend + DB); (c) **dimension** unit selector **CM/MM (default CM)** — **one** dropdown governing L/W/H, positioned by the dimensions; (d) **weight** unit selector **KG/GM (default KG)** — **one** dropdown governing Net + Gross.
4. **All datetime inputs default to `:00` minutes**, across all screens.

## Resolved decisions (settled with the user)
- **(units — 3c/3d)** Store dimension/weight values **raw, in the chosen unit**, and **persist the unit per row** (`dimUnit`, `weightUnit`). `volumeCbm` becomes a **unit‑aware** generated column and is **always cubic metres (m³)** — "CBM" = cubic metre; there is **no CBM unit selector**. Leg weight roll‑ups normalise to **kg** before summing (CBM roll‑up is already m³, sums directly).
- **(PO blank — 3a)** When PO Reference is empty, the cargo‑row label falls back to **Product Name** (in findings, tooltips, validation summary).
- **(caps)** The dimension/weight **sanity caps stay fixed numbers** (unit‑agnostic; they're generous garbage‑guards, e.g. dim ≤ 100000, wt ≤ 1e9 — no real cargo approaches them).
- **(datetime — 4)** Minutes **default to `:00` but remain editable** (soft default, not a lock). Implemented once in the shared `ZonedDateTimeField` → covers Step‑1 dates, Response Deadline, ETA/ETB/ETD, and leg Ready/Target.
- **(renames — 1a/1b)** **UI‑label‑only**: the internal field `readyDate` and its DB column are unchanged; "Target Pickup" is a display label mapping to `readyDate`.
- **(Incoterms — 2a/2b)** Default the picker to N/A **and fix persistence** (root cause below); the two are coupled — a default that can't save is still broken.

## Root cause — 2b (Incoterms "N/A" not saving)
Round 1 added `NA: "N/A"` to the **shared** `Incoterms` enum (`packages/shared/src/query.ts`) and the Step‑2 dropdown, **but the Prisma `Incoterms` enum was never updated** — it still lists only the 11 real Incoterms (EXW…DDP). So the client offers "N/A" and the shared Zod schema accepts it, but the write to the `Incoterms?` DB enum column rejects/drops the unknown value → **"N/A" never persists** (and 2a's default would silently fail for the same reason). There is also a representation mismatch: the value `"N/A"` contains a `/`, which can't be a Prisma enum member identifier, and Prisma Client round‑trips enum **member names**, not DB labels.

**Fix:** store the value as **`NA`** and **display "N/A"** —
- shared enum value `NA: "NA"` (was `"N/A"`); the "N/A" text becomes a display‑only label,
- Prisma `enum Incoterms { … DDP, NA }` (member `NA`, DB label `NA`, no `/`),
- migration `ALTER TYPE "Incoterms" ADD VALUE 'NA'`,
- the Step‑2 Select shows "N/A" but its value is `NA` — so wire value == Prisma member, no mapping layer, and it saves.

## Design detail

### 1. Data model + migration (one migration)
- `enum ReferenceTag` **+= `OUT_OF_GAUGE`** (`ALTER TYPE … ADD VALUE 'OUT_OF_GAUGE'`).
- **new** `enum DimUnit { CM, MM }`, `enum WeightUnit { KG, GM }`.
- `CargoItem` **+= `dimUnit DimUnit @default(CM)`, `weightUnit WeightUnit @default(KG)`**; existing rows backfill to CM/KG (their stored values are already cm/kg, so nothing recomputes).
- `enum Incoterms` **+= `NA`** (fix 2b).
- **`volumeCbm` generated expression → unit‑aware**, still hand‑edited to match the current `dbgenerated` form:
  `((("dimL" * "dimW") * "dimH") * qty) / (CASE WHEN "dimUnit"::text = 'MM' THEN 1e9 ELSE 1e6 END)` → always m³.
  (cm: /1e6; mm: /1e9 — same physical box yields the same CBM.)

### 2. Shared (`packages/shared`)
- `ReferenceTag` += `OUT_OF_GAUGE`; UI label map → "Out of Gauge Cargo".
- `Incoterms`: value `NA: "NA"`; a display‑label helper (`NA` → "N/A"). Update the pinned `INCOTERMS`/`toEqual` test.
- `DimUnit`/`WeightUnit` const‑object enums (+ `DIM_UNITS`/`WEIGHT_UNITS` arrays), following the "never a TS enum" convention.
- `cargoCreateSchema`/`cargoUpdateSchema`: **`poReference` optional** (drop `.min(1)`, keep `.max(120)`); add `dimUnit`/`weightUnit` (default CM/KG in create); caps unchanged.
- Cargo‑label helper: `label = poReference?.trim() || productName || "Row " + (rowIndex+1)` — **Product Name** is the effective fallback (the `Row n` tail only if both are blank, which can't happen since productName stays mandatory).
- Weight roll‑up helper: convert each row's gross/net to kg by `weightUnit` (GM ÷ 1000) before summing.

### 3. API (`apps/api`)
- Cargo service: accept + persist `dimUnit`/`weightUnit`; `volumeCbm` stays DB‑generated (never written by the app).
- `shapeQuery` leg roll‑ups: `totalGrossWt`/`totalNetWt` use the kg‑normalised helper; `totalCbm` unchanged (m³).
- Incoterms: no special handling once the enum includes `NA` — the reconciled value flows straight through.

### 4. Web (`apps/web`)
- **Step 1:** section heading → **"Shipment Dates"**; field label → **"Target Pickup"** (+ its timezone‑picker label). No data changes.
- **Step 2:** Incoterms Select **default "N/A"** (value `NA`); it now round‑trips and saves (2b).
- **Step 3 (Cargo Add/Edit dialog):** PO optional; **"Out of Gauge Cargo"** tag; **one** dimension‑unit dropdown placed with the L×W×H inputs; **one** weight‑unit dropdown placed with Net/Gross; CBM shown as m³ (label unchanged).
- **`ZonedDateTimeField`:** on a fresh value, default minutes to `:00`, editable.

### 5. Docs to align (as plan tasks)
- **Functional Spec:** §7.1 (Shipment Dates / Target Pickup), §7.2 (Incoterms default N/A), §7.3 (PO optional, OUT_OF_GAUGE, dim/weight unit selectors, CBM = m³), §10.1 (F1/F5: PO no longer mandatory; a datetime‑`:00` note).
- **Technical Design:** §4.2 (`CargoItem`: `dimUnit`/`weightUnit`, unit‑aware `volumeCbm`, ReferenceTag/Incoterms enums), §4.5 (roll‑up weight normalisation).
- **Session Handoff:** record Round 3.

## Testing
- **Shared (unit):** PO optional; `dimUnit`/`weightUnit` in the cargo schemas; `OUT_OF_GAUGE`; `Incoterms.NA` value + display map + the pinned `INCOTERMS` array; CBM unit math (cm vs mm → same m³); weight roll‑up normalisation (gm→kg); the cargo‑label Product‑Name fallback.
- **API (e2e, on CI):** cargo create/read round‑trips `dimUnit`/`weightUnit`; `volumeCbm` correct for CM **and** MM; **Incoterms "N/A" persists** (regression for 2b); the migration (enum adds + backfill + generated‑column change).
- **Web (integration):** one dim‑unit + one weight‑unit dropdown (default CM/KG); PO‑optional save; OUT_OF_GAUGE selectable; Incoterms default N/A + saves; datetime `:00` default; Step‑1 renames. (Reuse `renderWithProviders`; drive Radix Select's hidden native input where jsdom is flaky.)

## Scope / flow / branch
- Branch **`feat/stage-3-round3-cargo-ui`** off `main` (carries a Prisma migration).
- Flow: this design → **`writing-plans`** (task breakdown → `docs/plans/…`) → **subagent‑driven** implementation (TDD RED→GREEN, per‑task review, **opus** whole‑branch review) → PR → prod‑verify. `pnpm run ci` green before finishing.
- **Reuse the conventions:** build `@svyft/shared` **before** web vitest; api e2e runs on CI (no local DB); hand‑edit the generated‑column migration (Prisma can't express it) matching the existing `db pull` form; shared enums are const‑objects pinned by a `toEqual` test.

## Deferred / out of scope
- **No CBM unit selector** — CBM is m³ by definition.
- Renames are **UI‑label‑only** — no `readyDate → targetPickup` data/DB rename.
- The dim/weight caps stay **fixed** (unit‑agnostic) — no per‑unit scaling.
