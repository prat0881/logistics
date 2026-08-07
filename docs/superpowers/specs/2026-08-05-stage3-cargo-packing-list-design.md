# Stage 3 — Cargo Details: Packing List Entry — Design

> **Status:** Draft for review · **Date:** 5 August 2026
> **Source requirement:** `Stage 3 - Cargo Details - Packing List Entry (PRD Section).docx` (business PRD).
> **Companions:** `docs/Stage 3 - Create Query - Functional Spec.md` (behaviour), `docs/Stage 3 - Technical Design.md` (how Stage 3 is built), `docs/Stage 3 - Session Handoff.md` (decision log).
> **This document is the source of truth for the Cargo re-model.** It supersedes the flat `CargoItem` cargo model for Stage 3 going forward.

---

## 1. Purpose

A logistics executive types real measurements — weight, dimensions — for each **package**. The system totals everything automatically. Dangerous-goods and handling characteristics surface everywhere they are relevant. One data entry — a single **cargo → package → item** popup — drives the whole packing list: every package and its contents, entered once.

This design replaces the current **flat, single-level `CargoItem`** (one row conflates package + one product + one customs line) with a **three-level hierarchy**:

```
Query ──1:N──▶ Cargo ──1:N──▶ Package ──1:N──▶ Item
               (PO/Ref grouping)  (freight unit)   (commercial/customs unit)
```

- **Cargo** — a PO/reference grouping. The row you see on the Cargo Details table. Owns the unit selectors and derives the header totals.
- **Package** — the physical handling/freight unit (Box, Pallet, Crate, …). The unit of representation **everywhere else in the system** (legs, RFQ, quotes, roll-ups). Sole source of weight and volume.
- **Item** — the commercial/customs unit inside a package (product, qty, HSN). A package may hold many items (many HSN codes) or none.

### 1.1 What this build delivers vs defers

| Delivered now                                                       | Deferred                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Cargo→Package→Item model + migration                                | `packageCount` **multiplier** behaviour (column reserved, parked at 1) |
| Package-grain roll-ups (derived), tag union, DG-as-tag              | Chargeable weight (Stage 4, filled by the freight forwarder)           |
| Cargo-level unit selectors, canonical cm/kg storage, kg/tonne/g     | —                                                                      |
| Nested cargo popup entry; two-level table expansion; "add N copies" | —                                                                      |
| Package↔leg mapping at package grain (today's rules)                | —                                                                      |
| HSN per item; MSDS per package (DG-triggered)                       | —                                                                      |

---

## 2. Decisions locked (this brainstorm)

Numbered for citation from the implementation plan. All confirmed with the requester.

| #       | Decision                                                                                                                                                                                                                                                 | Rationale                                                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1**  | Three levels: `Query → Cargo → Package → Item`.                                                                                                                                                                                                          | Business restructure of the flat model.                                                                                                                 |
| **C2**  | **Reuse `CargoItem` as `Package`** (rename/repurpose the existing table); add a thin `Cargo` parent and a new `Item` child.                                                                                                                              | Minimises change: `LegCargo` and `QuoteCargoLine` keep pointing at the same physical rows — now packages — so Stage‑4 joins are untouched.              |
| **C3**  | **Package is the unit of representation everywhere except the Cargo Details main table.** Main table row = a Cargo; expanding a cargo reveals its packages; expanding a package reveals its items. Edit/Remove act at the cargo level (nested popup).    | PRD §2.1 + requester direction.                                                                                                                         |
| **C4**  | **One record per physical package** (no stored multiplier). An **"add N copies"** helper clones a package into N discrete records, each with its own Package No.                                                                                         | Keeps roll-ups pure Σ and leg mapping / Package-No uniqueness meaningful.                                                                               |
| **C5**  | `packageCount` **parked**: kept as a `Package` column, default 1, **no calculation**, **not shown in UI**.                                                                                                                                               | Reserved pending business definition of "N identical packages."                                                                                         |
| **C6**  | **Unit selectors (Dimension, Weight) live on the Cargo**; values stored **canonical cm/kg** on packages (units are presentation-only, BL‑6). Weight units = **kg / tonne / g**.                                                                          | Per-cargo entry context; canonical storage keeps roll-ups pure Σ and simplifies the generated column.                                                   |
| **C7**  | **Header totals H4–H8 are derived-on-read, never stored** (count, Σgross, Σvolume, ⋃tags, chargeable=null).                                                                                                                                              | PRD §2.2 ("a stored total goes stale"); matches Technical Design §4.5 (leg roll-ups are derived, only `volumeCbm`/`dgIndicator` are stored exceptions). |
| **C8**  | **DG becomes a reference tag** (the `isDangerous` boolean is removed). Tags **union upward** (`package.tags = own ∪ ⋃ item.tags`; `cargo.tags = ⋃ package.tags`) and **cannot be cleared above** where set. `Query.dgIndicator` derives from the DG tag. | PRD BL‑3, V‑7.                                                                                                                                          |
| **C9**  | **Net weight is package-level only** (`Package.netWt`, nullable), **shown in the UI**. **V‑3 dropped** (its "Σ item net weights" premise never existed — items have no net weight). **V‑2 active**.                                                      | PRD internal inconsistency resolved; net stays where it is measured.                                                                                    |
| **C10** | **MSDS attaches per Package**, required when **any item under the package (or the package itself) carries the DG tag**. Otherwise MSDS behaves exactly as today (PDF-only, magic-byte validated, uploaded from the row).                                 | Business direction; keeps today's package-level MSDS with the DG trigger derived from the tag union (C8).                                               |
| **C11** | **PO/Reference lives on the Cargo** (one reference per grouping). No mixed references within a package.                                                                                                                                                  | Gives Cargo a clear identity; removes the PRD's "Mixed (n)" case.                                                                                       |
| **C12** | **No separate customs-form output.** Business confirmed the "customs form" meant the **cargo → package → item entry popup** (delivered here), not a generated document. HSN is still captured per item.                                                  | Clarified with business — the requirement is the structured entry, not a customs file.                                                                  |
| **C13** | **Package↔leg mapping uses today's rules at package grain** (sequential multi-leg journey; R1–R9 continuity; `cargoConflicts` re-grained to packages).                                                                                                   | Requester direction; preserves the route-validation engine.                                                                                             |
| **C14** | **Migration is the pre-go-live/test-data path** (no production cargo/quotes to preserve).                                                                                                                                                                | Confirmed with requester.                                                                                                                               |

---

## 3. Data model

### 3.1 Relationship map (delta)

```
Query ──1:N──▶ Cargo ──1:N──▶ Package(ex-CargoItem) ──1:N──▶ Item
                                     │  └── msdsFileId ──▶ FileAsset   (per package; DG-triggered)
                                     ├──◀ LegPackage  (was LegCargo)    ── unchanged FK target
                                     └──◀ QuoteCargoLine.cargoItemId     ── unchanged FK target (Stage 4)
```

`Package` **is** the row that `LegCargo` and `QuoteCargoLine` reference today (as `CargoItem`). We keep that relationship; only the entity's name and its field split change.

### 3.2 `Cargo` (new — the grouping / packing-list-section row)

| Field         | Type                            | Entry    | Notes                                         |
| ------------- | ------------------------------- | -------- | --------------------------------------------- |
| `id`          | uuid PK                         | —        |                                               |
| `tenantId`    | uuid?                           | —        | tenant-ready (repo convention)                |
| `queryId`     | uuid FK → Query                 | —        | cascade delete                                |
| `rowIndex`    | int                             | assigned | main-table order                              |
| `poReference` | text?                           | typed    | optional (PRD H1); the cargo's identity/label |
| `label`       | text?                           | typed    | optional human label                          |
| `dimUnit`     | enum `DimUnit` (CM·MM)          | selected | **entry/display only**; default CM            |
| `weightUnit`  | enum `WeightUnit` (KG·TONNE·GM) | selected | **entry/display only**; default KG            |

**Derived on read (never stored — C7):** `packageCount = COUNT(packages)`, `grossWeightKg = Σ package.grossWt`, `volumeCbm = Σ package.volumeCbm`, `tags = ⋃ package.tags`, `chargeableWeight = null`.

### 3.3 `Package` (ex-`CargoItem` — the freight unit)

Rename `model CargoItem` → `model Package`. Keep the row; change its shape.

| Field                   | Type                    | Change vs today         | Notes                                                                                                 |
| ----------------------- | ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`                    | uuid PK                 | keep                    | `LegCargo`/`QuoteCargoLine` still FK here                                                             |
| `tenantId`              | uuid?                   | keep                    |                                                                                                       |
| `queryId`               | uuid FK → Query         | **keep** (denormalised) | avoids touching queryId-scoped services; also reachable via `cargo`                                   |
| `cargoId`               | uuid FK → Cargo         | **new**                 | cascade delete                                                                                        |
| `rowIndex`              | int                     | keep                    | order within the cargo                                                                                |
| `packageNo`             | text                    | **new**                 | auto-numbered, editable, **unique per query** (V‑5)                                                   |
| `packageType`           | enum `PackageType`      | **was free-text**       | dropdown: BOX·PALLET·CRATE·CARTON·DRUM·BUNDLE                                                         |
| `dimL` `dimW` `dimH`    | Decimal(10,2)           | keep                    | **stored canonical cm** (C6)                                                                          |
| `grossWt`               | Decimal(12,3)           | keep                    | **stored canonical kg**                                                                               |
| `netWt`                 | Decimal(12,3)?          | keep                    | nullable; shown (C9)                                                                                  |
| `tags`                  | `ReferenceTag[]`        | keep + **DG added**     | own tags; unions with item tags on read                                                               |
| `msdsFileId`            | uuid FK → FileAsset?    | **keep**                | package-level MSDS; required when the package's **effective** tags include DG (F6, C10)               |
| `volumeCbm`             | Decimal(14,6) generated | **simplified**          | `GENERATED ALWAYS AS (dimL*dimW*dimH/1e6) STORED` — no `×qty`, no unit CASE (storage is canonical cm) |
| `packageCount`          | int default 1           | **new, parked**         | no calculation; not shown (C5)                                                                        |
| `createdAt`/`updatedAt` | —                       | keep                    |                                                                                                       |

**Removed from this table** (move to `Item`): `poReference` (→ Cargo, C11), `productName`, `qty`, `hsCode`, `isDangerous` (→ DG tag, C8), `dimUnit`/`weightUnit` (→ Cargo, C6), `freightDensity`/`chargeableWeight` (were Stage‑4 placeholders — Stage 4 already carries these on `QuoteCargoLine`, so drop the unused columns here). **`msdsFileId` stays** (package-level MSDS, C10).

### 3.4 `Item` (new — commercial/customs unit)

| Field       | Type                                        | Entry        | Notes                                                       |
| ----------- | ------------------------------------------- | ------------ | ----------------------------------------------------------- |
| `id`        | uuid PK                                     | —            |                                                             |
| `tenantId`  | uuid?                                       | —            |                                                             |
| `packageId` | uuid FK → Package                           | —            | cascade delete                                              |
| `rowIndex`  | int                                         | assigned     | display position; SN shown as `rowIndex + 1` (not stored)   |
| `product`   | text?                                       | typed/lookup | **optional**                                                |
| `qty`       | Decimal?                                    | typed        | **optional**                                                |
| `uom`       | enum `UnitOfMeasure` (PC·SET·BOX·KG·M·ROLL) | selected     | **required only when `qty` present** (V‑4)                  |
| `hsCode`    | text?                                       | typed        | optional at Stage 3                                         |
| `tags`      | `ReferenceTag[]`                            | selected     | incl. DG (DG here makes the parent package require an MSDS) |

An item with **neither product nor qty is discarded on save** (V‑4).

### 3.5 Enums

- `PackageType` — `BOX·PALLET·CRATE·CARTON·DRUM·BUNDLE` (new).
- `UnitOfMeasure` — `PC·SET·BOX·KG·M·ROLL` (new).
- `WeightUnit` — add `TONNE`. Keep the existing enum value `GM` (display it as "g" per the PRD — label-only, no enum rename). Final enum: `KG·TONNE·GM`; labels: kg / tonne / g.
- `ReferenceTag` — add `DG` (currently `HEAVY·FRAGILE·NON_STACKABLE·OUT_OF_GAUGE`). Final: `HEAVY·FRAGILE·NON_STACKABLE·OUT_OF_GAUGE·DG`.
- `DimUnit` — unchanged (`CM·MM`).

### 3.6 Naming / FK strategy (DROP + CREATE, data disposable)

Because it is pre-go-live with only test data (C14), the cargo cluster is **dropped and recreated**, not renamed in place — simpler and far more robust under `migrate deploy` (the mandated path; `migrate dev` errors PG 42601 on the generated column and may propose a destructive reset of the shared dev DB):

- **DROP** `LegCargo`; **DROP** `CargoItem` (after its inbound FKs are cleared).
- **CREATE** `Cargo`, `Package`, `Item`, `LegPackage` fresh (Prisma models + hand-authored SQL). The FK target `Package.id` is a new table, so `LegPackage`/`QuoteCargoLine` reference `packageId` cleanly.
- `QuoteCargoLine`: clear its rows, then repoint `cargoItemId → packageId` (FK → `Package`).
- A **one-time truncate of the transactional tables** (queries + downstream; masters/config kept) is run alongside the migration so fixtures start clean and no orphaned cargo refs linger — see §11.

---

## 4. Roll-ups & formulas

All roll-ups are **derived on read**. Storage is canonical (cm, kg, CBM), so every total is pure summation **except** per-package volume, which is the one computed value.

```
package.volumeCbm      = dimL × dimW × dimH / 1e6      (generated column; dims are canonical cm)
package.tags(effective)= package.tags ∪ (⋃ item.tags)  (BL-3 union; derived on read)

cargo.packageCount     = COUNT(packages)                (H4)
cargo.grossWeightKg    = Σ package.grossWt              (H5)
cargo.volumeCbm        = Σ package.volumeCbm            (H6)
cargo.chargeableWeight = null at Stage 3                (H7; FF fills at Stage 4)
cargo.tags             = ⋃ package.tags(effective)      (H8)
```

**Leg roll-ups (existing) simplify:** today `LegsService` normalises `grossWt`/`netWt` per row `weightUnit` (`toKg`) and uses a unit-aware `volumeCbm`. With canonical kg/cm storage, the leg-level `totalGrossWt`/`totalNetWt`/`totalCbm` become **pure Σ** — drop the per-row normalisation. (Behaviour identical; code simpler.)

---

## 5. Validation catalogue (V-1…V-8 → new model)

| ID  | Rule                                                                    | Level                  | Status in this design                                                                        |
| --- | ----------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| V‑1 | L, W, H, Gross Wt all > 0                                               | Package                | Keep (Zod positivity, block on save)                                                         |
| V‑2 | Net ≤ Gross where both present                                          | Package                | **Active** (net is entered in UI)                                                            |
| V‑3 | Σ item net weights ≤ package gross                                      | —                      | **Dropped** (no item net weight — C9)                                                        |
| V‑4 | Qty ⇒ UoM; item with no qty & no product discarded                      | Item                   | **New**                                                                                      |
| V‑5 | Package No unique per shipment, case-insensitive, trimmed               | Package (query-scoped) | **New**                                                                                      |
| V‑6 | Unit change must not alter stored value; cm→mm→cm round-trips           | Cargo                  | Satisfied by canonical storage; add CI test                                                  |
| V‑7 | A tag set on an item can't be removed at package/cargo level            | Item→Package→Cargo     | **New** (UI union guard)                                                                     |
| V‑8 | Dims/weights reject negatives & non-numerics; blank ≠ zero for Net only | Package                | Keep (Zod; `netWt` nullable)                                                                 |
| F6  | DG package requires an MSDS (PDF)                                       | Package                | Triggered when the package's **effective** tags include DG (any item, or the package itself) |

`collectCreateFindings` (shared, create-phase) updates: mandatory query fields unchanged; cargo checks become **per package whose effective tags include DG → MSDS present**, plus package dims/gross present.

---

## 6. Tags & Dangerous Goods

- `ReferenceTag` gains `DG`; the standalone `isDangerous` boolean is removed from the model and UI.
- **Union upward (BL‑3):** an item's tags contribute to its package's effective tag set; a package's effective tags contribute to its cargo's set. Computed on read; not stored.
- **Non-removal (V‑7):** the UI prevents un-checking, at a package/cargo level, a tag that originates from a child. (Enforced client-side; the union is authoritative server-side.)
- **MSDS** attaches to the **package** and is required when the package's **effective** tags include DG — i.e. the package itself is tagged DG, or any of its items is (C10). Same PDF-only upload + magic-byte validation as today.
- `Query.dgIndicator` derives from "any package or item carries the DG tag" (replaces the old per-row boolean sync). Manual override retained per Functional Spec §7.2.

---

## 7. Units

- Selectors live on the **Cargo** (`dimUnit`, `weightUnit`); one choice per cargo grouping.
- **Storage is canonical:** dims → cm, weights → kg, volume → CBM. Entry converts on write; display converts on read (BL‑6). The `volumeCbm` generated column therefore drops its unit CASE.
- Weight units: **kg / tonne / g** (add `TONNE`). Conversion: tonne→kg ×1000, g→kg ÷1000.
- V‑6 round-trip is guaranteed because the stored value never depends on the display unit; add a CI test (cm→mm→cm and kg→tonne→kg identity).

---

## 8. UI / screens

### 8.1 Cargo Details main table (display-only)

One row per **Cargo**, columns aggregated over its packages:

`# · PO/Ref · Package Count · Contents (product×qty summary) · Σ Gross · Σ Volume (CBM) · Tags (⋃, incl. DG) · Chargeable Wt (blank) · Actions (Edit/Remove)`

- **Header band** above the table shows the cargo's H1–H8 while a cargo is open; the main-table columns are the same derived values per row.
- **Two-level expansion:** expand a cargo → its **packages** (Package No, Type, L/W/H, Gross, Net, Vol, Tags, item-count/contents); expand a package → its **items** (SN, Product, Qty, UoM, HSN, Tags).
- No inline editing anywhere — entry is via popup (PRD §2.1).

### 8.2 Entry flow — nested Cargo popup

`+ Add Cargo` / `Edit` opens a **Cargo popup**:

1. Cargo fields: **PO/Ref**, optional label, **Dimension Unit**, **Weight Unit**.
2. **Packages** section — a compact table. `+ Add Package` opens a **Package editor** (focused sub-panel) with package fields + a **live CBM** preview + an **Items mini-table**. An **MSDS upload** appears here once the package is effectively DG (any item tagged DG, or the package itself).
3. Inside a package: `+ Add Item` adds an item line (Product, Qty, UoM, HSN, Tags). Marking an item **DG** flags its package as DG → the package's MSDS upload appears in step 2.
4. **"Add N copies"** on a saved package clones it into N discrete package records (each auto-numbered).
5. **Save** persists the whole `cargo → packages → items` tree in one transaction.

`Remove` at the cargo level cascades to its packages and items.

### 8.3 Excel export

Single worksheet **`Packing List`**, **one row per Item**, with its package and cargo context repeated on each line. A **package with no items** emits one row with the item columns blank. An optional **totals row** closes the sheet (package count, Σ gross, Σ volume). Column order:

| Group   | Columns                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Cargo   | `Cargo #` · `PO / Reference`                                                                                                                   |
| Package | `Package No` · `Package Type` · `Dim L (cm)` · `Dim W (cm)` · `Dim H (cm)` · `Gross Wt (kg)` · `Net Wt (kg)` · `Volume (CBM)` · `Package Tags` |
| Item    | `SN` · `Product` · `Qty` · `UoM` · `HSN` · `Item Tags` · `DG (Yes/No)`                                                                         |

`DG` is derived from the DG tag; `Package Tags` / `Item Tags` render the effective (unioned) set. Values are canonical cm/kg, so the `(cm)`/`(kg)` headers are now accurate (today's export hardcodes them even for mm/g rows). Excel **import** remains out of scope.

---

## 9. Cargo ↔ Leg mapping (package grain)

- The assignment control and `LegCargo`(→`LegPackage`) operate on **packages** (C13). A package can ride several legs **sequentially** (Pickup→…→Delivery); the route engine's R1–R9 continuity rules are unchanged.
- **The only persisted leg relation is leg↔package** (`LegPackage(legId, packageId)`, many-to-many). There is **no direct leg↔cargo** table: a cargo's packages may ride different legs, so "which cargos are on a leg" is **derived** via `Package.cargoId`. (Mirrors today — `LegCargo` never linked to a grouping either.)
- `computeCargoConflicts` is re-grained to packages (a package already carried by another leg that shares this leg's origin or destination is disabled — the "parallel fork/merge" guard), identical logic, package IDs.
- Because `LegPackage` targets the same rows the old `LegCargo` did, existing route validation, roll-ups, and Stage‑4 distribution keep working.

---

## 10. Change mediator / impact classes

Cargo mutations already flow through `ChangeMediator` with `cargoImpactMap`. Re-scope to the new entities (mirror the existing map; Stage‑4 cascade unaffected because the classes are preserved):

- **`cargo`** — `poReference`/`label`: `Corrective`; `dimUnit`/`weightUnit`: `Corrective` (display-only, no stored-value change); `@create`/`@delete`: `Structural`.
- **`package`** — `packageType`/`dimL`/`dimW`/`dimH`/`grossWt`/`netWt`: `RfqDefining`; `packageNo`/`tags`/`msdsFileId`: `Corrective`; `@create`/`@delete`: `Structural`.
- **`item`** — `product`/`qty`/`uom`/`hsCode`/`tags`: `Corrective`; `@create`/`@delete`: `Corrective` (items don't change what a FF quotes — the package does).

_(Rationale: FFs quote against package weight/dims/type, so those stay `RfqDefining`; commercial/customs detail is `Corrective`.)_

---

## 11. Migration (pre-go-live / test data — C14; DROP + CREATE, `migrate deploy`)

Test data only, no production preservation. Applied as **hand-authored SQL + `prisma migrate deploy`** — never `migrate dev` (it errors PG 42601 on the generated column and may propose a destructive reset of the shared dev DB). **No backfill** — legacy cargo is discarded.

**One-time data wipe (run + confirmed before applying):** truncate the transactional tables — queries, the cargo cluster, points, legs, rfqs, quotes, charge lines, escalations, emails, notifications, change logs, status transitions. **Keep** masters + config/catalogue (users, clients, vessels, reference). This clears orphaned cargo refs and gives fresh fixtures.

**Migration SQL (DDL only):**

1. `CREATE TYPE "PackageType"`, `"UnitOfMeasure"`; `ALTER TYPE "ReferenceTag" ADD VALUE 'DG'`; `ALTER TYPE "WeightUnit" ADD VALUE 'TONNE' AFTER 'KG'`. (An `ADD VALUE` must not be used in the same transaction that references the new value.)
2. `DROP TABLE "LegCargo"`; clear + repoint `QuoteCargoLine` (`DELETE FROM "QuoteCargoLine"`, drop its cargo FK, rename `cargoItemId → packageId`); then `DROP TABLE "CargoItem"`.
3. `CREATE TABLE "Cargo"`, `"Package"` (with `volumeCbm` `GENERATED ALWAYS AS ("dimL"*"dimW"*"dimH"/1000000) STORED`, `@@unique(queryId, packageNo)`), `"Item"`, `"LegPackage"`.
4. Add `QuoteCargoLine.packageId` FK → `Package`.

Masters/config are untouched, so the app reseeds test queries via the new UI.

---

## 12. API surface (delta)

Per-level CRUD under the query, mirroring today's cargo endpoints (all mediated except initial create):

- `POST/PATCH/DELETE /queries/:id/cargo` — cargo grouping.
- `POST/PATCH/DELETE /queries/:id/cargo/:cid/packages` — packages (`add N copies` = server-side clone).
- `POST/PATCH/DELETE …/packages/:pid/items` — items.
- `POST …/packages/:pid/msds` — MSDS upload (per DG package).
- `POST /queries/:id/cargo/export` — restructured packing-list xlsx.
- Leg assignment body carries `assignedPackageIds` (was `assignedCargoIds`).

_(A single nested `PUT /queries/:id/cargo/:cid` that saves the whole tree is also viable and matches the popup's one-transaction save — to be finalised in the implementation plan.)_

---

## 13. Open items

| #   | Item                                                           | Disposition                                                                                                                     |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| O1  | `packageCount` **multiplier** semantics (N identical packages) | Column reserved (default 1, no calc, hidden). Confirm business need; if adopted, revisit roll-ups (weighted Σ) and leg mapping. |
| O2  | Net-weight display                                             | Resolved: **shown**. If business later hides it, revisit V‑2/V‑3.                                                               |
| O3  | Mixed references within a package                              | Resolved: **not supported** (PO/Ref at cargo). Revisit only if business requires item-level references.                         |
| O4  | FK/table rename vs `@@map` fallback                            | Default = clean rename; fallback documented (§3.6).                                                                             |
| O5  | Nested `PUT` vs per-level endpoints                            | Finalise in implementation plan (§12).                                                                                          |

---

## 14. Out of scope

Excel import · chargeable-weight / freight-density computation (Stage 4) · `packageCount` multiplier maths · any change to the route-validation engine, status machine, or change-order cascade beyond re-graining cargo→package.

---

_End of design._
