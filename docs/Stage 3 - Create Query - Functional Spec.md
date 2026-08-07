# YankAlfa Logistics — Stage 3: Create Query

## Functional Specification (v2)

> **Status:** Draft for review · **Date:** 15 July 2026
> **Scope note:** This document is **purely functional**. All technical and architectural decisions (stack, database, APIs, component design) are intentionally excluded and will be handled separately. It supersedes the leg-related portions of the original `Stage 3 - Create_Query.md` PRD, incorporating the business decisions taken during design discussion (summarised in §2).

---

## 1. Purpose & Role

Stage 3 is where a Logistics Executive turns a client request into the **structured query record** that becomes the single source of truth for every downstream stage (RFQ → quotes → client quotation → award → execution → closure).

The **leg** is the central concept: a leg is one biddable transport segment, and it is the atomic unit that every later stage operates on — each leg is assigned and quotated by Freight Forwarders (Stage 4), a best FF is selected per leg (Stage 5), leg costs roll up (with margin) into the client quotation (Stage 6), client PO Intake (Stage 7), each leg is awarded on the client PO (Stages 8), and each leg is tracked to delivery and closure (Stage 9). Because the leg definition made here is the spine of the whole system, this stage prioritises **executive control and flexibility** in defining legs, backed by **strong validation**.

---

## 2. Key Functional Decisions (from business discussion)

These decisions shape this spec and differ from the original PRD:

| #   | Decision                                                                                                                                                                          | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Manual, plug-n-play leg creation.** The Leg Generation Matrix, Multimodal Combination, and Service Type are **removed**.                                                        | The executive composes legs by hand; no auto-generated structure.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D2  | **Points (locations) are first-class, reusable objects.**                                                                                                                         | A leg selects an existing point or creates a new one; route connectivity is by shared-point reference, not text matching.                                                                                                                                                                                                                                                                                                                                                                           |
| D3  | **Mode is a per-leg property.** Shipment-level "Freight Mode" is removed as an input.                                                                                             | Each leg carries its own mode (Road/Air/Sea). A read-only "Modes" summary is derived from the legs for lists/dashboards.                                                                                                                                                                                                                                                                                                                                                                            |
| D4  | **Freight Density and Chargeable Weight live at cargo level and are deferred to Stage 4** (FF sets each row's density; chargeable weight is calculated then — one value per row). | In Stage 3 both are empty/read-only. The leg carries the full cargo manifest + roll-ups (packages, CBM, gross, net) and a **Total Chargeable Weight** (Σ of its rows' chargeable weights, filled in Stage 4). **No density and no DG at leg level.** **Stage-4 display (post-testing fixes R1):** the per-leg net-weight roll-up (`totalNetWt`) is hidden in the workspace leg panel when its value is 0; it is shown only when a genuine positive value is present. Display-only; no model change. |
| D5  | **Cargo rows are atomic** — each row travels a **single unbroken chain** with one start point and one end point (no forking/splitting a row across destinations).                 | Each cargo row's path is a simple chain of legs; start may be any point type except a Delivery, end any type (see R2, §10.2).                                                                                                                                                                                                                                                                                                                                                                       |
| D6  | **Divergent routing is allowed** — multiple hubs permitted; the old "single common hub" rule is dropped.                                                                          | The hub effective-date (MAX) rule applies at every hub.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D7  | **Cargo is attached to a leg by explicit selection** — when building a leg, the executive ticks which cargo rows ride it.                                                         | Continuity validation confirms the ticked legs actually form a row's single continuous chain (start → end).                                                                                                                                                                                                                                                                                                                                                                                         |
| D8  | **Legs are saved individually** (leg-wise), with a stable ID from creation; partial/draft legs are allowed.                                                                       | Enables per-leg validation, per-leg status, and stable downstream references.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D9  | **Change handling is query-wide and impact-aware** (not leg-only).                                                                                                                | Any field can be changed at any time; the system checks impact and either applies freely or runs a change-order (see §11).                                                                                                                                                                                                                                                                                                                                                                          |
| D10 | **Cargo tracking model defined now; tracking UI deferred to Stage 8–9.**                                                                                                          | Legs carry an execution status; a cargo row's live position is derived from its leg chain.                                                                                                                                                                                                                                                                                                                                                                                                          |
| D11 | **UI is a stepped wizard** (not a single sticky form).                                                                                                                            | `Cancel · Back · Save · Next` per step; `Create Query` on the final step.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D12 | Emails (follow-up, acknowledgement) are **composed & logged, not sent** in this phase.                                                                                            | Templates render and are recorded; no live mail transmission.                                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 3. Scope

**In scope (this build):**

- Manual query creation via the wizard (all sections below).
- Client Master and Vessel Master (the lookup sources for Section 1).
- The Query List (All Records) landing page — for manually created queries.
- Plug-n-play leg/route builder with the full validation catalogue.
- Query-wide change-impact handling (free path only, as no downstream work exists yet — see §11).
- Escalation timers + in-app notifications.
- Email compose-&-log (follow-up + acknowledgement).
- Roles & permissions (Executive / Manager / Administrator).
- The **leg execution-status field and derived cargo-position logic** (model only).

**Out of scope (this build / this phase):**

- Stage 2 email extraction & AI parsing (all fields are **manual entry** here).
- Live outbound email transmission (compose & log only).
- The **cargo tracking screen** (deferred to Stage 8–9; model is defined here).
- The **change-order cascade** execution (defined here; enforced when Stage 4+ exist).
- Downstream stages (RFQ, quotes, award, PO, delivery).
- Audit trail (deferred; see §11 for the change-log caveat).
- Inline client creation (deferred to v2 — if no client match, creation is out of scope for now).
- Excel **import** of cargo (Excel **export** is in scope).

---

## 4. User Roles

| Role                    | Functional responsibilities in Stage 3                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Logistics Executive** | Creates and edits queries; builds legs; manages cargo, addresses, notes; triggers follow-up/acknowledgement emails; runs Create Query.                                                      |
| **Logistics Manager**   | All Executive abilities; receives 2-hour escalation notifications; oversight/visibility across queries.                                                                                     |
| **Administrator**       | All abilities; receives 6-hour escalation notifications; may edit protected fields (e.g., backdated Query Date); maintains reference/config data (density factors, master data governance). |

Permission notes referenced elsewhere: only **authorised users** (Admin) may backdate the Query Date; reference data (freight density factors, checklist definition) is Admin-maintained.

---

## 5. Navigation & Overall Flow

```
Login
  │
  ▼
Query List (All Records) page  ──────────────┐
  │  • search, filter, sort, columns          │
  │  • [ + Create Query ] button (top)         │
  │                                            │
  ├── click [ + Create Query ] ───► Create Query Wizard (blank)
  │                                            │
  └── click any existing row ─────► Create Query Wizard (loaded with that record)

Create Query Wizard (stepped):
  Step 1  Client & Query Details   ("Create Query")
  Step 2  Shipment Details
  Step 3  Cargo Details
  Step 4  Legs / Route
  Step 5  Internal Notes & Checklist   ──►  [ Create Query ]  (completion)

  Per-step actions:  [ Cancel ]   [ Back ]   [ Save ]   [ Next ]
  Final step adds:   [ Create Query ]   (+ [ Send Follow-up ] / [ Send Acknowledgement ])
```

**Wizard behaviour:**

- **Save** persists current progress as a **Draft**. On the **first Save**, the system creates the record and mints the **Query ID**; the record then appears in the Query List. Save may be clicked from any step and does not require completeness.
- **Next / Back** move between steps. A **step indicator (stepper)** is shown; once the record exists (Draft), the user may also jump directly to any step.
- **Cancel** discards unsaved changes since the last Save. On a brand-new query never saved, Cancel clears everything and returns to the Query List. On an existing record, Cancel reverts to the last saved state.
- **Create Query** (final step) runs full validation and, on success, sets the status to **RFQ Ready** (see §9). In the full product this hands off to Stage 4; in this build it completes the record.
- The record + Query ID is created on the **first persist** — the first **Save**, or the first **leg save** (§7.4.3), whichever comes first.
- Opening an existing record from the Query List re-enters the **same wizard**, populated, at Step 1 (user may navigate to any step).

---

## 6. Query List — All Records Page

The landing page after login. Lists every query the user is entitled to see; the entry point for creating and opening queries.

### 6.1 Page elements

- **[ + Create Query ]** button — top of page; opens a blank wizard.
- **Search** — free-text across Query ID, Customer Name, Contact Person, Shipment Description.
- **Filters** — Status, Priority, Assigned User, Freight Mode (derived), Date range (Query Date / Last Updated), Country (origin/destination).
- **Sort** — any column; default by Last Updated (desc).
- **Row click** — opens that query in the wizard.

### 6.2 Columns

| Column               | Description                                                                        |
| -------------------- | ---------------------------------------------------------------------------------- |
| Query ID             | `YAL[YY]-[NNNN]` — clickable.                                                      |
| Query Date           | Creation timestamp (DD-MM-YYYY HH:mm).                                             |
| Customer Name        | From the linked client.                                                            |
| Contact Person       | Primary POC.                                                                       |
| Shipment Description | Short text from Shipment Details.                                                  |
| Freight Mode         | **Derived** from legs (distinct modes, e.g. "Road + Sea"). Blank until legs exist. |
| Origin               | Derived — pickup point(s) location.                                                |
| Destination          | Derived — delivery point(s) location.                                              |
| Response Deadline    | Target date for client response.                                                   |
| Priority             | Low / Medium / High / Urgent.                                                      |
| Status               | Lifecycle status (§9).                                                             |
| Assigned User        | Executive owning the query.                                                        |
| Last Updated         | Most recent save timestamp.                                                        |

---

## 7. Wizard Sections & Field Details

### 7.1 Step 1 — Client & Query Details

Primary business reference for the query. All values are **manual entry** in this build (no email auto-population). Client/contact fields link to **Client Master**; vessel fields link to **Vessel Master**. Editing a value here never changes the master record.

| Field                 | Type                          | Mandatory     | Read-only | Rules / Notes                                                                                                                      |
| --------------------- | ----------------------------- | ------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Query ID              | Text                          | Auto          | Yes       | System-generated on first Save. Format `YAL[YY]-[NNNN]` (YY = 2-digit year, NNNN = 4-digit zero-padded, resets yearly). Immutable. |
| Query Date            | DateTime                      | Auto          | Yes*      | Set at creation. Format DD-MM-YYYY HH:mm. *Editable only by Administrator (backdated entries).                                     |
| Priority              | Dropdown                      | Optional      | No        | Low / Medium / High / Urgent. Default **Medium** (assumption — confirm). Also editable from the persistent header after creation.  |
| Response Deadline     | Date                          | Optional      | No        | Target date for client quotation/acknowledgement. Past dates blocked. Optional remarks field (e.g. "Quote within 24 hrs").         |
| Company / Client Name | Lookup (Client Master)        | **Mandatory** | No        | Autocomplete; prevents duplicates. No inline create in this build (v2).                                                            |
| Contact Person (POC)  | Lookup (client's contacts)    | **Mandatory** | No        | Populated from the selected client's contacts; editable at query level.                                                            |
| Designation           | Text                          | Optional      | No        | Contact's role/title; may prefill from contact; does not update master.                                                            |
| Email Address         | Email                         | **Mandatory** | No        | Regex validation.                                                                                                                  |
| Phone / WhatsApp      | Phone (country code)          | **Mandatory** | No        | E.164 format; country-code selector; WhatsApp-enabled flag.                                                                        |
| Fax Number            | Text                          | Optional      | No        | International format.                                                                                                              |
| Vessel Name           | Lookup (Vessel Master) / Text | Optional      | No        | Autocomplete; standardised vessel identity.                                                                                        |
| IMO Number            | Numeric                       | Optional      | No        | 7-digit validation; duplicate cross-check.                                                                                         |
| ETA                   | DateTime                      | Optional      | No        | Must be earlier than ETB.                                                                                                          |
| ETB                   | DateTime                      | Optional      | No        | After ETA, before ETD.                                                                                                             |
| ETD                   | DateTime                      | Optional      | No        | After ETB.                                                                                                                         |
| Port of Call          | Text / Lookup                 | Optional      | No        | Intermediate stop where the vessel loads/unloads.                                                                                  |

> **Round 3 rename (UI labels only):** the Step-1 form section previously labelled **"Delivery"** is now labelled **"Shipment Dates"**. The field previously labelled **"Ready Date"** is now labelled **"Target Pickup"** (internal field name `readyDate` and its DB column are **unchanged** — this is a display-label change only).

| Target Pickup | DateTime | **Mandatory** | No | Cargo-ready date — the **client-agreed window**, in its own explicit timezone; **decoupled from leg dates** (Round 2, §8.5). Ready ≤ Target. UI label only; the internal field is `readyDate`. |
| Target Delivery | DateTime | **Mandatory** | No | Required client delivery date — the **client-agreed window**, in its own explicit timezone; **decoupled from leg dates** (Round 2, §8.5). |

---

### 7.2 Step 2 — Shipment Details

Foundational shipment parameters. **Simplified from the original PRD**: Freight Mode, Multimodal Combination, Service Type, and the Leg Generation Matrix are all removed (mode is now per-leg — D3).

| Field                | Type      | Mandatory     | Rules / Notes                                                                                                                                                                                                                                                                                                                       |
| -------------------- | --------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incoterms            | Dropdown  | **Mandatory** | One of EXW, FCA, FAS, FOB, CFR, CIF, CPT, CIP, DAP, DPU, DDP, **N/A**. Default **N/A** (a valid value; stored as `NA`, displayed "N/A"). Stored with the query.                                                                                                                                                                     |
| Shipment Description | Free text | Optional      | Plain text, 200-char limit, HTML/script sanitised.                                                                                                                                                                                                                                                                                  |
| DG Indicator         | Checkbox  | Optional      | Shipment-level dangerous-goods flag. **Auto-set** when any package or item carries the **DG tag** (§7.3 — a package's _effective_ tags are its own ∪ its items'; the union, not a per-row checkbox, now drives this); never auto-cleared once set; may also be set manually. When set, MSDS is expected per effectively-DG package. |

---

### 7.3 Step 3 — Cargo Details

> **Re-modelled.** Cargo is now a **three-level hierarchy** — `Cargo → Package → Item` — entered through a nested popup, not an inline row grid. Full rationale/decisions in `docs/superpowers/specs/2026-08-05-stage3-cargo-packing-list-design.md` (cited below as C1–C14).

Cargo is captured as **`Cargo → Package → Item`** (C1):

- **Cargo** — a PO/reference **grouping** row (what the main table shows). Owns the entry-unit selectors for everything under it. Carries no dims/weight/DG of its own.
- **Package** — the physical **freight unit** (Box, Pallet, Crate, …). This is the level every downstream stage (legs, RFQ, quotes) actually operates on, and the sole source of weight/volume (C2/C3).
- **Item** — the commercial/customs line inside a package (product, qty, HS code). A package may hold many items (many HS codes) or none.

The system auto-computes each package's **Volume (CBM)**; **chargeable weight stays empty/read-only at Stage 3** (§8.6, D4) — it is a Stage-4 Freight Forwarder value. All calculated/derived fields are read-only and visually distinguished.

#### Main table (display-only)

One row per **Cargo**, aggregated over its packages:

| Column         | Mandatory | Notes                                                                                                    |
| -------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| #              | Auto      | Sequential cargo order.                                                                                  |
| PO / Reference | Optional  | Falls back to **Label**, then `Row N`, when blank.                                                       |
| Package Count  | Auto      | Derived: count of packages under this cargo.                                                             |
| Contents       | Auto      | Product × Qty summary across every item in the cargo.                                                    |
| Σ Gross        | Auto      | Derived: sum of package Gross Wt, shown in the cargo's Weight Unit.                                      |
| Σ Volume (CBM) | Auto      | Derived: sum of package Volume (CBM), in m³.                                                             |
| Tags           | Auto      | Derived: union of every package's _effective_ tags (own ∪ its items'), incl. DG.                         |
| Chargeable Wt  | Auto      | Always blank at Stage 3 (Stage-4 Freight Forwarder value).                                               |
| Actions        | —         | **Edit** / **Remove** — opens the nested popup below; Remove cascades to the cargo's packages and items. |

**Two-level expansion:** expanding a Cargo row reveals its **packages** (Package No, Type, L/W/H, Gross, Net, Volume, Tags, Contents); expanding a package reveals its **items** (SN, Product, Qty, UoM, HSN, Tags). No inline editing anywhere — entry and edits both go through the popup.

#### Entry — nested Cargo popup fields

**A · Cargo — the grouping**

| Field          | Type     | Mandatory | Notes                                                                                                                          |
| -------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| PO / Reference | Text     | Optional  | The cargo's identity/label; one reference per grouping (no mixed references within a package, C11).                            |
| Label          | Text     | Optional  | Human label; used as the display-name fallback when PO/Reference is blank.                                                     |
| Dimension Unit | Dropdown | Selected  | CM / MM, default CM. Applies to **every package under this cargo** — entry/display only, storage is canonical cm (V-6).        |
| Weight Unit    | Dropdown | Selected  | **kg / tonne / g**, default kg. Applies to every package under this cargo — entry/display only, storage is canonical kg (V-6). |

**B · Package — the freight unit**

| Field         | Type        | Mandatory     | Notes                                                                                                                                                                                                                                                                                                            |
| ------------- | ----------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package No    | Text        | **Mandatory** | Auto-numbered, editable; must be **unique within the query**, case-insensitive/trimmed (V-5).                                                                                                                                                                                                                    |
| Package Type  | Dropdown    | **Mandatory** | Box / Pallet / Crate / Carton / Drum / Bundle.                                                                                                                                                                                                                                                                   |
| Dim L / W / H | Numeric ×3  | **Mandatory** | All three > 0 (V-1). Entered in the cargo's Dimension Unit; converted to canonical cm on save.                                                                                                                                                                                                                   |
| Gross Wt      | Numeric     | **Mandatory** | > 0 (V-1). Entered in the cargo's Weight Unit; converted to canonical kg on save. Total incl. packaging.                                                                                                                                                                                                         |
| Net Wt        | Numeric     | Optional      | Same entry unit as Gross Wt. Must be ≤ Gross Wt if provided (V-2).                                                                                                                                                                                                                                               |
| Volume (CBM)  | Calculated  | Auto          | `Dim L × Dim W × Dim H / 1,000,000` from the package's canonical-cm dims — always m³. One package = one physical unit, so there is no ×Qty multiplier (C4) and no unit branching (storage is canonical). Read-only.                                                                                              |
| Tags          | Multi-badge | Optional      | Heavy / Fragile / Non-Stackable / Out of Gauge Cargo / **Dangerous Goods (DG)** — DG is now a **tag**, not a separate checkbox (multiple allowed). A package's _effective_ tags = its own ∪ its items' (union, derived on read); a tag set by a child item can't be unchecked at the package (V-7, UI-enforced). |
| MSDS          | File (PDF)  | Conditional   | Visible/required only when the package is **effectively DG** — its own DG tag, or any of its items' (F6). PDF only, magic-byte validated; shows filename with remove option.                                                                                                                                     |

_(A `packageCount` column exists in the data model, default 1 — reserved for a possible future "N identical packages" multiplier. Not calculated, not shown in this UI, C5.)_

**Add N copies:** on a saved package, clones it **2–50** times into discrete new package records, each auto-numbered with its own fresh Package No and a copy of its items (C4). There is no stored quantity multiplier — one record per physical package.

**C · Item — commercial/customs line**

| Field         | Type        | Mandatory   | Notes                                                                                                                                       |
| ------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Product       | Text        | Optional    | —                                                                                                                                           |
| Qty           | Numeric     | Optional    | If entered, must be > 0; **UoM becomes mandatory** once Qty is present (V-4).                                                               |
| UoM           | Dropdown    | Conditional | PC / Set / Box / Kg / M / Roll — required only when Qty is entered (V-4).                                                                   |
| HS / HSN Code | Text        | Optional    | Per item; captured for customs reference — no separate customs-form output is generated (C12).                                              |
| Tags          | Multi-badge | Optional    | Same tag set as Package, incl. DG. An item's DG tag makes its **parent package** effectively DG (triggers that package's MSDS requirement). |

An item with **neither Product nor Qty is discarded on save** (V-4).

**Popup flow:** `+ Add Cargo` / row **Edit** opens the popup — (1) the Cargo fields above; (2) a **Packages** section, where `+ Add Package` opens a package editor with a live CBM preview and an **Items** mini-table; (3) `+ Add Item` inside a package adds an item line — marking an item DG flags its package as effectively DG, revealing that package's MSDS upload; (4) **Add N copies** on a saved package (above); (5) **Save** persists the whole `Cargo → Packages → Items` tree in one transaction. **Remove** at the cargo level cascades to its packages and items.

#### Bulk action: Export to Excel

Exports the whole packing list to `.xlsx` — a single worksheet **`Packing List`**, **one row per Item** (its package and cargo context repeated on each line). A package with no items still emits one row (item columns blank). A trailing **Totals** row closes the sheet: distinct package count, Σ Gross, Σ Volume. Column order: Cargo # · PO/Reference · Package No · Package Type · Dim L/W/H (cm) · Gross/Net Wt (kg) · Volume (CBM) · Package Tags · SN · Product · Qty · UoM · HSN · Item Tags · DG (Yes/No) — values are always canonical cm/kg, regardless of the cargo's entry unit. (Excel import remains out of scope.)

> **Note on Chargeable Weight (deferred to Stage 4):** the old per-row **Freight Density** field is gone — dropped from the Stage-3 model entirely (Stage 4's `QuoteCargoLine` already carries a per-package density/chargeable-weight pair, so Stage 3 no longer reserves a placeholder column for it). The one remaining Stage-3 placeholder is the **Cargo header's Chargeable Weight** — always blank/derived-null at this stage, filled in once Stage 4 exists. The leg still shows a **Total Chargeable Weight** roll-up (§8.6), empty until Stage 4 populates the values it sums.

---

### 7.4 Step 4 — Legs / Route Builder

The core of Stage 3. The executive **manually composes the route** as a set of **points** connected by **legs**. There is no auto-generation; a live route diagram is derived from the legs entered.

#### 7.4.1 Points (locations) — first-class, reusable (D2)

A point is created once and can be referenced as an endpoint by multiple legs (this is what makes connectivity checkable). There are five point types; a leg's mode determines which types are valid at its endpoints (§10, rule V-M1).

**A · Pickup point**

| Field              | Type     | Mandatory     | Notes                           |
| ------------------ | -------- | ------------- | ------------------------------- |
| Company Name       | Text     | **Mandatory** | —                               |
| Street Address     | Text     | **Mandatory** | —                               |
| City / Postal Code | Text     | **Mandatory** | —                               |
| Country            | Dropdown | **Mandatory** | Drives FF filtering downstream. |
| Contact Name       | Text     | **Mandatory** | —                               |
| Contact Phone      | Text     | **Mandatory** | Format validated.               |
| Email              | Text     | **Mandatory** | —                               |

**B · Delivery point** — same fields as Pickup; **Email is Optional**. Company Name blocking if blank at Create Query.

**C · Warehouse point (optional staging)**

| Field                        | Type     | Mandatory     | Notes                                                   |
| ---------------------------- | -------- | ------------- | ------------------------------------------------------- |
| Company Name                 | Text     | **Mandatory** | —                                                       |
| Street Address               | Text     | **Mandatory** | —                                                       |
| City / Postal Code           | Text     | **Mandatory** | —                                                       |
| Country                      | Dropdown | **Mandatory** | —                                                       |
| Warehouse Type               | Dropdown | Optional      | Consolidation / Cross-Dock / Temporary Storage / Other. |
| Contact Name / Phone / Email | Text     | Optional      | —                                                       |

**D · Airport point (hub)**

| Field                   | Type     | Mandatory     | Notes                |
| ----------------------- | -------- | ------------- | -------------------- |
| Airport Name            | Text     | **Mandatory** | —                    |
| IATA Code               | Text     | **Mandatory** | 3-letter, validated. |
| ICAO Code               | Text     | Optional      | 4-letter, validated. |
| Terminal / Address      | Text     | Optional      | —                    |
| City / Postal Code      | Text     | **Mandatory** | —                    |
| Country                 | Dropdown | **Mandatory** | —                    |
| Contact / Phone / Email | Text     | Optional      | —                    |

**E · Seaport point (hub)**

| Field                   | Type     | Mandatory     | Notes                   |
| ----------------------- | -------- | ------------- | ----------------------- |
| Port Name               | Text     | **Mandatory** | —                       |
| UN/LOCODE               | Text     | **Mandatory** | 5-character, validated. |
| Terminal / Berth        | Text     | Optional      | —                       |
| City / Postal Code      | Text     | **Mandatory** | —                       |
| Country                 | Dropdown | **Mandatory** | —                       |
| Contact / Phone / Email | Text     | Optional      | —                       |

#### 7.4.2 Leg specification

| Field                                                      | Type         | Mandatory          | Notes                                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Leg ID                                                     | Text (auto)  | Auto               | Sequential, stable, never reused within a query. Persists across edits (downstream reference).                                                                                                   |
| Leg Name                                                   | Text         | Optional           | Free label (e.g. "Origin trucking"); may be blank.                                                                                                                                               |
| Origin Point                                               | Point ref    | **Mandatory**      | Select an existing point or create a new one.                                                                                                                                                    |
| Destination Point                                          | Point ref    | **Mandatory**      | Select an existing point or create a new one.                                                                                                                                                    |
| Mode                                                       | Dropdown     | **Mandatory**      | Road / Air / Sea. Determines valid endpoint types and the density factor for chargeable weight.                                                                                                  |
| Assigned Cargo                                             | Multi-select | **Mandatory (≥1)** | Ticked from the full cargo list (D7).                                                                                                                                                            |
| Ready Date                                                 | DateTime     | **Mandatory**      | Set per leg (operational plan), anchored to the **origin point's** timezone; **independent of the query Ready Date** — query and leg dates are decoupled (Round 2, §8.5). Ready ≤ Target.        |
| Target Delivery                                            | DateTime     | **Mandatory**      | Set per leg, anchored to the **destination point's** timezone; **independent of the query Target Delivery** (decoupled, Round 2). A hub's effective ready date = MAX of feeding legs (§8.5, T3). |
| Cargo Manifest                                             | Reference    | —                  | The **complete cargo object** for every attached row (all fields from §7.3). This is what the FF sees per leg in Stage 4.                                                                        |
| Total Packages / Total CBM / Total Gross Wt / Total Net Wt | Calculated   | Auto               | Leg-level roll-ups from the attached cargo (Stage 3).                                                                                                                                            |
| Total Chargeable Weight (T)                                | Read-only    | —                  | Σ of the attached rows' cargo-level chargeable weights. **Empty in Stage 3**; populated in Stage 4 once FFs set density (§8.6). No Freight Density and no DG at leg level.                       |
| Leg Status                                                 | Badge (auto) | Auto               | Draft → Ready for RFQ (this build). Later: RFQ Sent → Quoted → Awarded → In transit → Delivered (§9, §12).                                                                                       |

#### 7.4.3 Route builder behaviour

- **Manual add:** **+ Add leg** opens a leg editor (origin, destination, mode, cargo, dates). No legs are ever auto-created.
- **Reusable points:** origin/destination each let the user pick an existing point or create a new one; connectivity is established by selecting the **same point object** as the previous leg's destination.
- **Leg-wise save (D8):** each leg is saved individually via **Save leg**; it receives a stable ID. Legs may be saved **partial/draft** (validation warns but does not block saving); the full catalogue hard-blocks only at Create Query.
- **Edit:** each saved leg (and each point) has an **edit** control; changing any field re-runs validation and recomputes derived values (see §11 for the general change model).
- **Delete:** a leg or point may be removed; the system re-validates and flags any resulting orphans or broken chains (non-destructive — it warns, never silently fixes).
- **Cargo on the leg:** attaching cargo stores a **live reference** to the complete cargo objects — the leg shows the full **manifest** plus the aggregate roll-ups. Pre-RFQ the manifest updates instantly when a cargo row changes and re-validates; at **RFQ time the attached set is frozen for the quote**, so any later cargo change runs through the change-order (§11) and the FF never quotes stale cargo.
- **Live route diagram:** a diagram is derived from the legs, updating on every add/edit/remove — it is a visualisation and validation aid (broken chains are visible), not an input surface.

---

### 7.5 Step 5 — Internal Notes & Missing Details Checklist

Internal coordination layer — never exposed to client-facing views.

| Field          | Type           | Mandatory | Notes                                                              |
| -------------- | -------------- | --------- | ------------------------------------------------------------------ |
| Internal Notes | Free-text area | Optional  | Team observations/instructions. 500-char limit. Not client-facing. |

**Completeness checklist** — nine checkboxes, all start unchecked; all Optional. Any unchecked item contributes to an "incomplete" state and enables the follow-up trigger.

| #   | Checklist item              | Notes                                |
| --- | --------------------------- | ------------------------------------ |
| 1   | Weight confirmed            |                                      |
| 2   | Dimensions confirmed        |                                      |
| 3   | HS / HSN code received      |                                      |
| 4   | DG / Non-DG confirmed       |                                      |
| 5   | MSDS received               | Applicable when DG indicator is set. |
| 6   | Commercial invoice received |                                      |
| 7   | Packing list received       |                                      |
| 8   | Pickup address confirmed    |                                      |
| 9   | Delivery address confirmed  |                                      |

- **Send Follow-up Email** button — available here and in the action bar; enabled only if **at least one** item is unchecked. Clicking it compiles the unchecked items into the missing-fields list and **composes & logs** a follow-up email (no live send — D12). Auto-trigger on save is deferred to a future phase.

---

## 8. Legs — System Logic

- **L1 · Manual composition (D1):** every leg is added by the executive; nothing is auto-generated.
- **L2 · Points are first-class (D2):** origin/destination reference reusable point objects; two legs "connect" only when they share the same point object.
- **L3 · Per-leg mode (D3):** each leg has its own mode; the shipment "Modes" summary is derived from all legs.
- **L4 · Cargo attached by selection (D7):** a leg carries only the cargo rows ticked for it; a row is ticked on every leg along its path.
- **L5 · Atomic cargo rows (D5):** each cargo row has **exactly one start point and one end point**; its assigned legs must form a **single continuous chain** from start to end — the start may be any point type except a Delivery, the end any type (R2). No forking/splitting a row across destinations.
- **L6 · Divergent routing allowed (D6):** multiple pickups/hubs/deliveries are permitted; there is no single-common-hub requirement.

### 8.5 Leg dates & hub convergence

- **Query dates and leg dates are decoupled** (Round 2 — T2 retired): the query-level **Ready Date / Target Delivery** are the _client-agreed window_ (each in its own explicit timezone); a cargo row's **leg** dates are the _operational plan_. Every leg's Ready/Target is set independently by the executive — **not** inherited from the query.
- **Ready ≤ Target** holds at both the query and the leg level, compared as real UTC instants (leg Ready anchors to the origin point's zone, leg Target to the destination's).
- **Hub effective date (MAX):** where several legs feed one hub/point, the onward leg cannot depart before the **latest** arriving leg — the point's effective ready date = **MAX** of the feeding legs' Target Delivery dates. Applied at **every** hub (D6, rule T3).

### 8.6 Weights — cargo level vs leg level (D4)

- **Cargo level:** each cargo row has a **Freight Density** and a **Chargeable Weight**, both **empty/read-only in Stage 3**. In Stage 4 the FF sets that row's density and the system computes chargeable weight = greater of (a) gross weight (t) and (b) volumetric weight = CBM × density (t). **One chargeable weight per cargo row.**
- **Leg level:** the leg rolls up **Total Packages, Total CBM, Total Gross Weight, Total Net Weight** in **Stage 3**, and a **Total Chargeable Weight** = the sum of its attached rows' chargeable weights (**empty in Stage 3**, populated once Stage 4 fills the rows). **No Freight Density and no DG at leg level** — those are cargo-row attributes.
- Industry default densities (Air ≈ 167, Sea ≈ 1,000, Road ≈ 333 kg/CBM) may **seed** the FF's per-row density field in Stage 4 but are **not applied in Stage 3**.

---

## 9. Status Lifecycle

**Query statuses used in this build:**

| Status    | Meaning                                                  | Set by | Trigger                  |
| --------- | -------------------------------------------------------- | ------ | ------------------------ |
| Draft     | Record created; one or more mandatory fields incomplete. | System | First Save.              |
| Created   | All mandatory fields complete and validated.             | System | Successful Create Query. |
| RFQ Ready | Ready to distribute RFQ (terminal state for this build). | System | Successful Create Query. |

_(Downstream statuses — RFQ Sent, Quoted, Awaiting Client Decision, Won/Lost, Closed — are defined at the module level and not set within this build.)_

### 9.1 Query status vs leg status

**Leg status** is the state of a **single leg** — legs move independently (one can be Awarded while another is still RFQ Sent). **Query status** is the **whole query's** stage, **derived** as a rollup of all leg statuses **plus client-facing milestones legs never have** (Created, RFQ Ready, Awaiting Client Decision, Won, Lost, Closed). Query status is **never hand-set**.

**Rollup rule:** the query advances to a stage only when **all legs** have reached it (least-advanced gates), with partial progress shown (e.g. "2 of 3 legs quoted"). Client milestones are query-level events layered on top.

| Query status             | Derived when                                |
| ------------------------ | ------------------------------------------- |
| Draft                    | Any mandatory field incomplete              |
| Created / RFQ Ready      | All valid; **all** legs = Ready for RFQ     |
| RFQ Sent                 | RFQ distributed; **not all** legs quoted    |
| Quoted                   | **All** legs have quotes                    |
| Awaiting Client Decision | Client quotation sent _(query-level event)_ |
| Won — PO Received / Lost | Client decision _(query-level event)_       |
| Closed                   | All legs delivered / query closed           |

_(This build exercises Draft → Created → RFQ Ready at query level and Draft → Ready for RFQ at leg level; the rest is defined for later stages.)_

### 9.2 Leg statuses & transitions

**Leg statuses & transitions** (system-managed; not user-edited). This build owns **Draft ↔ Ready for RFQ**; the rest are defined here but driven by later stages.

| Status           | Meaning                                       | Set by      | Trigger                                       | Stage |
| ---------------- | --------------------------------------------- | ----------- | --------------------------------------------- | ----- |
| Draft            | Leg created; incomplete or failing validation | System      | Leg added / saved partial                     | 3     |
| Ready for RFQ    | Leg complete and valid                        | System      | Leg passes validation / Create Query succeeds | 3     |
| RFQ Sent         | RFQ distributed to FFs for this leg           | System      | Executive distributes RFQ                     | 4     |
| Partially Quoted | Some invited FFs have quoted                  | System      | First quote received (window open)            | 4     |
| Fully Quoted     | Quote window closed / all quoted              | System      | RFQ window closes                             | 4–5   |
| Awarded          | Best FF selected & awarded for the leg        | User        | Award on client PO                            | 5–8   |
| In Transit       | Execution started for the leg                 | System / FF | Pickup / departure milestone                  | 8–9   |
| Delivered        | Leg cargo delivered to its destination        | System / FF | Delivery milestone                            | 9     |
| Closed           | Leg closed                                    | System      | Query closure                                 | 9     |

**Reopen (reverse) transitions:** a change-order (§11) can move a leg from RFQ Sent / Partially Quoted / Fully Quoted / Awarded **back to Ready for RFQ** — invalidating the affected quotes and re-opening the leg for re-distribution.

---

## 10. Validation Catalogue

Severity: **Blocking** (prevents progression) or **Warning** (advisory). Trigger points: _save_ (leg/field save), _create_ (Create Query), _RFQ_ (RFQ generation, later stage). During Draft, structural issues are shown as **warnings**; at **Create Query** they become **blocking**.

> **Currency (kept in lockstep with the engine):** this catalogue is the source of truth for the rules; the shared `validateRoute(graph, phase)` engine (`packages/shared/src/route.ts`) and its tests (`route.test.ts`) implement exactly it. Recent business changes are folded in below — **R2** and **R5** relaxed and **T2** retired (Req & Issues rounds). On any conflict, spec + code win over older notes.

### 10.1 Field-level

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                     | Severity                                | Trigger |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------- |
| F1  | Query mandatory fields present (client, POC, email, phone, Target Pickup / `readyDate`, Target Delivery, Incoterms). PO / Reference is **not** in the mandatory set (Round 3 — now optional).                                                                                                                                                                                            | Blocking                                | create  |
| F2  | Email regex valid; phone E.164 valid; IMO 7-digit; IATA 3-char; ICAO 4-char; UN/LOCODE 5-char.                                                                                                                                                                                                                                                                                           | Blocking                                | save    |
| F3  | ETA < ETB < ETD (when provided).                                                                                                                                                                                                                                                                                                                                                         | Blocking                                | save    |
| F4  | Response Deadline not in the past.                                                                                                                                                                                                                                                                                                                                                       | Blocking                                | save    |
| F5  | Package: L/W/H and Gross Wt present and > 0; if Net Wt provided, Net ≤ Gross. Item: if Qty is entered, UoM is required; an item with neither Product nor Qty is discarded on save. `dimUnit`/`weightUnit` are recorded once per **Cargo** grouping (the entry unit for every package under it), not per package. PO / Reference (on the Cargo) is **not** required (Round 3 — optional). | Blocking (Net ≤ Gross = Warning inline) | save    |
| F6  | A **package** whose effective tags include DG (its own tag, or any of its items') requires an MSDS (PDF) file.                                                                                                                                                                                                                                                                           | Blocking                                | create  |

> **Note — datetime minute default (Round 3):** all datetime inputs across all screens (Step-1 Target Pickup / Target Delivery / ETA / ETB / ETD / Response Deadline; leg Ready Date / Target Delivery; ETA / ETB / ETD) **default the minute component to `:00`** when a fresh value is entered. The minute field remains fully editable — this is a soft default, not a lock.

### 10.2 Route — connectivity & continuity

| #   | Rule                                                                                                                                                      | Severity | Trigger |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| R1  | Each cargo row's assigned legs form an **unbroken chain** (each leg's destination = next leg's origin).                                                   | Blocking | create  |
| R2  | Each chain **starts at any point type _except_ a Delivery** (a Delivery is where cargo arrives, never where it begins) and may **end at any point type**. | Blocking | create  |
| R3  | **No orphans:** no leg without cargo, no cargo row without legs, no point unused by any leg.                                                              | Blocking | create  |
| R4  | **No cycles;** each cargo row's path is a **simple path** (no point revisited).                                                                           | Blocking | create  |
| R5  | **Minimum route:** the query has **at least one saved leg**, and **every leg connects two _different_ points** (no self-loop).                            | Blocking | create  |

> **On parallel legs:** continuity (R1) is checked **per cargo row**, along that row's own simple path — not as one global sequence over all legs. The route is a **graph**: a point can have several incoming and several outgoing legs (e.g. two pickups feeding one hub, or one hub fanning to two deliveries). Parallel legs belong to **different cargo rows** and meet at shared points; each row's own chain still reads destination → next origin.
>
> **A single cargo row is atomic (D5) and can never split:** it must **leave a point on exactly one leg** (no fork / parallel drop) and **arrive on exactly one leg** (no merge). Ship one product to several destinations by giving **each destination its own cargo row** — enforced by R1/R6 (a fork/merge breaks the single chain), surfaced with an explicit message, and blocked proactively in the leg editor (a cargo already on a leg sharing this leg's origin/destination is disabled).

### 10.3 Route — cargo mass-balance

| #   | Rule                                                                                                                             | Severity | Trigger |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| R6  | For each cargo row, at every intermediate point, what **enters** must **leave** — nothing stuck, nothing appearing from nowhere. | Blocking | create  |

### 10.4 Route — mode ↔ endpoint compatibility

| #    | Rule                                                                                                                                                                                                                                                         | Severity | Trigger  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------- |
| V-M1 | A leg's mode must match its endpoint types: **Air** → airport endpoint(s); **Sea** → seaport endpoint(s); **Road** → pickup / warehouse / delivery / port-drayage. Impossible combos (e.g. a Sea leg from a street address to a street address) are blocked. | Blocking | leg save |

### 10.5 Route — downstream readiness

| #   | Rule                                                                              | Severity | Trigger      |
| --- | --------------------------------------------------------------------------------- | -------- | ------------ |
| R7  | **Both endpoints of every leg carry a Country** (drives FF filtering downstream). | Blocking | create / RFQ |
| R8  | All mandatory point fields present per endpoint.                                  | Blocking | create       |
| R9  | If a cargo row is DG, **every leg carrying it** is DG-aware and MSDS is present.  | Blocking | create / RFQ |

### 10.6 Route — temporal continuity

| #   | Rule                                                                         | Severity                            | Trigger       |
| --- | ---------------------------------------------------------------------------- | ----------------------------------- | ------------- |
| T1  | A leg cannot depart before the previous leg on a cargo row's chain arrives.  | Warning (draft) / Blocking (create) | save / create |
| T3  | A hub's onward-leg Ready Date ≥ MAX of feeding legs' Target Delivery (§8.5). | Warning (draft) / Blocking (create) | save / create |

> **T2 retired (Round 2):** the old "first/last leg date = query date" equality was removed. Query Ready/Target (the client-agreed window, each with its own explicit timezone) and leg dates (the operational plan) are **decoupled**. `Ready ≤ Target` still holds at both the query and leg level, and hub timing stays with T1/T3 — all compared as real UTC instants.

### 10.7 Completeness

| #   | Rule                                                                                                                   | Severity | Trigger |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| C1  | Every leg has origin, destination, mode, ≥1 cargo, and dates.                                                          | Blocking | create  |
| C2  | Every cargo row is covered by a continuous leg chain (see R1).                                                         | Blocking | create  |
| C3  | Per-leg CBM + gross-weight roll-up computes for every leg. (Chargeable weight is a Stage 4 value — not required here.) | Blocking | create  |

### 10.8 Edit-time integrity

| #   | Rule                                                                                                                                           | Severity | Trigger  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| E1  | Deleting a point/leg, or changing an endpoint/mode/cargo, re-runs the full catalogue and flags what broke — never silently corrupts the route. | Live     | any edit |

---

## 11. Change-Impact Handling (query-wide)

Change handling applies to **any field or entity** at **any point** in the query's life — not only legs. The system **never hard-locks** a field; instead every edit runs an **impact check** and is routed down one of two paths.

### 11.1 Impact classes

Every editable field carries an impact class:

| Class                  | Examples                                                                     | Downstream cost                    |
| ---------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| Internal               | Internal notes, priority, response deadline                                  | None                               |
| Corrective             | Typo in a name, designation                                                  | None (cosmetic)                    |
| RFQ-defining           | Leg origin/destination/mode, cargo weight/dims, address + country, Incoterms | High — FFs quote against these     |
| Pricing/award-defining | FF selection, margin (later stages)                                          | High                               |
| Structural             | Add/remove a leg or a cargo row                                              | High — recomputes route + coverage |

### 11.2 The two paths

| Condition                                                                                                       | Path                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No downstream work depends on the changed scope (Internal/Corrective, **or** RFQ-defining while still pre-RFQ)  | **Free path:** apply the edit + re-validate the route.                                                                                                                       |
| An RFQ-defining-or-heavier change **to a scope that already has downstream work** (RFQ Sent / Quoted / Awarded) | **Change-order path:** impact preview → confirm + reason → cascade invalidation to the **minimal affected scope** → reopen those artifacts to the correct state → record it. |

### 11.3 Principles

- **Minimal blast radius:** a change reopens only what it actually touched (e.g., editing Leg 4's cargo reopens **Leg 4's** RFQ only). This is why the leg is the atomic unit.
- **Shared-point edits ripple:** editing a reused point updates it on every leg that references it (it is one object); to route cargo elsewhere, pick/create a different point.
- **Non-destructive:** the system warns and blocks on breakage; it never silently deletes or "auto-fixes".

### 11.4 Scope for this build

Pre-RFQ there is no downstream work, so **every change takes the Free path** (apply + re-validate). This build implements the free path and the **impact classification + impact-check hook**; the change-order cascade is realised when Stage 4+ come online.
**Caveat:** a change-order needs a small record of _what/why_, which touches the deferred audit trail. This build (free path only) is unaffected, but a lightweight change-log will be needed when the cascade is built.

---

## 12. Cargo Tracking (model defined now; UI deferred)

- The **leg** is the tracking unit: each leg carries an execution status — **Pending → In transit → Completed**.
- A cargo row's **live position is derived** from its leg chain (e.g. "at Pickup A → in transit on the sea leg → arrived Origin port → out for delivery").
- The route diagram doubles as a **tracking view** (legs coloured by execution status).
- A **client-safe status summary** (e.g. "in transit, Rotterdam → Singapore, ETA …") can be shared — internal notes are never exposed.
- **Scope:** the execution-status field and derived-position logic are **modelled in this build**; the tracking **updates and screen** are delivered in Stage 8–9.

---

## 13. Form Actions

| Action                   | Availability                      | Behaviour                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cancel**               | Every step                        | Confirmation prompt. Discards changes since the last Save. Brand-new unsaved query → clears and returns to Query List. Existing record → reverts to last saved state.                                                                                                                                                                 |
| **Back**                 | Steps 2–5                         | Returns to the previous step (state retained).                                                                                                                                                                                                                                                                                        |
| **Save**                 | Every step                        | Persists progress as **Draft** (no completeness validation). First Save creates the record + Query ID and lists it in the Query List. Silent save indicator (no disruptive dialog). If two users edit the same record, the latest save wins (no record locking).                                                                      |
| **Next**                 | Steps 1–4                         | Advances to the next step (retains progress; light per-step validation as warnings).                                                                                                                                                                                                                                                  |
| **Create Query**         | Final step                        | Runs full validation (§10). **Mandatory gaps hard-block** creation (flagged inline). If only optional/checklist items are missing, prompts with **Cancel / Save Draft / Send Anyway**. On success: status → **RFQ Ready**, success banner "Query `YAL[YY]-[NNNN]` created successfully." (In the full product, hands off to Stage 4.) |
| **Send Follow-up Email** | Notes/checklist step + action bar | Enabled only if ≥1 checklist item is unchecked. Compiles missing items and **composes & logs** the follow-up email (no live send).                                                                                                                                                                                                    |
| **Send Acknowledgement** | Action bar                        | Available regardless of completeness. **Composes & logs** the acknowledgement email.                                                                                                                                                                                                                                                  |

---

## 14. Escalation & Notifications

Creation (the first Save) starts the escalation clock. If a query is created but not progressed toward RFQ Ready within the window (no further activity), a tiered, **informational** sequence fires:

| Elapsed since creation | Recipient           | Action                             |
| ---------------------- | ------------------- | ---------------------------------- |
| 30 minutes             | Logistics Executive | Reminder to begin processing.      |
| 2 hours                | Logistics Manager   | Escalation for oversight.          |
| 6 hours                | Administrator       | Escalation for final intervention. |

- Channel: **in-app notification** (+ email compose-&-log).
- Escalation is **informational only** — no automatic reassignment or status change.
- A query is **never auto-closed** (e.g. after 24 h); it stays open until resolved or explicitly closed by an authorised user.

---

## 15. Email Templates (compose & log)

**15.1 Missing-information follow-up** (manual trigger)

- **From:** logistics@yankalfa.com · **To:** {Client_Email}
- **Subject:** "Action Required: Missing Information for Your Shipment Request – {Query_ID}"
- **Body:** acknowledges {Query_ID}, lists **Missing information: {Missing_Fields_List}** (comma-separated unchecked checklist items, generated at trigger time), requests a reply.

**15.2 Query acknowledgement** (manual trigger)

- **From:** logistics@yankalfa.com · **To:** {Client_Email}
- **Subject:** "Acknowledgement: Shipment Query Received – Query ID: {Query_ID}"
- **Body:** thanks the client, confirms a record with {Query_ID} has been created, states an expected response within {Expected_Response_Timeline} (default 24 hrs from send), and asks the client to reply on the same thread with any additional documents.

**Dynamic tokens:** {Query_ID}, {Client_Name}, {Client_Email}, {Missing_Fields_List}, {Expected_Response_Timeline}.

---

## 16. Open Items / Assumptions

| #   | Item                                  | Current assumption                                                                                                                            |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Priority default value                | **Medium** (confirm).                                                                                                                         |
| O2  | Wizard step order                     | Client → Shipment → **Cargo → Legs** → Notes (cargo before legs, since legs pick cargo).                                                      |
| O3  | Chargeable weight & freight density   | **Resolved:** cargo-level, one value per row, filled by FF in Stage 4. Leg shows **Total Chargeable Weight** (Σ). No density/DG at leg level. |
| O4  | Freight density factors               | Admin-configurable reference data (not hardcoded).                                                                                            |
| O5  | Change-order record vs deferred audit | Free path this build; lightweight change-log needed when cascade is built.                                                                    |
| O6  | Tracking UI                           | Deferred to Stage 8–9; model only here.                                                                                                       |

---

_End of functional specification._
