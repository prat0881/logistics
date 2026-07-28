# Stage 4 · Sub-build 4 — Decomposition & Sub-build 4a Design

> Design of record for **SB4 (FF Portal + quoting)** decomposition and the first slice, **SB4a**. The authoritative *what/how* remains the Functional Spec (§7.3–§7.4, §8 S12–S13, §9.1, §10.4) and the Technical Design (§4 data model, §5.2 endpoints, §6 engine, §7 extensibility, §8.1 token auth, §9.5 portal, §11 deployment, §12 open items). This doc only records the **decomposition** and the **SB4a slice boundary + concrete decisions**; it does not re-derive the locked design.

## SB4 decomposition (confirmed — 3-way, mirrors SB2a/2b + SB3)

SB4 builds the external, no-login FF portal where an invited freight forwarder reviews their scoped RFQ and enters a quote. It is large and fully pre-designed, so it ships as three reviewable sub-builds:

- **SB4a — Quote data model + `§6` engine** *(this doc; backend + shared, no HTTP, no UI)*: the 5 pricing child tables + `Quote` pricing columns + new enums + the migration (add tables, **drop** the 4 O-S4-3 null columns) + the pure `packages/shared/src/quote` chargeable-weight / totals / validation engine + reference data (density factors, charge-line presets). Unit-tested; no HTTP.
- **SB4b — FF Portal backend**: the `RfqTokenGuard` + the token-scoped `/ff/*` boundary + endpoints (`GET /ff/rfq/:token` resolve-scope, `PATCH /ff/rfq/:token/quotes/:legId` draft-save, `POST /ff/rfq/:token/quotes/:legId/submit`) + preset seeding on load + the submit orchestration (`§6` validate → persist pricing → fire quote `SUBMIT` via `StatusService.fire` after the tx) + e2e (unauthenticated, scope-isolation, expired-deadline). Headless.
- **SB4c — FF Portal frontend**: the public `/ff/rfq/:token` route (no auth, no `AppLayout`) + `PortalShell` + per-leg sections (cargo manifest, density/chargeable grid, Air/Sea charge zones / Road trucking blocks / warehouse staging, transit plan) + `SubmissionBar` (DG note, T&C, Save Draft, Submit) + the `§6` engine running client-side (live recalc) + terminal states (expired-link, already-submitted, invalid-token).

**Deferred to a later polish pass** (design-included but non-critical-path): PDF download (`RfqPdfService`, §8.4 / §13.2), the scoped route diagram (§7.3.4 / §9.5 `ScopedRouteDiagram`), and the FF read-only quote Preview (§7.4.7). Recorded so they are not lost.

**Out of SB4 entirely** (later sub-builds, per the roadmap): reminders/expiry scheduler + emails (SB5); the change-order cascade (SB6).

---

## SB4a — scope

**Goal:** the persistence + pure computation foundation for FF quoting — every table a quote's pricing lands in, and the one isomorphic engine that computes chargeable weight, totals, and submit-validation findings. No endpoints, no guard, no UI (those are SB4b/4c).

### 1. Prisma — five pricing child tables (Technical Design §4.2)

All carry `id uuid`, nullable `tenantId`, `createdAt`/`updatedAt` (Stage-3 convention). FK to `Quote` is `onDelete: Cascade` (a quote owns its pricing; a change-order sets `Quote.status = INVALID` but keeps the rows — §4.3.4 — so cascade only fires on a genuine quote delete, which only happens to a still-`SELECT` quote that has no pricing yet).

| Table | Columns (beyond id/tenantId/timestamps) | Constraints |
|---|---|---|
| **QuoteCargoLine** | `quoteId` FK, `cargoItemId` FK, `freightDensity Decimal(12,3)`, `chargeableWeightT Decimal(12,3)` | `@@unique([quoteId, cargoItemId])`; `@@index([quoteId])` |
| **ChargeLine** | `quoteId` FK, `zone ChargeZone`, `label String`, `isPreset Boolean`, `presetKey String?`, `amount Decimal(14,2)`, `note String?`, `sortOrder Int` | `@@index([quoteId])` (Air/Sea only) |
| **TruckingCharge** | `quoteId` FK, `legEndpointPointId` FK→`Point`, `truckingType TruckingType`, `basis TruckingBasis`, `amount Decimal(14,2)`, `remarks String?` | `@@index([quoteId])`; `legEndpointPointId onDelete: Restrict` |
| **WarehouseStagingLine** | `quoteId` FK, `warehousePointId` FK→`Point`, `position WarehousePosition`, `label String`, `isPreset Boolean`, `amount Decimal(14,2)`, `note String?`, `cargoAcceptanceWindow String?` | `@@index([quoteId])`; `warehousePointId onDelete: Restrict` |
| **TransitPlan** | `quoteId` FK **@unique** (1:1), `carrier String?`, `flightVoyageNo String?`, `departureDate DateTime`, `arrivalDate DateTime`, `carrierSurcharge Decimal(14,2)?`, `guaranteedTransitDays Int?` | `@@unique([quoteId])` |

> `Point` is the Stage-3 point entity (pickup/delivery/warehouse). `TruckingCharge.legEndpointPointId` and `WarehouseStagingLine.warehousePointId` reference it. Both use `onDelete: Restrict` (a priced point must not vanish under a quote); guard the FK in the service (P2003 is unmapped, per convention) when SB4b writes them.

### 2. `Quote` — new pricing columns

Add to the existing `Quote` model: `totalChargeableWeightT Decimal(12,3)?`, `grandTotal Decimal(14,2)?`, `dgSurchargeNote String?`, `termsConditions String?`, plus back-relations `quoteCargoLines`, `chargeLines`, `truckingCharges`, `warehouseStagingLines`, `transitPlan TransitPlan?`. All nullable — populated on submit (§4.5: persisted on submit for a stable Stage-5 record).

### 3. New enums (Prisma enum **+** mirrored `@svyft/shared` const-object)

Follow the settled shared-enum pattern (a `const` object + a union type + `Object.values as [X, ...X[]]`, pinned by a `toEqual` test — never a TS `enum`), each mirrored by a matching Prisma `enum` in `schema.prisma`:

- `ChargeZone` = `ORIGIN | MAIN_FREIGHT | DESTINATION`
- `TruckingType` = `DEDICATED | GROUPAGE`
- `TruckingBasis` = `PER_TRUCK | PER_CBM | PER_TON | FIXED`
- `WarehousePosition` = `ORIGIN | DESTINATION`

### 4. Migration (`prisma migrate dev --name add_quote_pricing`)

Additive **and** a drop:
- **Add** the 4 enums + 5 tables + the `Quote` columns.
- **Drop** the four superseded O-S4-3 columns (all null in every Stage-3 row → non-destructive, §4.3.1): `CargoItem.freightDensity`, `CargoItem.chargeableWeight`, `Leg.totalChargeableWeight`, `LegCargo.manifestSnapshot`.
- **Fix the fixtures/tests that reference the dropped columns** — the SB4 foundation scan found only test-only references (mocks setting them to `null` in a few web + api specs). Remove those keys in the same task so typecheck/tests stay green. `LegCargo.manifestSnapshot` is read nowhere.

> ⚠ Prod pre-flight (carried): the drop is non-destructive on any Stage-3 data, but `prisma migrate deploy` runs on push to `main` (CD). No orphan check needed for a column drop; the columns are unconditionally null.

### 5. The pure `§6` engine — `packages/shared/src/quote/`

Isomorphic, no Nest/DB deps (mirrors the Stage-3 route-validation engine). Operates on a shared **`QuoteDraft`** shape — the single input SB4b persists-from (authoritative) and SB4c holds in form state (live), so there is **zero drift** (§6.3):

```
QuoteDraft = {
  legId, mode: FreightMode | null, currency: string | null,
  quoteValidityUntil: string | null,       // ISO
  cargo: { cargoItemId, grossWtT: number, cbm: number, isDangerous: boolean, freightDensity: number | null }[],
  charges: { zone: ChargeZone, presetKey: string | null, label: string, amount: number | null, note?: string }[],
  trucking: { legEndpointPointId, truckingType, basis, amount: number | null, remarks?: string }[],
  warehouse: { warehousePointId, position: WarehousePosition, label, amount: number | null, cargoAcceptanceWindow?: string }[],
  transit: { departureDate: string | null, arrivalDate: string | null, ... } | null,
  dgSurchargeNote: string | null, termsConditions: string | null,
}
```
*(Exact field set finalized in the plan; the tables in §1 are the source of truth.)*

Functions:
- `computeChargeableWeight(grossWtT: number, cbm: number, densityKgPerCbm: number): number` = `max(grossWtT, cbm × density / 1000)` (§6.1; density kg/CBM → cbm×density is kg → /1000 is tonnes).
- `computeQuoteTotals(draft: QuoteDraft): { zoneSubtotals: { origin, mainFreight, destination }, truckingSubtotal, warehouseSubtotal, totalChargeableWeightT, grandTotal }` (§6.1, §7.4.6). Road-only legs sum trucking (+ warehouse) into the grand total; Air/Sea sum the zones (warehouse staging folds into origin/destination per §7.4.3.3).
- `validateQuote(draft: QuoteDraft, deadline: string, now: string): Finding[]` — spec §10.4 **Q1–Q8**, emitting the same `Finding[]` (`{ rule, severity, scope, message }`) shape as the Stage-3 route engine (§5.3), so portal + workspace render through one path:
  - **Q1** every mandatory charge line for the leg's mode is priced (Air §7.4.3.1 / Sea §7.4.3.2 preset lines; amount may be 0 with a note); **Q2** density on every cargo row; **Q3** validity ≥ deadline; **Q4** currency set; **Q5** DG surcharge note if any assigned row is DG; **Q6** transit departure + arrival dates; **Q7** not past deadline; **Q8** warehousing (in/out) priced for every warehouse endpoint.
- `classifyWarehousePositions(...)` — §6.4 inference: build the FF's assigned-leg subgraph (reuse the Stage-3 routing primitives in `@svyft/shared`), order it, classify each warehouse node as `ORIGIN` (before this FF's main carriage) or `DESTINATION` (after). Unit-tested alongside the engine.

### 6. Reference data (shared const)

- `FREIGHT_DENSITY_FACTORS: Record<FreightMode, number>` = `{ AIR: 167, SEA: 1000, ROAD: 333 }` kg/CBM (spec **S12**). Seeds `QuoteCargoLine.freightDensity` in the portal (labelled "default", editable).
- `AIR_CHARGE_PRESETS` / `SEA_CHARGE_PRESETS`: `{ zone: ChargeZone, presetKey: string, label: string }[]` — the mandatory lines from spec §7.4.3.1 / §7.4.3.2, in order:
  - **Air · Origin:** Export Customs Clearance · Documentation Charges · Origin THC / Airport Handling · Security / Screening Charges · Warehouse / Pre-storage at OAP
  - **Air · Main Freight:** Air Freight Charges · Security Exchange (SEC) · Airline / Carrier Surcharge · Heavy Weight Surcharge
  - **Air · Destination:** Destination THC / Airport Handling · Import Customs Clearance · Last Mile Handling / Lift Gate · Storage 1 Free Day Charges
  - **Sea · Origin:** Export Customs Clearance · Documentation Charges · Origin THC (Terminal Handling Charge) · Bill of Lading · Warehouse Charges
  - **Sea · Main Freight:** Sea Freight Charges
  - **Sea · Destination:** Destination THC / Handling Charges · Import Customs Clearance · Delivery (Last Mile — Door to Door) · Last Mile Handling / Lift Gate · Storage 1 Free Day Charges
  - `presetKey` is a stable slug (e.g. `AIR_ORIGIN_EXPORT_CLEARANCE`); Q1 validation matches on `presetKey`. Warehouse staging preset = a single "Warehousing (In / Out)" line per warehouse endpoint (§7.4.3.3).

### 7. Tests

- **Shared unit tests** (`packages/shared/src/quote/*.test.ts`): `computeChargeableWeight` (gross-wins / volumetric-wins / per-mode density); `computeQuoteTotals` (Air/Sea zone subtotals, Road-only trucking grand total, warehouse fold-in); `validateQuote` Q1–Q8 (each rule fires + passes); `classifyWarehousePositions` (contiguous + non-contiguous chains); enum `toEqual` pins; preset-list shape pins.
- **API**: the migration applies + `prisma generate` succeeds + a minimal smoke that the new tables/relations exist and the dropped columns are gone (a tiny e2e or a prisma-level check; MUST `await app.close()` if it boots `AppModule`). No portal HTTP (SB4b).

### 8. Concrete decisions (locked for the plan)

- **Decimals:** money (`amount`, `grandTotal`, `carrierSurcharge`) `@db.Decimal(14,2)`; density + weights `@db.Decimal(12,3)` (matches the dropped columns' precision). Serialize Decimal→string in any DTO (Stage-3 convention).
- **`QuoteDraft` lives in `@svyft/shared`** — one engine, server-authoritative (SB4b) + client-live (SB4c), no drift (§6.3).
- **Enums:** Prisma enum + shared const-object mirror + `toEqual` pin (never a TS `enum`).
- **Engine is pure** (no Nest, no Prisma) so it unit-tests in `@svyft/shared` and imports cleanly on both sides.
- **Deferred:** PDF (§8.4), scoped route diagram (§7.3.4), FF Preview (§7.4.7) — not SB4a, not SB4b/4c's critical path.

## Build workflow

`superpowers:writing-plans` (this doc + Technical Design §4/§6 + spec §7.4/§8/§10.4 are the inputs) → `superpowers:subagent-driven-development` (fresh implementer per task, TDD, per-task spec+quality review, **opus** whole-branch review) → PR `feat/stage-4-sb4a` → `main`. Worktree already set up; baseline green (shared 186 + api rfq e2e 23).
