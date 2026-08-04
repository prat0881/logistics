# Stage 4 · Charge Configuration & Warehouse Attribution — Design

> **Status:** design of record (brainstorm complete, 2026-08-04). A Stage-4 enhancement adding the pre-distribution **charge configuration** and **warehouse attribution** controls to the Leg Panel. Builds on SB1–SB6 (all merged); composes with the SB6 change-order cascade.
>
> **Source requirement:** *"Stage 4 · Section 4.7.1.3 — Charge Configuration & Warehouse Attribution"* (business PRD, provided 2026-08-04). That PRD uses a newer master-PRD section scheme that does **not** match this repo's docs — see §2 for the mapping. Where the PRD and a locked decision in this doc disagree, **this doc wins** (the deviations are recorded in §13).
>
> **Implementation plan:** to be written next under `docs/plans/stage-4/Stage 4 - Charge Configuration & Warehouse Attribution - Implementation Plan.md`.

---

## 1. Purpose & scope

Before an RFQ is distributed, the Logistics Executive today has **no control** over which charge lines the assigned Freight Forwarder(s) see and must price — the set is derived purely from the leg's freight mode via hardcoded presets ([ff-portal.service.ts:57](apps/api/src/modules/ff-portal/ff-portal.service.ts)). This enhancement gives the Executive two per-leg controls, set **before FF selection** and **locked at Distribute**:

1. **Configure charges** — a popover multi-select of *optional* charge lines (drawn from a per-mode catalogue), on top of always-present **fixed cores**. Every selected line becomes **mandatory-to-price** on the FF portal.
2. **Warehouse Handling Included** — a Yes/No toggle (Road legs touching a warehouse only) deciding **which single leg** carries the warehouse-handling cost, removing today's double-count.

**In scope:** a seeded **charge-line master table** (`ChargeLineDefinition`) that catalogues *every* current portal charge per mode; per-leg selection + warehouse-decision persistence; resolve-and-freeze of the effective set at distribute; portal seeding + submit-gate driven off that frozen set; warehouse single-leg attribution + its distribution gates; locking via the SB6 change-order cascade; the Leg-Panel UI.

**Out of scope (see §13, §16):** the **admin CRUD screen** for the catalogue (the master table is built and seeded now; CRUD is a later, separate build — the Executive cannot add lines in this build); **tag-driven activation from cargo reference tags** (the two-gate rule in the PRD is deferred — this build has *one* gate: Executive selection); richer admin modelling of **structural charge parameters** (trucking type/basis, warehouse window stay code enums).

---

## 2. Section-number mapping (PRD → repo)

The source PRD's `§4.x` numbers are from a newer master PRD and are **not** present in this repo. By content they map to our [Functional Spec](docs/Stage%204%20-%20RFQ%20Send%20to%20Freight%20Forwarder%20(v2)%20-%20Functional%20Spec.md):

Referenced repo docs: `docs/Stage 4 - RFQ Send to Freight Forwarder (v2) - Functional Spec.md` and `docs/Stage 4 - Sub-build 6 - Change-Order Cascade - Design.md`.

| PRD ref | This repo |
|---|---|
| §4.7.1 Leg Panel · §4.7.1.3 (this feature) | Query Workspace Leg Panel — [LegPanel.tsx](apps/web/src/features/rfq-workspace/LegPanel.tsx) |
| §4.7.1.1 distribution readiness | Functional Spec §10.1 — `validateLegForDistribution` ([rfq.service.ts:257](apps/api/src/modules/rfq/rfq.service.ts)) |
| §4.7.1.2 leg status lifecycle | Functional Spec §9.2 — leg status enum + machines |
| §4.8.6.2 / §4.8.7.3 / §4.8.8.3 Road/Air/Sea portal | [ff-portal.service.ts](apps/api/src/modules/ff-portal/ff-portal.service.ts) + `apps/web/src/features/ff-portal/*` |
| §4.8.14 Submit gate | Functional Spec §10.4 Q1 — `validateQuote` ([quote-engine.ts:38](packages/shared/src/quote-engine.ts)) |
| §4.8.10 reference tags | Stage-3 cargo `referenceTags` — display-only; **no** pricing role (kept as-is, see §13) |
| "Appendix A / parked change-order" | SB6 change-order cascade (Sub-build 6 Design) |

---

## 3. Background — what exists today (and is being replaced)

**Charge lines are hardcoded, per-quote, mode-derived.**

- Air/Sea lines come from two compile-time arrays — `AIR_CHARGE_PRESETS` (13 lines) / `SEA_CHARGE_PRESETS` (11 lines), spanning **three** zones ORIGIN / MAIN_FREIGHT / DESTINATION ([quote.ts:56](packages/shared/src/quote.ts)). Road has **no** charge lines — it prices `TruckingCharge` blocks only.
- The portal seeds `mode → preset list` at load ([ff-portal.service.ts:57](apps/api/src/modules/ff-portal/ff-portal.service.ts)); the FF fills amounts; rows materialise into `ChargeLine` at submit ([ff-portal.service.ts:220](apps/api/src/modules/ff-portal/ff-portal.service.ts)).
- The submit gate **Q1** forces **every** mode preset to be priced ([quote-engine.ts:48](packages/shared/src/quote-engine.ts)) — all-or-nothing, no Executive-chosen subset. (Amount `0` is already accepted — `amount != null`.)

**Warehouse handling** is a separate model: `WarehouseStagingLine` (quote-owned; `amount`, `cargoAcceptanceWindow`, `position`) ([schema.prisma:280](prisma/schema.prisma)), positioned ORIGIN/DESTINATION by `classifyWarehousePositions` ([quote-engine.ts:113](packages/shared/src/quote-engine.ts)). When **different FFs** cover the two legs sharing a warehouse, each FF's scope independently classifies it and **both** are asked to price it — the double-count this feature removes.

**Instance models (unchanged in shape, extended in §5):** `ChargeLine` ([schema.prisma:243](prisma/schema.prisma)), `TruckingCharge` ([schema.prisma:262](prisma/schema.prisma)), `WarehouseStagingLine` ([schema.prisma:280](prisma/schema.prisma)).

**Reference tags** — `ReferenceTag {HEAVY, FRAGILE, NON_STACKABLE, OUT_OF_GAUGE}` on `CargoItem.referenceTags`; **DG is a separate `isDangerous` boolean**, not a tag ([schema.prisma:417](prisma/schema.prisma)). Today these are display-only icons and drive no pricing. **They stay exactly as-is** (see §13).

---

## 4. Design overview & principles

1. **One master table for the whole catalogue.** Every charge the FF portal shows — Air/Sea zone lines (all three zones), Road trucking, Road optional lines, warehouse handling — is a row in a new seeded `ChargeLineDefinition`. This is the single source the future admin screen will CRUD. The hardcoded `AIR_CHARGE_PRESETS` / `SEA_CHARGE_PRESETS` arrays are **fully retired**.
2. **Two orthogonal axes on each definition** — `role` (when/how it's included: CORE / STANDARD / TAG_DRIVEN / WAREHOUSE) and `inputType` (how it's priced: PLAIN / TRUCKING / WAREHOUSE_STAGING). This lets one flat table hold structurally different charges without losing their fields.
3. **Selection is per-leg, empty by default**, shared across every FF on that leg (never per-FF).
4. **Resolve-and-freeze at distribute** — mirrors the existing manifest-snapshot pattern ([manifest.ts:26](apps/api/src/modules/rfq/manifest.ts)). The effective line set is frozen into the quote at distribute; the FF portal reads only the frozen set; the SB6 re-freeze recomputes it on a change-order.
5. **Zero silent behaviour change to reference tags or the SB6 mediator mechanics** — this feature *registers* new RfqDefining inputs with SB6; it does not alter the cascade engine.

---

## 5. Data model

### 5.1 New — `ChargeLineDefinition` (seeded master; future admin-CRUD target)

```
model ChargeLineDefinition {
  id         String              @id @default(cuid())
  key        String              @unique          // stable seed key, e.g. AIR_DEST_THC, ROAD_TAG_FRAGILE
  mode       FreightMode                           // ROAD | AIR | SEA
  role       ChargeLineRole                        // CORE | STANDARD | TAG_DRIVEN | WAREHOUSE
  inputType  ChargeLineInputType @default(PLAIN)   // PLAIN | TRUCKING | WAREHOUSE_STAGING
  zone       ChargeZone?                           // ORIGIN|MAIN_FREIGHT|DESTINATION for Air/Sea; null for Road
  tagKey     String?                               // RESERVED / inert this build (see §13); ReferenceTag value or "DG"
  label      String
  sortOrder  Int
  isActive   Boolean             @default(true)    // soft-hide; inactive rows never seed to a leg
  selections LegChargeLineSelection[]
  @@index([mode, role, isActive])
}

enum ChargeLineRole      { CORE STANDARD TAG_DRIVEN WAREHOUSE }
enum ChargeLineInputType { PLAIN TRUCKING WAREHOUSE_STAGING }
```

- `role` decides inclusion: **CORE** always; **STANDARD**/**TAG_DRIVEN** only if the Executive selects it (both are Executive-selected in this build — see §13); **WAREHOUSE** only via the per-leg toggle (§9), never the popover.
- `inputType` decides the portal widget and which instance table stores the price.
- `tagKey` is **populated but inert** — reserved for the future cargo-tag gating; nothing reads it for activation now.

### 5.2 New — `LegChargeLineSelection` (Executive's picks; empty by default)

```
model LegChargeLineSelection {
  id           String  @id @default(cuid())
  legId        String
  definitionId String
  leg          Leg                  @relation(fields: [legId], references: [id], onDelete: Cascade)
  definition   ChargeLineDefinition @relation(fields: [definitionId], references: [id])
  @@unique([legId, definitionId])
}
```
Only rows for `role ∈ {STANDARD, TAG_DRIVEN}` are ever created — CORE/WAREHOUSE are not "selected".

### 5.3 `Leg` — one new column

```
warehouseHandlingIncluded  Boolean?   // null = undecided · true = this leg carries it · false = not this leg
```
Tri-state; `null` forces an explicit decision at distribute (§10).

### 5.4 `Quote` — one new column (the frozen snapshot)

```
chargeConfigSnapshot  Json?   // frozen at distribute — see §7
```
Shape:
```jsonc
{
  "lines": [ { "definitionKey": "AIR_DEST_THC", "role": "STANDARD", "inputType": "PLAIN",
               "zone": "DESTINATION", "label": "Destination THC / Airport Handling" }, ... ],
  "warehouseIncluded": true
}
```
`lines` is the full mandatory-to-price set (cores + Executive-selected). Cores are included here too, so the portal reads one self-contained list and is immune to later catalogue edits.

### 5.5 Instance-model changes (small, additive)

- **`ChargeLine`**: add `definitionKey String?`; make **`zone ChargeZone?` nullable** (Road configured lines have `zone = null`). `presetKey` retained (an FF `[+ Add Charge]` line = both `definitionKey` and `presetKey` null).
- **`TruckingCharge`**, **`WarehouseStagingLine`**: add `definitionKey String?` (the CORE trucking key / the WAREHOUSE key). Otherwise unchanged — **warehouse fields (`amount`, `cargoAcceptanceWindow`) stay exactly as today.**
- **`QuoteDraftCharge`** ([quote.ts:27](packages/shared/src/quote.ts)): `zone: ChargeZone | null`; add `definitionKey?: string | null`, `role?: ChargeLineRole`.

---

## 6. Charge-line catalogue — the seed (authoritative)

The seed reproduces **today's full per-mode portal line-up** (so nothing regresses) *plus* the new Road optional lines and per-mode tag-driven lines, *minus* three retired destination lines that are seeded **`isActive = false`** (kept for the future admin screen). A seed-regression test (§15) locks this.

| Mode | CORE (always priced) | STANDARD (opt-in) | TAG_DRIVEN (opt-in) | WAREHOUSE | Inactive (seeded, hidden) |
|---|---|---|---|---|---|
| **Air** | *Z1 Origin:* Export Clearance · Documentation · Origin THC/Airport Handling · Security/Screening · Warehouse/Pre-storage at OAP · *Z2 Main:* Air Freight · Security Exchange (SEC) · Carrier Surcharge · Heavy Weight Surcharge | Dest THC/Airport Handling · Import Customs Clearance · Storage — 1 Free Day | Non-stackable · Fragile · DG · OOG · Heavy | — | Last Mile Handling / Lift Gate |
| **Sea** | *Z1 Origin:* Export Clearance · Documentation · Origin THC · Bill of Lading · Warehouse Charges · *Z2 Main:* Sea Freight | Dest THC/Handling · Import Customs Clearance · Storage — 1 Free Day | Non-stackable · Fragile · DG · OOG · Heavy | — | Delivery (Door-to-Door) · Last Mile Handling / Lift Gate |
| **Road** | Road Trucking *(inputType TRUCKING; per pickup/drop endpoint)* | Tail-lift/lift-gate · T1 document · Other documents · Re-packing · Weekend/Weekday surcharge · Surcharges (general) · Insurance · Extra waiting time | Non-stackable · Fragile · DG · OOG · Heavy | Warehouse handling *(inputType WAREHOUSE_STAGING; toggle-gated)* | — |

Notes:
- **Zones 1–2 = cores** (PRD call: Zone 1 = Origin, Zone 2 = Main Freight). Air/Sea **Destination** zone becomes opt-in — an Executive who selects nothing gets cores only.
- **Heavy is intentionally in two places** on Air: the CORE "Heavy Weight Surcharge" (airline weight surcharge) and the TAG_DRIVEN "Heavy" handling line — kept distinct per decision.
- Existing `presetKey` values are reused as `key`s for the Air/Sea rows to ease migration; Road + tag-driven rows get new keys.

---

## 7. Resolve-and-freeze at distribute

At `performDistribution` ([rfq.service.ts](apps/api/src/modules/rfq/rfq.service.ts)), alongside `buildManifestSnapshot`, each quote gets its `chargeConfigSnapshot`:

```
resolve(leg):
  cores      = ChargeLineDefinition where mode = leg.mode AND role = CORE AND isActive
  selected   = definitions joined via LegChargeLineSelection[leg]   // role ∈ {STANDARD, TAG_DRIVEN}, isActive
  lines      = cores ++ selected                                    // all mandatory-to-price
  warehouseIncluded = (leg.warehouseHandlingIncluded === true)
  freeze { lines, warehouseIncluded } → Quote.chargeConfigSnapshot
```

- **No tag filtering** (deferred — §13): a selected TAG_DRIVEN line is included unconditionally, exactly like a STANDARD line.
- **Idempotent on re-distribute / SB6 re-freeze:** the same resolve runs when a change-order re-freezes the leg, so charge/warehouse edits propagate for free (§11).

---

## 8. FF portal — seeding & submit gate

### 8.1 Seeding ([ff-portal.service.ts:54](apps/api/src/modules/ff-portal/ff-portal.service.ts))

`seededCharges` is built from `quote.chargeConfigSnapshot.lines` instead of the hardcoded mode presets:
- `inputType = PLAIN` → a plain seeded charge (`amount: null`). Air/Sea lines carry their `zone`; **Road lines carry `zone = null`** and render in a **new Road charges panel** (Road had none before).
- `inputType = TRUCKING` → the existing Road trucking blocks (per endpoint) — unchanged.
- `inputType = WAREHOUSE_STAGING` → seeded **only if `warehouseIncluded`** (§9); unchanged fields.
- The FF `[+ Add Charge]` capability is preserved (Air/Sea zones as today; extended to the Road panel).

### 8.2 Submit gate — Q1 rewrite ([quote-engine.ts:47](packages/shared/src/quote-engine.ts))

The mandatory-to-price set is no longer "all mode presets" — it is the frozen `lines`:
```
Q1:  every PLAIN line in chargeConfigSnapshot.lines must have amount != null   (0 allowed)
     every TRUCKING block must have amount != null                             (unchanged)
Q8:  warehouse staging must be priced iff warehouseIncluded                    (was: every warehouse endpoint)
```
FF-added custom lines (`definitionKey == null`) are **not** mandatory. `computeQuoteTotals` gains a bucket for `zone == null` (Road) charges, added to `grandTotal`.

---

## 9. Warehouse attribution

- **Field:** `Leg.warehouseHandlingIncluded` (§5.3). **Visible only** on **Road** legs (PRD call: warehouse endpoints are always Road) whose pickup **or** drop point `type == WAREHOUSE` ([schema.prisma:441](prisma/schema.prisma)). The Leg Panel already receives `leg` + `points`, so detection needs no backend change.
- **One warehouse → one leg:** a warehouse that is the **drop of leg X and pickup of leg Y** (shared hub) may have **at most one** of {X, Y} set to Yes. Adjacency is computed from shared point ids — the route engine already builds this (`incomingByPoint`/`outgoingByPoint`, [route.ts:171](packages/shared/src/route.ts)). A **terminal** warehouse (touched by one leg only) is a plain Yes/No.
- **Effect:** the `WarehouseStagingLine` is seeded/priced **only for the Yes leg's FF**; the No leg gets none. This **replaces** the old `classifyWarehousePositions`-driven dual-leg placement for *deciding which legs get a line* (position may still label In/Out, but it no longer gates presence).
- **Default `null`** (undecided) — the Executive must choose; the UI may pre-suggest from `classifyWarehousePositions` but does not auto-commit.

---

## 10. Distribution validation gates

Extend `validateLegForDistribution` ([rfq.service.ts:257](apps/api/src/modules/rfq/rfq.service.ts)) — the single choke point all distribute paths call:

| Gate | Rule | Result |
|---|---|---|
| **F7 — warehouse completeness** | leg touches a warehouse but `warehouseHandlingIncluded is null` | **block** |
| **F8 — no duplicate Yes** | leg is Yes **and** its warehouse-sibling leg is also Yes | **block** (also enforced on write, §11) |

No completeness gate on charge selection — an **empty selection is valid** (cores still price). F1–F6 are unchanged.

---

## 11. Locking & change-order integration (RfqDefining)

Per decision, post-distribute edits to charge selection or the warehouse toggle route through the **SB6 change-order cascade** (they are **RfqDefining**):

- **Impact map:** register `warehouseHandlingIncluded` (a `Leg` field) and the **charge-selection change** in [leg.impact.ts](apps/api/src/modules/legs/leg.impact.ts) as **RfqDefining**. Pre-distribute → free edit; post-distribute (leg `RFQ_SENT`+) → mediator: preview (invalidating/refreshing quotes) → confirm + reason → invalidate quotes → reopen leg → **re-freeze snapshot (§7)** → notify.
  - *Wiring note:* the selection lives in a join table, not a scalar `Leg` field. The SB6 classifier is field-based, so the write path must present a selection change as an RfqDefining leg-level action (either a synthetic `chargeSelection` field on the leg save-input, or a dedicated mediated action). Exact hook = an implementation-plan decision; it must not bypass the mediator while the leg is distributed.
- **On-write guards (pre-distribute):** setting a second Yes for the same warehouse → `422` (mirrors F8).
- **Executive UI:** the popover + toggle render **read-only** once leg status ≥ `RFQ_SENT`, mirroring the frozen `FfSelectionGrid` pattern.

---

## 12. UI / UX

### 12.1 Leg Panel ([LegPanel.tsx](apps/web/src/features/rfq-workspace/LegPanel.tsx)) — controls sit **above** FF selection

- **"Configure charges"** control → popover with **one dropdown, two headed sections**: **Standard** and **Tag-driven** (multi-select checkboxes, filtered to the leg's mode, **empty by default**), plus a **read-only "Fixed cores" note** listing the mode's CORE lines. **No "Add charge line"** control (admin-only, later).
- **"Warehouse Handling Included"** Yes/No — rendered only on warehouse-touching Road legs, with an inline "one leg per warehouse" hint; the sibling leg's control reflects the mutual-exclusion lock.
- **Summary chips**: *N charges configured* · *Warehouse: Yes/No*. Both controls read-only after Distribute.

### 12.2 FF portal (`apps/web/src/features/ff-portal/*`)

- **New Road charges panel** for `zone = null` configured lines (plain amount + note). Air/Sea: cores + configured destination lines, all mandatory-to-price. Warehouse staging shown only on the Yes leg. `[+ Add Charge]` preserved.

---

## 13. Deviations from the PRD & deferred items

| Item | PRD says | This build | Why |
|---|---|---|---|
| **Tag-driven activation** | Two gates: Executive selects **and** a package on the leg carries the matching tag (§4.8.10) | **One gate** — Executive selection only; **no** connection to cargo reference tags | Explicit decision; keeps reference tags untouched and removes the distribute-time activation path. `tagKey` reserved for the future feature |
| **"Add charge line"** (system-wide) | Executive adds lines inline from the popover | **Not built** — catalogue is seeded, read-only to the Executive | Becomes an **admin** config screen later; master table is built now so that work reuses it |
| **Retired destination lines** | (implicitly dropped from catalogue) | Seeded **`isActive = false`** (Air Last-Mile; Sea Delivery + Last-Mile) | Preserves them for admin re-enable without a migration |
| **Structural params** | — | Trucking type/basis + warehouse window stay **code enums**; one minimal catalogue row each | YAGNI; richer admin editors deferred |

---

## 14. Migration & rollout

- **New:** `ChargeLineDefinition`, `LegChargeLineSelection` tables; `ChargeLineRole` / `ChargeLineInputType` enums; `Leg.warehouseHandlingIncluded`; `Quote.chargeConfigSnapshot`; additive `definitionKey` on the three instance models; `ChargeLine.zone` → nullable.
- **Seed** `ChargeLineDefinition` (all modes; the three retired lines inactive). Retire `AIR_CHARGE_PRESETS` / `SEA_CHARGE_PRESETS`.
- **Backfill:** Stage 4 is **not yet live**, so there are no in-flight distributed quotes to migrate. If `chargeConfigSnapshot` is null on an already-sent quote, the portal yields **empty seeding** (`{ lines: [], warehouseIncluded: false }`) — there is no legacy-preset fallback (the `AIR_CHARGE_PRESETS` / `SEA_CHARGE_PRESETS` are retired). This is safe precisely because Stage 4 has no pre-feature distributed quotes and the go-live runbook applies this migration **before** any distribution.

---

## 15. Testing strategy

- **Unit (shared):** seed-regression — the seed reproduces today's per-mode line-up (3 rows inactive); Q1 mandatory set = cores + selected (0 allowed, custom lines optional); Road `zone = null` totals bucket; warehouse Q8 gated by `warehouseIncluded`.
- **Unit (warehouse):** shared-hub detection; mutual-exclusion (second Yes rejected); terminal-warehouse Yes/No.
- **Integration (api):** distribute freezes `chargeConfigSnapshot` (cores + selected, no tag filtering); portal seeds from the snapshot; submit enforces the frozen mandatory set; F7/F8 block distribution; SB6 change-order re-freezes on a post-distribute edit.
- **E2E:** Executive configures lines + warehouse toggle (above FF selection) → distribute → FF sees exactly cores + configured (+ warehouse on the Yes leg) → prices → submit passes; distribution blocked when a warehouse leg is undecided.

---

## 16. Open items / future work

1. **Admin catalogue CRUD** — the screen that manages `ChargeLineDefinition` (labels, `isActive`, sort, and eventually `tagKey` wiring). Separate build.
2. **Tag-driven ↔ reference-tag activation** — wire `tagKey` to cargo `referenceTags` (+ DG) as the PRD's gate 2. Will also revisit folding **DG into `ReferenceTag`** (a Stage-3 change).
3. **Structural charge admin** — richer editors for trucking (type/basis) and warehouse (window) parameters.
