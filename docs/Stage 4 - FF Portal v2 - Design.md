# Stage 4 · FF Portal v2 (§4.8) + Cargo→Package Ripple — Design

> **Status:** design of record (brainstorm complete, 2026-08-06). Built on branch `feat/stage-3-cargo-packing-list` (the Stage-3 Cargo→Package→Item re-model, tip `8cd4077`) — this is the deferred **Stage-4 ripple** *plus* the full **§4.8 FF-Portal v5** upgrade, delivered together in one branch.
>
> **Source requirement:** *"Stage 4 · Section 4.8 — RFQ Freight Forwarder Portal — Field Reference (v5)"* (business PRD, provided 2026-08-06). Its §4.8.x numbers are a newer master-PRD scheme; the mapping to our repo docs is in §2.
>
> **Depends on / consumes:** the completed Stage-3 re-model on this branch — `Cargo → Package → Item` + `LegPackage` (leg assignment at **package** grain), `ReferenceTag{…,DG}` (`isDangerous` retired), canonical **kg/cm** units, `effectiveTags(package + its items)`. See `docs/superpowers/specs/2026-08-05-stage3-cargo-packing-list-design.md` (decisions C1–C14).
>
> **Implementation plan:** to be written next under `docs/plans/stage-4/Stage 4 - FF Portal v2 - Implementation Plan.md`.

---

## 1. Purpose & scope

The Stage-3 re-model intentionally **broke** the Stage-4 quote/portal layer (it references the dropped flat `CargoItem`/`isDangerous`/`LegCargo`). Today: **112 `apps/api` tsc errors, all in this layer** → `nest build` fails → the branch cannot deploy. This design covers **both**, in one branch:

**(A) The ripple — re-point the Stage-4 quote/portal layer to the new Package grain** (the deploy unblocker): `rfq/manifest.ts`, `ff-portal/ff-portal.service.ts`, `rfq/leg-context.ts`, `rfq/rfq.service.ts`, the shared `ManifestSnapshotCargo`, the executive `rfq-workspace/*` web, and ~25 Stage-4 e2e specs — all onto `Cargo/Package/Item` + `LegPackage` + `assignedPackageIds` + canonical kg + `effectiveTags`.

**(B) The §4.8 FF-Portal v5 upgrade** — the full field-reference: dual-rate pricing (Road Dedicated/Groupage, Sea FCL/LCL) with **two leg grand totals**; **FF-entered Charged Wt (kg)** per package; Air Zone-2 **FSC + Peak Season** + a per-piece **Heavy-Weight calculator**; **tonnage / container-size / B/L** option-sets; **tag-driven two-gate**; **mandatory Guaranteed Transit Time** + mode-specific transit; richer symmetric **warehouse zones**; **Route-Overview SVG + RFQ PDF + FF Preview**; and the **v2 submit gate**.

**In scope:** everything above, delivered so `pnpm run ci` is green and the branch is deployable.

**Out of scope:** Stage-5 quote comparison/award (a separate greenfield epic — it *consumes* the dual grand totals this produces); admin CRUD for the charge catalogue (still seed-only, deferred from PR #50).

---

## 2. Section-number mapping (PRD → repo)

The PRD's `§4.8.x` are a newer master-PRD scheme. The FF portal itself is our SB4c (`apps/web/src/features/ff-portal/*`); the executive side is SB3 (`apps/web/src/features/rfq-workspace/*`).

| PRD § | This build |
|---|---|
| §4.8.1 RFQ Header · §4.8.2 Action Bar | `PortalShell` + a new header action bar (PDF, Save Draft) |
| §4.8.3 Route Overview SVG | new `ScopedRouteDiagram` on the portal (was deferred SB4-polish) |
| §4.8.4 Leg Header · §4.8.5 Package List | `LegSection` header + a new package-grain manifest table |
| §4.8.6 Road · §4.8.7 Air · §4.8.8 Sea charge blocks | mode charge panels (dual-rate, calculator, dropdowns) |
| §4.8.9 Remarks · §4.8.10 Tag two-gate | per-line remark + `effectiveTags`-driven activation |
| §4.8.11 Transit · §4.8.12 Grand Total | mode-specific `TransitPlan` + per-variant totals |
| §4.8.13 Deadline/reminders | **already shipped** (SB5 — T-36/24/12/6/2 + expiry) |
| §4.8.14 Notes/T&C/Submit | T&C + Preview + Submit + the v2 submit gate |

---

## 3. Background — what's broken, what exists

**Broken by the re-model (the ripple).** `apps/api` won't compile: `rfq/manifest.ts` (the crux — builds the FF quote manifest from `leg.legCargo.cargoItem.*` + `toKg(weightUnit)`), `ff-portal.service.ts`, `rfq/leg-context.ts` (`LEG_RFQ_INCLUDE.legCargo`), `rfq/rfq.service.ts`; the shared `ManifestSnapshotCargo` is still the flat shape; ~25 Stage-4 e2e specs build cargo via `prisma.cargoItem`/the old API. All must move to the package grain.

**Already built (consumed / extended).** Charge-config catalogue + Executive per-leg selection + warehouse attribution (**PR #50**, `ChargeLineDefinition`/`LegChargeLineSelection`/`Quote.chargeConfigSnapshot`/warehouse toggle) — v2 **extends** the catalogue and **reinstates** the tag two-gate PR #50 deferred. SB4 portal skeleton (`PortalShell`, `LegSection`, `ChargeZonePanel`, `TruckingBlocks`, `WarehouseStaging`, submit/save-draft). SB5 deadline/reminder/expiry (§4.8.13 — done).

**New cargo model (the foundation).** `Package` = the packing/freight unit (packageType, L/W/H canonical cm, gross/net kg, `tags[]`, MSDS, generated CBM); `Item` = contents (product, qty, uom, hsCode, `tags[]`); `LegPackage` = leg↔package assignment; `effectiveTags(pkg)` = union(pkg.tags, items' tags); DG is a `ReferenceTag`.

---

## 4. Design principles

1. **Re-point, then enhance.** The ripple (package-grain re-point) lands first as its own compiling, tested layer; the v5 features build on it. This keeps the deploy-unblock separable and reviewable.
2. **Two rate rows + shared lines** (approved). A leg's freight/trucking rate is up to two rows (Ded/Grp, FCL/LCL); every other charge is shared; the engine computes one grand total per rate row. Air is single-rate.
3. **FF-entered Charged Wt (kg)** replaces density-derived tonnes — the whole quote layer moves to **kg** (the Stage-3 canonical unit); no tonne math on the portal.
4. **Freeze-at-distribute stays the boundary** (PR #50 / SB4): the portal reads only the frozen `manifestSnapshot` + `chargeConfigSnapshot`; v2 widens what's frozen (per-package tags, the resolved tag-driven lines).
5. **Stage-5 owns comparison.** v2 *captures + carries* both dual-rate grand totals; it never pre-selects a winner.

---

## 5. Data model (shared + Prisma)

### 5.1 Chargeable weight → FF-entered kg per package
`QuoteCargoLine` (already package-grain, `packageId`→`Package`): **`freightDensity` → `chargedWeightKg` `Decimal(12,3)`** (FF-entered); **drop `chargeableWeightT`** (the chargeable weight *is* the FF-entered kg). `QuoteDraftCargo` ( `quote.ts` ): `cargoItemId`→`packageId`, `freightDensity`→`chargedWeightKg`, drop `grossWtT` tonnes (carry `grossWtKg` for display only); `isDangerous`→derive from tags. `computeChargeableWeight` (density) is **removed**. *[decision: drop the density model entirely — §12]*

### 5.2 Dual-rate = two rate rows + shared lines
- **Road** — `TruckingCharge` gains `rateVariant ChargeRateVariant` (`DEDICATED`|`GROUPAGE`) and `tonnage TruckTonnage?` (Dedicated only); a leg may hold **one row per variant** (both requested). Existing `basis`/`amount`/`remarks` stay.
- **Sea** — new **`SeaFreightRate`** (per quote): `rateVariant` (`FCL`|`LCL`), `containerSize ContainerSize?` (FCL only), `amount`, `remarks`. (Sea freight was a flat preset line; it becomes a structured dual-rate.)
- **Air** — single air-freight (Zone-2 lines, no variant).
- New enums: **`ChargeRateVariant`** `{DEDICATED, GROUPAGE, FCL, LCL}`; **`TruckTonnage`** (11: 1T/2T/3.5T/5T/7T/9T/12T/16T/20T/25T/`TRAILER_30_40T`); **`ContainerSize`** `{TWENTY, FORTY, FORTY_FIVE_HC}`; **`BillOfLadingType`** `{ORIGINAL, TELEX}`.

### 5.3 Charge-catalogue additions (extend `ChargeLineDefinition`, PR #50)
Seed additions (create-only): Air Zone-2 **`AIR_MAIN_FSC` (Fuel Surcharge)** + **`AIR_MAIN_PEAK_SEASON`** (cores); the Air **Heavy-Weight Surcharge** becomes a **typed calc line** — a new `inputType = HEAVY_WEIGHT_CALC` with FF inputs `pieceWeightKg`, `airlineLimitKg`, `ratePerExcessKg` → computed `amount = max(0, pieceWt − limit) × rate` (stored on the `ChargeLine` instance via new nullable columns). Sea Zone-1 **Bill of Lading** gains `billOfLadingType BillOfLadingType?` on its `ChargeLine`. *[decision: typed calc line, not a free amount — §12]*

### 5.4 Tags at package grain + two-gate
`ManifestSnapshotCargo` (`rfq.ts`) → **per-package** shape: `packageId`, `packageType`, `dims`/`grossWtKg`/`volumeCbm` (canonical), **`tags: ReferenceTag[]`** (= `effectiveTags` incl. DG). **No nested items in the snapshot** — the FF package list is package-grain (items are executive-side cargo detail); the leg include fetches items only to *compute* `effectiveTags` at freeze time (§9). `buildManifestSnapshot` builds from `leg.legPackages.package.*`. **Two-gate** (reinstates PR #50's deferred gate): at distribute, a tag-driven `ChargeLineDefinition` activates iff **(1)** the Executive selected it **AND (2)** some assigned package's `effectiveTags` includes its `tagKey` — resolved against the frozen manifest and frozen into `chargeConfigSnapshot`.

### 5.5 Warehouse zones (richer)
Keep the PR #50 attribution toggle (`Leg.warehouseHandlingIncluded`, one-FF-per-warehouse). The `WarehouseStagingLine` gains: **`cfsCode`** (read-only from the warehouse `Point`), a **`side`** (`DROP`|`PICKUP`, derived from the leg's endpoints), and the side-specific seeded lines (Drop: Warehousing-In + onward-truck; Pickup: Warehousing-Out + storage-before-dispatch) + FF `[+ Add Charge]`. Rolls into the leg grand total(s) only when the toggle = Yes.

### 5.6 Transit — mode-specific + mandatory
`TransitPlan` gains mode-specific optional fields (Road: `plannedPickupDate`; Air: `airline`, `flightNumber`, `plannedDeparture`, `plannedArrival`; Sea: `shippingLine`, `vesselVoyage`, `etd`, `eta`) and keeps **`guaranteedTransitDays`** — now **mandatory** on every leg (submit gate).

---

## 6. Engine (`@svyft/shared`)
- **`computeQuoteTotals` → per-variant leg grand totals.** Returns `{ variants: [{ key: ChargeRateVariant|"AIR", grandTotal }], sharedSubtotal, chargeableWeightKg }`. Each variant grand total = its rate + `sharedSubtotal` (all non-rate lines: zone cores, Exec extras, active tag lines, warehouse-if-Yes). Air → a single `AIR` variant. Chargeable weight = Σ `chargedWeightKg` (no density).
- **Heavy-Weight calc** computed in the engine (`max(0, pieceWt−limit) × rate`), live client-side + authoritative at submit.
- **Tag-driven activation** resolved at distribute from the frozen package tags (§5.4).

## 7. Submit gate v2 (`validateQuote`)
All blocking: (1) Quote Validity + Currency set; (2) every **active** charge line priced — amount present, **0 allowed only with a Remark**; (3) **Remark mandatory on every custom `[+ Add Charge]` line**; (4) **Guaranteed Transit Time present on every leg**; (5) for a dual-rate leg, **≥1 of the two rates filled** (each filled rate yields its own grand total; no pre-select); (6) submission before the deadline. (Retires the old density-required Q2.)

## 8. FF Portal (`apps/web/src/features/ff-portal/*`, §4.8)
- **Header + action bar** (§4.8.1–2): RFQ no./modes/incoterm/deadline-countdown/validity/currency + **Download PDF** + Save Draft.
- **Route Overview SVG** (§4.8.3): new `ScopedRouteDiagram` — assignment-scoped, address-masked, node-detail-on-click.
- **Package List** (§4.8.5): from the frozen per-package manifest — read-only cols (SN, count, type, L/W/H, net/gross kg, CBM) + **FF-entered Charged Wt (kg)** + **read-only tags** (incl. DG); no PO/product.
- **Mode charge blocks:** Road (dual **Dedicated**[tonnage]/**Groupage** trucking + Exec lines + warehouse), Air (Zone 1/2 incl. FSC/Peak + **Heavy-Weight calculator** + Zone 3 Exec extras), Sea (dual **FCL**[container]/**LCL** + Zone 1 incl. **B/L dropdown** + Zone 3). **Two grand totals side-by-side** for Road/Sea (blank rate → `–`).
- **Transit** (§4.8.11) mode-specific; **per-line remarks** (§4.8.9); **T&C + Preview + Submit** (§4.8.14) + **RFQ PDF**.

## 9. The ripple re-point (unblock `nest build`)
`rfq/leg-context.ts` (`LEG_RFQ_INCLUDE.legCargo` → `legPackages: { include: { package: { include: { items: true } } } }`); `rfq/manifest.ts` (`buildManifestSnapshot` from `leg.legPackages.package.*`, canonical kg, `effectiveTags`, drop `toKg`); `ff-portal.service.ts` (seed/submit at package grain, `chargedWeightKg`); `rfq/rfq.service.ts` (`legPackages.length` eligibility). Shared `ManifestSnapshotCargo` → §5.4 shape. The **~25 Stage-4 e2e specs** rebuilt onto `Cargo/Package/Item` + `assignedPackageIds`.

## 10. Executive RFQ-workspace screen (`rfq-workspace/*`)
Re-point to package grain: `CargoTagIcons` (already DG-as-tag in Stage-3 web), `QueryOverviewHeader`, `CargoManifestTable`, `PreviewRfqDialog`, `RfqWorkspace` → consume `detail.cargos` / `assignedPackageIds` / `PackageDto`. The Configure-charges popover + warehouse toggle (PR #50) are unchanged.

## 11. Deviations / deferrals
| Item | Note |
|---|---|
| Chargeable-weight aid (§4.8.15) | = just "FF enters Charged Wt" (per user) — no separate aid built |
| Units | inherit Stage-3 canonical **kg/cm** — no tonne switch on the portal |
| Admin catalogue CRUD | still seed-only (deferred from PR #50); FSC/Peak/etc. are seeded |
| Stage-5 comparison | consumes the two grand totals; not built here |

## 12. Flagged design decisions (approved in brainstorm)
- **Drop the density model** — `chargedWeightKg` replaces `freightDensity`/`chargeableWeightT`; `computeChargeableWeight` removed.
- **Two rate rows + shared lines** — dual-rate via `TruckingCharge.rateVariant` + `SeaFreightRate`; per-variant grand totals; RFQ carries both, no pre-select.
- **Heavy-Weight = typed calc line** (`inputType HEAVY_WEIGHT_CALC` + 3 FF inputs → computed), not a free amount.

## 13. Migration
Additive on top of the Stage-3 re-model migration (already applied to :5433, and destructive-on-merge to Neon — §16): `ALTER "QuoteCargoLine"` rename `freightDensity`→`chargedWeightKg` + drop `chargeableWeightT`; new enums (`ChargeRateVariant`/`TruckTonnage`/`ContainerSize`/`BillOfLadingType`) + `HEAVY_WEIGHT_CALC` on `ChargeLineInputType`; `ALTER "TruckingCharge"` add `rateVariant`/`tonnage`; new `SeaFreightRate` table; `ALTER "ChargeLine"` add calc columns + `billOfLadingType`; `ALTER "WarehouseStagingLine"` add `cfsCode`/`side`; `ALTER "TransitPlan"` add the mode-specific columns; `ALTER "ManifestSnapshot"`-none (Json). Hand-authored SQL + `migrate deploy` (never `migrate dev`).

## 14. Testing
- **shared** (vitest): dual-total engine (per-variant), Heavy-Weight calc, submit-gate v2, tag-two-gate resolver, package-grain manifest builder.
- **api** (isolated-transpile jest, real DB :5433): distribute freezes the per-package manifest + activated tag lines; portal seeds/submits at package grain with `chargedWeightKg`; dual-rate materialize; the **~25 rewritten Stage-4 specs**; full `apps/api typecheck` green (clears the 112 errors).
- **web** (vitest): package list (Charged Wt input, read-only tags), dual-rate blocks (two totals), Heavy-Weight calculator, dropdowns, mode transit, route SVG, PDF, preview.

## 15. Build sequencing (SDD units, in order)
1. **Ripple unblock** — the 4 api src + shared `ManifestSnapshot` to package grain → `apps/api typecheck` green.
2. **Model/engine v2** — QuoteCargoLine kg, dual-rate models/enums, catalogue additions/seed, engine dual totals + calc + two-gate, submit-gate v2.
3. **api v2 wiring** — distribute freeze (per-package tags + activated lines), portal seed/submit for dual-rate + kg + calc.
4. **Exec web re-point** (§10) + **FF portal v5** (§8) + **extras** (route SVG, PDF, preview).
5. **Rewrite the ~25 Stage-4 e2e specs** → full green.
6. **Final gate** — `pnpm run ci` green + branch-wide `prettier --write` + carried Minors + **opus whole-branch review** → finish/PR.

## 16. Go-live
🔴 The Stage-3 migration is **destructive** (`DROP CargoItem`/`LegCargo` + `DELETE FROM QuoteCargoLine`) and CD auto-runs `prisma migrate deploy` on merge to `main`. **Do NOT merge until the whole branch is green + opus-reviewed + you approve.** Business-approved test path: deploy this branch to the prod droplet pointed at a **staging Neon-branch** DB (branched off prod) via the Deploy workflow (`workflow_dispatch`); quantify prod loss (`count(*)` on `CargoItem`/`LegCargo`/`QuoteCargoLine`) before the real cutover.
