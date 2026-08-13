# Stage 4 — FF Portal Round 4: Charge Model & UX Refinements — Design

> **Status:** Approved (2026-08-08). Folds into [PR #51](https://github.com/sj132q/svyft-logistics/pull/51) (🔴 go-live-gated — do NOT merge). Post-deploy **Test Round 4** on the freight-forwarder portal. **No destructive migration** — every per-variant→common change lands on already-nullable DB columns.

## Context

After FF Portal v3 (per-variant quoting) + the route-view rework shipped to PR #51, live testing surfaced 11 refinements to the FF quoting screen (`/ff/rfq/:token`). The largest reverse part of v3: v3 made **every** charge per-variant and dropped custom charge lines; Round 4 makes **only the freight** per-variant, everything else **common**, and **restores** custom lines. This is a UI + shared-engine change, not a data-model migration.

## Decisions (locked with the user, 2026-08-08)

- **D1 — Charge layout:** ONE integrated table. Freight rows carry the per-variant columns; common ("additional") charges are single-value rows; then an **Additional-charges subtotal**, then the **Grand total** per variant = freight(variant) + additional-charges subtotal + warehouse.
- **D2 — Transit time:** **Road stays per-variant** (Dedicated vs Groupage keep separate GTT); **Sea is common** (one value across FCL/LCL); Air single.
- **D3 — Dates:** match the FF portal's existing `datetime-local` field pattern (browser-local); **every datetime field in the FF view must reject past date/time** — enforced as both a field `min` and a submit-gate rule.
- **D4 — Heavy-weight piece weight:** must be ≤ the leg's **total cargo gross weight** (sum of all packages' gross).
- **D5 (clear items):** custom "Add Charge Line" charges are **common**; the accordion mirrors the executive (first leg open, one at a time).

## Design by area

### A. Charge model → freight-only-per-variant + common (#3, #4, #5, #6)

The catalogue already excludes `TRUCKING`/`WAREHOUSE_STAGING` input-types from `ResolvedChargeLine` (`charge-config.ts`), so `draft.trucking` / `draft.seaRates` are **already structurally separate** from `draft.charges`. The change is therefore clean:

- **`draft.trucking` / `draft.seaRates`** — unchanged: per-variant (Road Dedicated/Groupage, Sea FCL/LCL).
- **`draft.charges`** — every charge becomes **common**: one row per definition with `rateVariant: null` (Air already uses this), instead of one row per (definition × variant). The FF enters one amount per charge.
- **Custom lines (#6):** restored as **common** charges via an "Add Charge Line" affordance; the existing `Q_CUSTOM_REMARK`/`Q_CUSTOM_AMOUNT` gate (still live in the engine + materialize path) is kept — a $0 custom line needs a remark.
- **Totals (#4):** `computeQuoteTotals` folds a **`commonChargeSum`** into each variant's `grandTotal` the same way `warehouseSum` is folded today. It also exposes the additional-charges subtotal separately. Per variant: `grandTotal(v) = freight(v) + commonChargeSum + warehouseSum`.
- **Transit time (#5, D2):** the transit model keeps per-variant for **Road**, collapses to a single common value for **Sea** (one `null`-variant `TransitPlan` row — Air's existing pattern), Air single.
- **Gate (`validateQuote`):** common charges are gated **once** (not per-variant); freight is gated per priced variant; Sea GTT gated once, Road GTT per priced variant; the no-past-date rule (D3) and piece-weight rule (D4) are added.

**UI (`ChargeMatrix.tsx` + its `RfqPrintView.tsx` twin):** one integrated table per the D1 layout — freight rows with variant columns, common rows single-value, an **Additional charges** subtotal, an "Add Charge Line" button before the total, and the **Grand total** row per variant.

### B. Leg accordion + route order (#1, #2)

- **Order (#2):** legs render in **route-diagram topology order** (reuse the ordering the `ScopedRouteDiagram` already computes via `computeRouteLayout`/`computeLongestPathDepth`), not the Prisma assignment order.
- **Accordion (#1):** one leg expanded at a time (port the executive `RfqWorkspace` `openLegId` + `LegPanel` header pattern). First leg open by default; collapsed header shows **leg code · route · status**; opening a validation finding **force-opens** its leg before scroll. QUOTED/terminal legs are collapsible too.

### C. Warehouse (#7, #8)

- **#7:** hide the entire **Warehousing** `<section>`+`<h3>` when the leg has no warehouse (today the wrapper renders even when the inner list is empty).
- **#8:** labels → **"Amount for Warehouse"** and **"Cargo Acceptance Window for Warehouse"** (drop the Origin/Destination qualifier — a warehouse has no separate origin/destination here).

### D. Dates (#9, #10, and all FF datetime fields) — D3

- **#9:** Cargo Acceptance Window becomes a **datetime field** (portal `datetime-local` pattern; `cargoAcceptanceWindow` stays a string in the model — no schema change).
- **#10 + all:** every datetime field in the FF view (acceptance window, Pickup Planned Date, planned departure/arrival, ETD/ETA, …) **rejects past date/time** — a field `min` for UX plus a **submit-gate rule** so it can't be bypassed.

### E. Heavy-weight piece weight (#11) — D4

- The Air "Heavy Weight Surcharge" **piece weight ≤ the leg's total cargo gross weight** (sum of `draft.cargo[].grossWtKg`). Enforced client-side (`HeavyWeightCalcRow`) and in the submit-gate.

## Non-goals / out of scope

- No DB migration (all target columns already nullable).
- No change to the executive quoting screens.
- Route-diagram break-width polish (Round-3 follow-up) stays separate.

## Files (from the audit)

Shared: `packages/shared/src/{quote.ts,quote-engine.ts,quote-seed.ts,ff-portal.ts}`. API: `apps/api/src/modules/ff-portal/ff-portal.service.ts` (+ `rfq-token.service.ts` for leg order source). Web: `apps/web/src/features/ff-portal/{ChargeMatrix,RfqPrintView,TransitPlanForm,WarehouseStaging,LegSection,HeavyWeightCalcRow,FfPortalPage,findingNav}.tsx`. Full per-item map: `round4-audit` (scratchpad).
