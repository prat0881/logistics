## 1\. Purpose & Role

Stage 4 takes the legs built in Stage 3 and sends each one out for pricing: the Logistics Executive selects Freight Forwarders per leg and distributes an RFQ; each invited FF gets a secure portal scoped only to their assigned leg(s), where they set cargo density, get chargeable weight calculated, and submit an itemised quote before a deadline. The **quote** — one FF's priced bid on one leg — is the atomic unit this stage produces, mirroring how the **leg** was Stage 3's atomic unit. This build also completes the density and chargeable-weight fields Stage 3 deliberately left empty, and enforces that once an RFQ is sent, its leg data is frozen — any later change reopens the leg through a formal change-order rather than silently invalidating live quotes. The output is a set of comparable, validated quotes per leg, ready for selection in Stage 5\.

## 2\. Key Functional Decisions

These decisions shape this spec:

| \# | Decision | Effect |
| :---- | :---- | :---- |
| D1 | **RFQs are distributed per leg.** The leg (Stage 3 §7.4.2) is the biddable unit; each leg carries its own mode, stable ID, and frozen cargo details/manifest. | FF selection, distribution, quoting, and status all operate leg-wise. Legs advance independently. |
| D2 | **FFs interact via a secure, per-FF RFQ access link → RFQ Portal.** No login; access is enforced through the link itself. | The FF reviews assigned legs and submits the quote directly in the portal. |
| D3 | **One RFQ per FF per query.** The first distribution to an FF mints an RFQ Number \+ access link; assigning further legs to the same FF amends the same RFQ (adds a leg-wise section, same number, same link) and triggers an "RFQ Updated" notification. | An FF never juggles multiple links for one shipment; leg-wise sections keep quoting separated. |
| D4 | **Strict leg-level visibility.** An FF sees only the legs assigned to them — details/manifest, points, route segment, cargo rows. Never other legs, other FFs, or the client's identity and commercials. | Data isolation is enforced via the Stage 3 leg→cargo attachment and point references. |
| D5 | **The FF sets Freight Density per cargo row; the system computes Chargeable Weight per row and Total Chargeable Weight per leg.** Industry-standard defaults (fixed: Air 167 / Sea 1,000 / Road 333 kg/CBM) seed the density field. | Fills the cargo-level fields Stage 3 defined as empty/read-only (Stage 3, D4). Freight is priced on chargeable weight. |
| D6 | **Quotes are itemised by charge zone** — Origin / Main Freight / Destination — with per-line amounts and \[+ Add Charge\]; Road-only legs quote trucking charges per pickup/drop block; Grand Total auto-computes. | Guarantees structurally comparable quotes for Stage 5\. |
| D7 | **Submission deadline \= RFQ send time \+ 48 hours (default).** Enforced at platform level; tiered reminders at T-36/24/12/6/2h; unsubmitted drafts are discarded at expiry. | Deadline extension and post-expiry FF addition are out of scope (v2). |
| D8 | **FFs quote in their own selected currency.** Conversion to USD happens at quote comparison (Stage 5), not here. | Stage 4 stores quotes as entered; comparison normalises. |
| D9 | **FF-facing emails are transmitted live** (invitations, reminders, expiry notices, acknowledgements). Client-facing emails remain compose-&-log. | The FF workflow depends on real delivery of the secure link. |
| D10 | **Concurrency: first-submit-wins.** On simultaneous Distribute RFQ actions for the same leg, the first request processes; the second user's view refreshes with an explanatory message. | No record locking. |
| D11 | **Change handling follows Stage 3 §11.** RFQ send freezes the leg's details/manifest for that quote; any RFQ-defining or Structural change afterwards takes the change-order path — the leg returns to Ready for RFQ and affected quotes are invalidated. | This build realises the cascade Stage 3 deferred. |

---

## 3\. Scope

**In scope (this build):**

- FF Master (the lookup/filter source for FF selection).  
- Stage 4 workspace: query overview header, per-leg FF selection panels, Distribute RFQ per leg.  
- FF eligibility filtering by leg endpoint country \+ leg mode.  
- RFQ generation: one RFQ per FF per query, leg-wise sections, secure access link, PDF download.  
- FF-facing RFQ Portal: leg details, scoped route diagram, per-leg cargo details/manifest, density entry \+ chargeable-weight calculation, charge-zone quotation entry, transit plan, draft save, submit.  
- Deadline enforcement, reminder & expiry notifications (live email).  
- Quote receipt: FF/leg/query status updates, executive notification, quote records handed to Stage 5\.  
- Cargo details freeze at RFQ send; change-order path v1 (leg reopen on RFQ-defining or Structural change, per Stage 3 §11).

**Out of scope (this build / this phase):**

- Quote comparison, negotiation, requote, and award (→ Stage 5; the Requoted / Approved / Closed statuses are defined here but driven there).  
    
- Currency conversion to USD (→ Stage 5).  
    
- Deadline extension after expiry; adding FFs to a leg after expiry (v2).  
    
- FF Master onboarding/maintenance workflow (Admin master-data governance; defined separately).  
    
- Client-facing communication (remains Stage 3, compose-&-log).  
    
- Freight booking / execution beyond the FF's proposed transit plan (→ Stages 8–9).  
    
- Audit trail / communication log (deferred; see §11.4 for the change-log caveat).

  ## 4\. User Roles

Stage 4 introduces the first **external** actor — the Freight Forwarder.

| Role | Functional responsibilities in Stage 4 |
| :---- | :---- |
| **Logistics Executive** | Opens RFQ-Ready queries; selects FFs per leg; sets/confirms the submission deadline; distributes RFQs; monitors quote arrival; receives expiry and submission notifications; initiates change-orders on sent RFQs. |
| **Logistics Manager** | All Executive abilities; oversight/visibility across all queries and RFQs. |
| **Administrator** | All abilities; maintains reference data (deadline default, reminder schedule — both configurable; density factors are fixed industry constants, not configurable); maintains the FF Master. |
| **Freight Forwarder (external)** | Opens the RFQ via their secure link; reviews assigned leg(s) and Cargo Details/Manifest; sets Freight Density per cargo row; fills the charge-zone quotation and transit plan; saves drafts; submits the quote before the deadline. |

### 4.1 Visibility matrix — what the FF can and cannot see

| Data | Visible to FF? |
| :---- | :---- |
| Their assigned leg(s): endpoints, mode, dates, route segment | **Yes** |
| Cargo Details/Manifest of attached rows (product, qty, dims, weights, DG, MSDS) | **Yes** |
| Pickup/Delivery/Hub point details for their leg(s) | **Yes** |
| Query ID, Incoterms, submission deadline | **Yes** |
| Other legs of the same query (endpoints, cargo, route) | **No** |
| Other FFs invited, their quotes, or quote counts | **No** |
| Client identity, contacts, commercial details | **No** |
| Internal notes, checklist, escalations | **No** |
| Margins, client quotation data (later stages) | **No** |

---

## 5\. Navigation & Overall Flow

Two journeys run in parallel: the **internal workspace** (Executive) and the **FF Portal** (external, via secure link).

### 5.1 Internal — Executive journey

Query List (Stage 3\) │ status \= RFQ Ready ▼ Stage 4 Workspace (per query) ├── Query Overview header (read-only: Query ID, client ref, derived │ Modes summary, origin/destination points, roll-ups) │ ├── Leg Panel — one per leg (expand/collapse) │ • leg summary (endpoints, mode, dates, totals) \[read-only\] │ • eligible FF grid (filtered: endpoint country \+ leg mode) │ • select ≥1 FF → \[ Distribute RFQ \] (per leg) │ ▼ On Distribute: RFQ generated → live email with secure link → statuses update (FF → RFQ Sent, Leg → RFQ Sent) → event logged │ ▼ Quotes arrive → in-app notification per submission Leg: RFQ Sent → Partially Quoted → Fully Quoted │ ▼ All legs quoted / window closed → hand-off to Stage 5 (comparison)

### 5.2 External — FF journey

Email invitation (secure link) │ ▼ RFQ Portal (no login; access scoped by link) ├── RFQ header: RFQ No., Incoterms, deadline countdown, currency select ├── Leg section(s) — one per assigned leg: │ • leg details \+ scoped route diagram │ • Cargo Details/Manifest (read-only) │ • Freight Density per row → Chargeable Wt auto-computes │ • charge-zone quotation (Origin / Main Freight / Destination) │ • transit plan ├── \[ Save Draft \] (resume via same link until deadline) ├── \[ Preview \] · \[ Download RFQ PDF \] └── \[ Submit Quote \] → validation → acknowledgement email → internal notification → quote visible for Stage 5 Deadline passes without submit → link shows expired message, draft discarded, FF status → Expired

### Internal — Executive journey                           External — FF journey

![][image1]![][image2]  
---

**Workspace behaviour:**

- The Stage 4 workspace is reached by opening an **RFQ Ready** query; legs that are not Ready for RFQ cannot be distributed (§10.1).  
- Each leg panel acts independently: selection, distribution, deadline, and status per leg (Stage 3, D8).  
- Distribution is repeatable per leg only via explicit confirmation (duplicate-send guard, §8).

---

## 6\. Freight Forwarder (FF) Master

The lookup source for FF selection in this stage — same role Client Master and Vessel Master play in Stage 3\.

| Field | Type | Mandatory | Notes |
| :---- | :---- | :---- | :---- |
| S.N. | Integer (auto) | Auto | Sequential row index. |
| Company Name | Text | **Mandatory** | — |
| Company Address | Text | Optional | Registered/operating address. |
| PIC (Person in Charge) | Text | **Mandatory** | Primary contact name — recipient reference for RFQ correspondence. |
| Contact Number | Phone | **Mandatory** | Format-validated. |
| Email | Email | **Mandatory** | Recipient for RFQ invitations and notifications. |
| Available Place of Services | Multi-select (Countries) | **Mandatory** | Structured multi-select of countries served — drives leg-eligibility filtering by matching the leg's origin/destination Country (Stage 3 §7.4.1) against this list (§8). |
| Type of Mode | Multi-select | **Mandatory** | Road / Air / Sea (may serve more than one) — drives leg-eligibility filtering by mode (§8). |
| Handle DG | Checkbox (Yes/No) | Optional | Indicates whether the FF is certified/willing to handle Dangerous Goods cargo. Used to filter/flag eligibility when a leg's assigned cargo includes a DG row (Stage 3 §7.3). |
| VAT / TRN / EORI (Europe) | Text | Optional | Tax/customs registration identifier — required for customs documentation on the FF's quotes. |
| W/H Location | Text | Optional | Warehouse location(s) operated by the FF, if any — relevant when the FF also offers consolidation/staging services. |
| Default Currency | Dropdown | Optional | Pre-fills the FF's currency choice in the portal; FF may override per RFQ. |
| Payment Terms | Text | Optional | e.g. NET 15, NET 30. Kept in the FF Master; **no longer shown on the eligible-FF selection card** (Post-testing fix R1, item 5 — see §7.2.2). |
| Typical Lead Time | Text | Optional | e.g. "1d", "2d". Kept in the FF Master; **no longer shown on the eligible-FF selection card** (Post-testing fix R1, item 5 — see §7.2.2). |
| Active / Inactive | Toggle | Auto | Inactive FFs are excluded from new eligible-FF lists; existing historical RFQs are unaffected. |

**Governance:**

- The FF Master is **Admin-maintained** (creation, edits, activation status) — mirrors Stage 3's master-data governance rule.  
- Selecting an FF in Stage 4 never edits the FF Master record.  
- No inline FF creation from within Stage 4 (out of scope, this build).

**Note on DG-aware filtering:** if any cargo row attached to a leg is DG-flagged (Stage 3 §7.3), the eligible-FF list for that leg is restricted to FFs where **Handle DG \= Yes** (see validation rule in §10.1).

---

## 7\. Screens & Field Details

### 7.1 Query Overview Header

Read-only, persistent at the top of the Stage 4 workspace. All values are **derived from the Stage 3 query record** — nothing is entered here.

| Field | Source (Stage 3\) | Notes |
| :---- | :---- | :---- |
| Query ID | §7.1 | — |
| Client Name | §7.1 | — |
| Incoterms | §7.2 | — |
| Modes | Derived from legs (§6, L3) | e.g. "Road \+ Air \+ Road". |
| Origin Point(s) | Derived — pickup point(s) across all legs | May list more than one (Stage 3 D6). |
| Destination Point(s) | Derived — delivery point(s) across all legs | May list more than one. |
| Total Packages / CBM / Gross Wt | Rolled up across all legs' cargo | Per-leg totals also shown on each Leg Panel (§7.2). |
| Query Status | Stage 3 §9 | Read-only badge; e.g. "RFQ Sent — 2 of 3 legs quoted". |

> **Post-testing fix R1 (item 3):** The Totals row in the header also shows consolidated **cargo characteristic icons** deduped across all legs' cargo: Heavy / Fragile / Non-stackable (from `referenceTags`) and a **DG** indicator (from `isDangerous`). Each icon appears at most once regardless of how many cargo rows carry the tag.

> **Post-testing fix R1 (item 2):** Immediately after the query header, and **only while the query is in a pre-distribution status** (DRAFT / CREATED / RFQ_READY), a **read-only `RouteDiagram`** is displayed showing the full shipment route with hover tooltips on each node. It is purely a visualisation aid — no editing. This is distinct from the FF-scoped route diagram in §7.3.4, which is rendered inside the FF Portal and scoped to the FF's assigned legs only.

---

### 7.2 Leg Panel

One panel per leg (Stage 3 §7.4.2 leg object), independently expandable/collapsible.

#### 7.2.1 Leg summary (read-only)

| Field | Source | Notes |
| :---- | :---- | :---- |
| Leg ID | Stage 3 leg object | Stable, never renumbered. |
| Leg Name | Stage 3 leg object | — |
| Origin Point / Destination Point | Stage 3 leg object | Read-only in Stage 4 — endpoints are locked at Stage 3 Create Query and cannot be re-confirmed here. |
| Mode | Stage 3 leg object | — |
| Ready Date | Stage 3 leg object | — |
| Target Delivery | Stage 3 leg object | — |
| Cargo Details/Manifest totals (Packages / CBM / Gross Wt / Net Wt) | Stage 3 leg object roll-ups | **Post-testing fix R1 (item 4):** Net Wt is hidden when its value is 0; it is shown only when the rolled-up value is a genuine positive number. |
| Leg Status | Stage 3 §9.2, extended in §9 below | e.g. "RFQ Sent — 2 of 3\. |

#### 7.2.2 FF selection grid

| Field | Type | Entry Mode | Notes |
| :---- | :---- | :---- | :---- |
| Eligible FF list | System-filtered | Auto | Filtered from FF Master by: leg's origin/destination Country \+ leg's Mode (§8). |
| Selection (checkbox) | Checkbox/ (read-only) once that FF's status for this leg reaches RFQ Sent  | User | One or more FFs per leg. |
| FF card: Name, Country, Modes Served | Read-only | Auto | From FF Master — reference only, to aid selection. **Post-testing fix R1 (item 6):** Country is displayed as the full country name (e.g. "United Arab Emirates"), not as an ISO code. **Post-testing fix R1 (item 5):** Payment Terms and Typical Lead Time are no longer shown on the FF card (those fields remain in the FF Master and the FF Master editor; they were removed from the selection card to reduce noise). |
| FF card: Status badge | Read-only | Auto | Per Forwarder Status Lifecycle (§9.1): Select / RFQ Sent / Expired / Quoted / Requoted / Closed / Approved. |
| Eligible FF Count / Selected FF Count | Read-only | Auto | Displayed on the panel at all times. |
| Submission Deadline | DateTime | System (default) / User (override) | System-defaulted to distribution time \+ 48h; Executive may adjust before distributing (§8, S6). |
| \[ Preview RFQ \] | Action | — | Available before the first Distribute RFQ click for this leg; opens a read-only rendering of the RFQ package (leg details, Cargo Details/Manifest, route) as it will appear to the selected FF(s). Not available after RFQ Sent — the FF's own Preview (§13.2) covers review from that point on. |
| \[ Distribute RFQ \] | Action | — | Enabled only when ≥1 FF selected (§10.1). |

**Note on eligibility filtering:** an FF is eligible for a leg only if their FF Master record covers the leg's Mode **and** the leg's origin or destination Country. If no eligible FF exists, the panel shows "No eligible Freight Forwarders found for this route and mode" with options to broaden the search or view all active FFs (§10).

---

### 7.3 The RFQ (as generated)

One RFQ object exists per FF per query (§2, D3). It has RFQ-level fields (shown once) and leg-wise fields (repeated as a section per assigned leg).

#### 7.3.1 RFQ-level fields

| Field | Type | Read-only | Entry Mode | Filled By | Mandatory | Notes |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| RFQ Number | Text | Yes | Auto | System | Mandatory | Format `YAL[YY]-[NNNN]-RFQ[NNN]`. Generated on first Distribute RFQ to this FF. |
| Incoterms | Dropdown | Yes | Auto | System | Mandatory | Inherited from the query (Stage 3 §7.2). |
| Submission Deadline | DateTime | No (until distributed) | Auto (default) / User (override) | System (default); Executive (override) | Mandatory | System-defaulted to distribution time \+ 48h; Executive may adjust before distributing (§7.2.2, §8 S6). Locked once the RFQ is sent; countdown shown to FF. |
| Quote Validity Until | DateTime | No | User | Freight Forwarder | Mandatory | FF states how long their quote remains valid. |
| Currency | Dropdown | No | User | Freight Forwarder | Mandatory | FF's operating currency for this quote; pre-filled from FF Master default (§6), overridable. Selecting it updates the currency symbol across all financial fields in the portal. |

#### 7.3.2 Leg-wise fields (repeats per assigned leg)

| Field | Type | Read-only | Source | Notes |
| :---- | :---- | :---- | :---- | :---- |
| Leg Name | Text | Yes | Stage 3 leg object | — |
| Mode | Text | Yes | Stage 3 leg object | Road / Air / Sea. |
| Origin Point | Text | Yes | Stage 3 leg object | The leg's own endpoints only. |
| Destination Point | Text | Yes | Stage 3 leg object | The leg's own endpoints only. |
| Ready Date | DateTime | Yes | Stage 3 leg object | — |
| Target Delivery | DateTime | Yes | Stage 3 leg object | — |
| Cargo Details/Manifest totals (Packages / CBM / Gross Wt / Net Wt) | Numeric | Yes | Stage 3 leg object roll-ups | Scoped to this leg's attached cargo only. |

**Leg scoping:** if an FF is assigned multiple legs of the same query, each renders as its own independently expandable section within the one RFQ, navigable via a mode filter (Air/Sea/Road). RFQ-level fields (§7.3.1) apply once, shared across all sections.

#### 7.3.3 RFQ data sharing & amendment rules

- A leg-wise section shows **only** that leg's own Cargo Details/ Manifest, points, and route segment — never another leg's, even within the same RFQ or the same query (§4.1 visibility matrix).  
- Assigning this FF an additional leg on the same query **amends** the existing RFQ: a new leg-wise section is appended, the RFQ Number and access link are unchanged, and an "RFQ Updated" notification is sent (template §12).

#### 7.3.4 Scoped Route Visualization (per FF)

**Purpose:** Gives the FF a visual map of the shipment's route — but strictly limited to their own assigned leg(s), so they can see where their responsibility starts and ends without any visibility into the rest of the shipment.

**Source:** Auto-derived from the query's Stage 3 leg and point objects (Stage 3 §7.4.1–§7.4.2). Not generated from any static template or matrix — it reflects whatever legs actually exist in the query at the time the FF views it.

**Scoping rule:** the diagram renders only the leg(s) assigned to this FF in this RFQ (§4.1 visibility matrix). Legs belonging to other FFs, or unassigned legs of the same query, are never shown — not even as greyed context.

**Rendering logic:**

- Each **node** represents a Point (Pickup, Delivery, Warehouse, Airport, or Seaport — Stage 3 §7.4.1) that is an endpoint of one of this FF's assigned legs.  
- Each **edge** between two nodes represents one assigned leg, labelled with its Mode icon (truck / plane / ship).  
- **Contiguous assignment:** if this FF's assigned legs form a single unbroken chain (one leg's destination \= the next leg's origin), they render as one connected path.  
- **Non-contiguous assignment:** because divergent, multi-hub routing is permitted at the query level (Stage 3, D6), an FF can be assigned legs that don't connect to each other. In that case, each assigned leg — or contiguous group of assigned legs — renders as its **own separate segment**. Segments are never artificially joined through a leg that belongs to another FF.  
- **Live recalculation:** the diagram updates automatically whenever the underlying Stage 3 leg or point data changes (edit-time integrity, §10.5, X1) — it is always a current reflection of the FF's assignment, never a stale snapshot.

**Interaction:** clicking a node expands that leg's details (from §7.3.2) below the diagram. This is a visualisation aid only — never an input surface; the FF cannot add, remove, or edit legs or points here.

**Illustrative example** *(actual leg count/labels vary per shipment)*:

Query legs: Leg 1 (Pickup → Warehouse, Road), Leg 2 (Warehouse → Origin Airport, Road), Leg 3 (Origin Airport → Destination Airport, Air), Leg 4 (Destination Airport → Delivery, Road).

| FF assigned to | What their diagram shows |
| :---- | :---- |
| Leg 1 \+ Leg 2 (origin trucking specialist) | Pickup → Warehouse → Origin Airport — a single connected path. Legs 3 and 4 are not shown. |
| Leg 3 only (air carrier) | Origin Airport → Destination Airport — one edge, no trucking legs shown. |
| Leg 1 and Leg 4 (same FF, non-contiguous) | Two disconnected segments: Pickup → Warehouse, and Destination Airport → Delivery. Legs 2 and 3 are not shown and are not implied as connecting them. |

---

### 7.4 FF Portal — Fields per leg section

The RFQ Portal is where an invited FF reviews a leg's requirements and enters their quote. Everything below repeats once per assigned leg section (§7.3.2).

#### 7.4.1 Cargo Details / Manifest (read-only)

Sourced from the Stage 3 leg object's attached cargo rows (Stage 3 §7.4.2 "Cargo Manifest") — the complete detail of every row ticked onto this leg.

| Field | Source (Stage 3 §7.3) | Notes |
| :---- | :---- | :---- |
| PO / Reference | Cargo row | — |
| Product Name | Cargo row | — |
| Reference Tags | Cargo row | Heavy / Fragile / Non-Stackable. |
| HS / HSN Code | Cargo row | — |
| Package Type | Cargo row | — |
| DG | Cargo row | If checked, MSDS is shown; see §10 for the DG-aware validation. |
| MSDS | Cargo row | PDF, read-only for the FF. |
| Qty | Cargo row | — |
| Dims L×W×H | Cargo row | — |
| Net Wt | Cargo row | — |
| Gross Wt | Cargo row | — |
| Volume (CBM) | Cargo row (calculated in Stage 3\) | Read-only. |

Rows are grouped by pickup/delivery point for Road legs (§7.4.4) and shown as one flat table for Air/Sea Main Freight legs with no address-based grouping equivalent.

#### 7.4.2 Freight Density & Chargeable Weight (per row)

The two fields Stage 3 left empty (Stage 3, D4) are completed here.

| Field | Type | Entry Mode | Mandatory | Notes |
| :---- | :---- | :---- | :---- | :---- |
| Freight Density | Numeric (kg/CBM) | Freight Forwarder | **Mandatory** | Pre-filled with a labelled default (fixed industry constant per mode — see §8, S12); editable, label clears on edit. |
| Chargeable Weight (T) | Calculated | Auto | Auto | \- |

Leg-level **Total Chargeable Weight** (Stage 3 §7.4.2) \= Σ of this leg's row-level chargeable weights, shown read-only on the leg summary once all rows have a density.

#### 7.4.3 Charge-Zone Quotation (Air / Sea legs)

Three zones, each with editable charge lines; FF may add custom lines.

| Zone | Purpose |
| :---- | :---- |
| Origin Charges | Costs from consolidation/warehouse to the departure hub (export clearance, documentation, terminal handling, security/screening, pre-storage). |
| Main Freight Charges | The Air/Sea carriage itself (freight charge per chargeable weight, fuel surcharge, security surcharge, carrier surcharge, peak-season surcharge, heavy-piece surcharge). |
| Destination Charges | Costs from arrival hub to final handover (terminal handling, import clearance, last-mile delivery, lift-gate/handling, storage). |

| Field (per line) | Type | Entry Mode | Mandatory | Notes |
| :---- | :---- | :---- | :---- | :---- |
| Charge Line | Text (preset \+ custom) | Freight Forwarder | Mandatory set varies by mode (§10.4, Q1) | Preset lines are mode-specific defaults; \[+ Add Charge\] allows custom lines. |
| Amount | Numeric | Freight Forwarder | Mandatory for preset lines that apply | In the FF's selected currency (§7.3.1). |
| Notes | Text | Freight Forwarder | Optional | Basis/formula the FF is applying (e.g. "per 100kg", "min USD 50"). |

Main Freight Charges are calculated on the **leg's Total Chargeable Weight** (§7.4.2).

#### 7.4.3.1 Air Freight — Mandatory Charge Lines

Applies when the leg's Mode is Air. All lines below are **mandatory** — each must be priced (amount, may be 0 with a Note if genuinely not applicable) before Submit Quote succeeds (§10.4, Q1). The FF may add unlimited additional lines via \[+ Add Charge\].

**Origin Charges**

| \# | Charge Line |
| :---- | :---- |
| 1 | Export Customs Clearance |
| 2 | Documentation Charges |
| 3 | Origin THC / Airport Handling |
| 4 | Security / Screening Charges |
| 5 | Warehouse / Pre-storage at OAP |

**Main Freight Charges (Air)**

| \# | Charge Line |
| :---- | :---- |
| 1 | Air Freight Charges |
| 2 | Security Exchange (SEC) |
| 3 | Airline / Carrier Surcharge |
| 4 | Heavy Weight Surcharge |

**Destination Charges**

| \# | Charge Line |
| :---- | :---- |
| 1 | Destination THC / Airport Handling |
| 2 | Import Customs Clearance |
| 3 | Last Mile Handling / Lift Gate |
| 4 | Storage 1 Free Day Charges |

#### 7.4.3.2 Sea Freight — Mandatory Charge Lines

Applies when the leg's Mode is Sea. All lines below are **mandatory** — same pricing rule as §7.4.3.1. The FF may add unlimited additional lines via \[+ Add Charge\].

**Origin Charges**

| \# | Charge Line |
| :---- | :---- |
| 1 | Export Customs Clearance |
| 2 | Documentation Charges |
| 3 | Origin THC (Terminal Handling Charge) |
| 4 | Bill of Lading |
| 5 | Warehouse Charges |

**Main Freight Charges (Sea)**

| \# | Charge Line |
| :---- | :---- |
| 1 | Sea Freight Charges |

**Destination Charges**

| \# | Charge Line |
| :---- | :---- |
| 1 | Destination THC / Handling Charges |
| 2 | Import Customs Clearance |
| 3 | Delivery (Last Mile — Door to Door) |
| 4 | Last Mile Handling / Lift Gate |
| 5 | Storage 1 Free Day Charges |

#### 7.4.3.3 Warehouse Staging (Origin / Destination)

**Applicability:** appears once for each Warehouse Point (Stage 3 §7.4.1, point type C) that is an endpoint of any leg assigned to this FF — labelled **Origin Staging** or **Destination Staging** depending on whether it falls before or after this FF's main-carriage/trucking responsibility in their own assigned leg chain.

**Warehouse identity (read-only, sourced from the Stage 3 Warehouse Point):**

| Field | Source (Stage 3 §7.4.1, point type C) |
| :---- | :---- |
| Company Name | Warehouse Point |
| Street Address | Warehouse Point |
| City / Postal Code | Warehouse Point |
| Country | Warehouse Point |
| Warehouse Type | Warehouse Point (Consolidation / Cross-Dock / Temporary Storage / Other) |
| Contact Name / Phone / Email | Warehouse Point (if provided) |

| Field | Type | Entry Mode | Mandatory | Notes |
| :---- | :---- | :---- | :---- | :---- |
| Cargo Acceptance Window | Text | Freight Forwarder | Optional | Operating hours / cut-off time the FF commits to for cargo intake at this warehouse. |

**Staging charge lines:**

| Field (per line) | Type | Entry Mode | Mandatory | Notes |
| :---- | :---- | :---- | :---- | :---- |
| Warehousing (In / Out) | Numeric | Freight Forwarder | **Mandatory** | Fees for storing goods and the labour of moving them into and out of the facility. |
| \[+ Add Charge\] | Action | Freight Forwarder | — | For additional lines specific to this warehouse (e.g. consolidation, deconsolidation, palletising). |

> **Note — no double-charging:** drayage *to or from* the warehouse is already captured as its own Road leg under Trucking Charges (§7.4.4), since a Warehouse Point can be a leg endpoint like any other point. This section covers **in-warehouse handling only** — it does not duplicate the trucking charge for reaching the warehouse.

**Roll-up:** each Warehouse Staging subtotal is included within the Origin Charges or Destination Charges subtotal (§7.4.6) matching its position in the route. For a Road-only assignment (§7.4.4), Warehouse Staging charges are included in the Grand Total alongside Trucking Charges.

#### 7.4.4 Trucking Charges (Road legs / pickup & drop blocks)

For Road legs, and for the road portion of multimodal legs, charges are entered per pickup or drop location block rather than by zone.

| Field | Type | Entry Mode | Mandatory | Notes |
| :---- | :---- | :---- | :---- | :---- |
| Location block | Read-only | Auto | — | One block per Pickup/Delivery Point (Stage 3 §7.4.1) with its linked cargo rows, grouped by PO. |
| Trucking Type | Dropdown | Freight Forwarder | Mandatory | Dedicated / Groupage (LTL). |
| Trucking Charge | Numeric | Freight Forwarder | Mandatory | Basis selectable: per truck / per CBM / per ton / fixed. |
| Remarks | Text | Freight Forwarder | Optional | States any additional cost folded into the charge (toll, detention, loading/unloading, waiting) and why. |

For a **Road-only query** (no Air/Sea leg assigned to this FF), the Grand Total (§7.4.6) is the sum of all Trucking Charges across this FF's pickup and drop blocks — the charge-zone structure (§7.4.3) does not apply and is not shown.

#### 7.4.5 Transit Plan (FF-configurable)

| Field | Type | Entry Mode | Mandatory | Notes |
| :---- | :---- | :---- | :---- | :---- |
| Carrier / Airline / Vessel | Text/Lookup | Freight Forwarder | Optional | Proposed or booked carrier. |
| Flight / Voyage Number | Text | Freight Forwarder | Optional | If already known. |
| Departure Date | DateTime | Freight Forwarder | Mandatory | Planned departure. |
| Arrival Date | DateTime | Freight Forwarder | Mandatory | Planned arrival. |
| Carrier Surcharge | Numeric | Freight Forwarder | Optional | If distinct from §7.4.3 line items. |
| Guaranteed Transit Time | Integer (days) | Freight Forwarder | Optional | FF's committed transit time. |

#### 7.4.6 Quote Summary Totals

| Field | Formula | Notes |
| :---- | :---- | :---- |
| Origin Charges (subtotal) | Σ §7.4.3 Origin lines | Air/Sea legs only. |
| Main Freight Charges (subtotal) | Σ §7.4.3 Main Freight lines | Air/Sea legs only. |
| Destination Charges (subtotal) | Σ §7.4.3 Destination lines | Air/Sea legs only. |
| Trucking Charges (subtotal) | Σ §7.4.4 blocks | Road-only legs, or the road portion of a multimodal assignment. |
| Warehouse Staging (subtotal) | Σ §7.4.3.3 lines, across all applicable warehouses | Included within Origin/Destination Charges subtotals where applicable; included in Grand Total directly for Road-only assignments. |
| **Grand Total** | Sum of applicable subtotals above | In the FF's selected currency (§7.3.1). Converted to USD at Stage 5 comparison, not here (§2, D8). |

#### 7.4.7 Submission

**Additional fields (entered before submission):**

| Field | Type | Entry Mode | Mandatory | Notes |
| :---- | :---- | :---- | :---- | :---- |
| DG Surcharge Note | Free text | Freight Forwarder | **Mandatory if any cargo row assigned to this FF has DG checked** | Discloses what DG-related cost is included and for which row(s) — not a separate calculated charge line. |
| Terms & Conditions | Free text | Freight Forwarder | Optional | The FF's standard clauses/liability terms. |

**Actions:**

| Action | Behaviour |
| :---- | :---- |
| Save Draft | Persists progress; resumable via the same link until the deadline. Discarded if the deadline passes unsubmitted (§10). |
| Preview | Read-only view of the full quote as it will appear once submitted. |
| Download RFQ PDF | Full RFQ document with cargo and pricing data, available throughout the RFQ's life. |
| Submit Quote | Runs mandatory-field validation (§10.4); on success, locks the quote, notifies the FF and the Executive, and makes it available in Stage 5\. |

---

## 8\. System Logic

Each rule states system behaviour underlying the screens in §7.

**S1 · FF eligibility filtering.** For each leg, the eligible FF list (§7.2.2) is computed by matching the leg's origin/destination Country (Stage 3 §7.4.1 point fields) against the FF's Available Place of Services, **and** the leg's Mode against the FF's Type of Mode (§6). If any cargo row attached to the leg is DG-flagged (Stage 3 §7.3), the list is further restricted to FFs with Handle DG \= Yes.

**S2 · Leg-scoped, independent selection.** FF selection is maintained per leg. Selecting an FF for one leg has no effect on any other leg, even within the same query (Stage 3, D8).

**S3 · One RFQ per FF per query.** The first Distribute RFQ action covering a given FF mints a new RFQ Number and secure access link. Any subsequent Distribute RFQ action that includes the same FF (for a different leg of the same query) amends the existing RFQ — appends the newly assigned leg as an additional section, keeps the same RFQ Number and link, and dispatches an "RFQ Updated" notification (template §12) rather than issuing a new RFQ.

**S4 · Distribute RFQ availability.** The action is disabled until ≥1 FF is selected for that leg, and blocked if the leg fails the checks in §10.1.

**S5 · Duplicate-distribution guard.** Re-distributing to an FF already at RFQ Sent (or later) status **for the same leg** is blocked unless the Executive explicitly confirms re-distribution.

**S6 · Submission deadline.** Default \= distribution time \+ 48 hours; the Executive may adjust the value before distributing (§7.2.2). The deadline is set once per RFQ, at first distribution, and applies uniformly to every leg subsequently added to that RFQ via amendment (§8, S3) — a newly added leg does not get its own separate deadline.

**S7 · Reminder schedule.** Automated reminders fire at T-36h, T-24h, T-12h, T-6h, and T-2h before the deadline, each a distinct email to the FF. If the FF submits before a scheduled reminder, all remaining reminders for that RFQ are cancelled.

**S8 · Deadline expiry.** At the submission deadline: the Submit action is disabled in the FF Portal; any unsubmitted draft is permanently discarded (not recoverable); the FF's status (per leg, §9.1) moves to Expired; the FF and the assigned Executive are each notified (templates, §12).

**S9 · Concurrency — first-submit-wins.** If two Executives simultaneously click Distribute RFQ for the same leg with overlapping FF selections, the first request to complete processing succeeds; the second Executive's view refreshes to the current state, and if their action is no longer valid, it is rejected with an explanatory message (§2, D10).

**S10 · Manifest freeze at send.** The moment a leg's RFQ is distributed, that leg's Cargo Details/Manifest (Stage 3 §7.4.2) is frozen for the quotes being collected. This is the trigger point for the change-order path defined next.

**S11 · Change-order on RFQ-defining edits.** Any edit to a field classified **RFQ-defining** (§11.1) — and only RFQ-defining, not Quote-defining or Structural (§11.2) — on a leg that already has an RFQ Sent, Partially Quoted, or Fully Quoted status takes the change-order path (§11.2): impact preview → Executive confirms \+ states a reason → affected quotes are invalidated → the leg reopens to Ready for RFQ → the FF(s) are notified → the change is recorded. All other edits — Internal, Corrective, Quote-defining, Structural, or RFQ-defining on a leg still pre-RFQ — apply freely (free path).

**S12 · Density seeding.** Each cargo row's Freight Density field (§7.4.2) is pre-filled with the fixed industry-standard default for the leg's Mode (Air 167 / Sea 1,000 / Road 333 kg/CBM) when the FF Portal first loads. The pre-filled value carries a visible "default" label/tag distinguishing it from an FF-entered value, and remains fully editable — the FF can overwrite it per row. Once edited, the label is removed.

**S13 · Chargeable weight recalculation.** Chargeable Weight (row) and Total Chargeable Weight (leg) recompute whenever a row's Freight Density or Gross Weight changes, per the formula in §7.4.2.

---

## 9\. Status Lifecycle

Three levels of status operate in this stage: **Forwarder status** (per FF, per leg), **Leg status** (aggregate across all FFs selected for that leg), and **Query status** (rollup across all legs). This mirrors the Stage 3 pattern of leg status feeding query status (Stage 3 §9.1).

### 9.1 Forwarder status (per FF, per leg)

Shown as a badge on the FF's card within that leg's panel. Because one FF may be assigned several legs within a single RFQ, their status can differ leg by leg.

| Status | Meaning | Set by | Trigger |
| :---- | :---- | :---- | :---- |
| Select | FF selected for this leg; RFQ not yet distributed. | System | Executive ticks the FF (§7.2.2). |
| RFQ Sent | RFQ distributed to this FF, covering this leg. | System | Distribute RFQ (§8, S3/S4). |
| Expired | Deadline passed with no quote submitted for this leg. | System | Deadline reached (§8, S8). |
| Quoted | FF submitted a quote covering this leg. | System | Submit Quote (§7.4.7), validated (§10). |
| Requoted | Quote updated following negotiation. | User (Executive) | Executive records the revised quote following negotiation in Stage 5\. |
| Closed | RFQ manually closed for this FF/leg. | User (Executive) | Explicit close action. |
| Approved | This FF is awarded for this leg. | System | Stage 5 award confirmation. |

### 9.2 Leg status (aggregate across selected FFs)

Extends the Draft / Ready for RFQ statuses Stage 3 already sets (Stage 3 §9.2); this stage owns the transitions from RFQ Sent onward.

| Status | Meaning | Set by | Trigger |
| :---- | :---- | :---- | :---- |
| Draft | No FF selected yet for this leg. | System | Carried from Stage 3 if still incomplete. |
| Ready for RFQ | ≥1 FF selected but not yet distributed. | System | Stage 3 completion / FF selection made. |
| RFQ Sent | RFQ distributed to all currently-selected FFs. | System | Distribute RFQ (§8, S3/S4). |
| Partially Quoted | Some, not all, selected FFs have quoted. | System | First quote received on this leg. |
| Fully Quoted | All selected FFs have quoted (or reached Expired/Closed). | System | Last outstanding FF resolves. |
| Approved | A winning FF has been selected for this leg. | System | Stage 5 award confirmation. |
| Closed | RFQ process for this leg is complete or manually closed. | System / User | Query closure or manual close. |

A leg's status change never affects any other leg's status (Stage 3, D8). A change-order (§8, S11) can move a leg from RFQ Sent / Partially Quoted / Fully Quoted back to Ready for RFQ.

### 9.3 Query-level status roll-up

Extends the Stage 3 rollup rule (Stage 3 §9.1: query status advances only when **all** legs reach a stage).

| Query status | Derived when |
| :---- | :---- |
| RFQ Ready | All legs \= Ready for RFQ (carried from Stage 3). |
| RFQ Sent | At least one leg has reached RFQ Sent; not all legs Fully Quoted. |
| Quoted | All legs have reached Fully Quoted. |
| No Response | Every FF on every leg has reached Expired with no quote submitted. |

*(Statuses beyond this stage — Awaiting Client Decision, Won/Lost, Closed — remain query-level events defined for later stages, per Stage 3 §9.1.)*

**Resolved:** no separate Stage 0 status-lifecycle document governs this stage. The table above is the authoritative query-status list for Stage 4\.

---

## 10\. Validation Catalogue

Severity: **Blocking** (prevents the action) or **Warning** (advisory). Trigger points: *select* (FF selection), *distribute* (Distribute RFQ), *submit* (FF Submit Quote), *live* (any edit, ongoing).

### 10.1 Distribution readiness

| \# | Rule | Severity | Trigger |
| :---- | :---- | :---- | :---- |
| F1 | The leg has origin, destination, mode, ≥1 attached cargo row, and dates (Stage 3 §7.4.2, completeness). | Blocking | distribute |
| F2 | At least one Freight Forwarder is selected for the leg. | Blocking | distribute |
| F3 | A Submission Deadline is defined for the RFQ. | Blocking | distribute |
| F4 | The leg carries no unresolved Stage 3 validation errors (Stage 3 §10). | Blocking | distribute |
| F5 | If any cargo row attached to the leg is DG-flagged, every FF selected for that leg has Handle DG \= Yes (§6) — applies even if the FF was chosen via "View All Active Freight Forwarders" (§10.3, E1), bypassing the default filter. | Blocking | distribute |

### 10.2 Duplicate distribution

| \# | Rule | Severity | Trigger |
| :---- | :---- | :---- | :---- |
| F6 | Re-distributing to an FF already at RFQ Sent or later status for the same leg is blocked unless the Executive explicitly confirms re-distribution. | Blocking (soft — confirmable) | distribute |

### 10.3 Exception handling

| Scenario | System behaviour |
| :---- | :---- |
| **E1 — No eligible FF found** | Displays "No eligible Freight Forwarders were found for this route and transport mode." Offers: Modify Search Criteria, View All Active Freight Forwarders (overrides the country/mode filter; F5 still applies for DG cargo). |
| **E2 — FF inactive** | Inactive FFs are excluded from the eligible list for new selections. Existing historical RFQs referencing them are unaffected. |
| **E3 — Deadline expires with an unsubmitted FF draft** | Draft is permanently discarded (§8, S8); FF sees a submission-expired message; no recovery option. |

### 10.4 Quote submission (FF Portal)

| \# | Rule | Severity | Trigger |
| :---- | :---- | :---- | :---- |
| Q1 | Every mandatory charge line for the leg's mode is priced: all named lines for Air (§7.4.3.1), all named lines for Sea (§7.4.3.2), or the Trucking Charge for every pickup/drop block for Road (§7.4.4). | Blocking | submit |
| Q2 | Freight Density is entered for every cargo row attached to the FF's assigned leg(s) (§7.4.2). | Blocking | submit |
| Q3 | Quote Validity Until is provided, and is not earlier than the Submission Deadline. | Blocking | submit |
| Q4 | Currency is selected (§7.3.1). | Blocking | submit |
| Q5 | DG Surcharge Note is completed if any cargo row assigned to this FF is DG-flagged (§7.4.7). | Blocking | submit |
| Q6 | Departure Date and Arrival Date are provided in the Transit Plan (§7.4.5). | Blocking | submit |
| Q7 | Submission is attempted after the deadline. | Blocking | submit |
| Q8 | Warehousing (In/Out) is priced for every Warehouse Point that is an endpoint of a leg assigned to this FF (§7.4.3.3). | Blocking | submit |

### 10.5 Edit-time integrity

| \# | Rule | Severity | Trigger |
| :---- | :---- | :---- | :---- |
| X1 | Editing or removing a leg, or its attached cargo, after that leg has reached RFQ Sent or later triggers the change-order path (§8, S11) — never silently applied. | Live | any edit |
| X2 | Deactivating an FF (§6) does not retract or invalidate RFQs already distributed to them; it only removes them from future eligible-FF lists. | Live | FF Master edit |
| X3 | Editing a field classified Internal, Corrective, or Quote-defining — or an RFQ-defining/Structural field on a leg still pre-RFQ — applies immediately and re-validates, no confirmation required (§11.2, free path).  | Live | any edit |

---

## 11\. Change-Impact Handling (RFQ-stage cascade)

Stage 3 defined the impact-classification model but implemented only the free path, because no downstream work existed yet (Stage 3 §11.4). Stage 4 is where real downstream work begins — RFQs are sent, FFs quote — so this is where the change-order cascade is realised for the first time.

### 11.1 Impact classes (Stage 4 additions)

Extends Stage 3's classes (Stage 3 §11.1) with fields specific to this stage:

| Class | Examples in Stage 4 | Downstream cost |
| :---- | :---- | :---- |
| Internal | Executive notes, FF card reference data changes in FF Master | None |
| Corrective | Typo in an FF contact detail | None (cosmetic) |
| RFQ-defining | Leg origin/destination/mode, cargo weight/dims, DG flag, Incoterms — any Stage 3 field a quote was built against | High — FFs have already priced against these |
| Quote-defining | FF's own submitted price, density, transit plan | High — changes here affect Stage 5 comparison directly |
| Structural | Adding/removing an FF from a leg after RFQ Sent; adding/removing a leg | High — recomputes eligibility, distribution, and coverage |

### 11.2 The two paths

| Condition | Path |
| :---- | :---- |
| Field is Internal, Corrective, or Quote-defining — or the leg has not yet reached RFQ Sent for any FF | **Free path:** apply the edit, re-validate, no notification required. |
| An **RFQ-defining or Structural** change to a leg that has already reached RFQ Sent for one or more FFs. | **Change-order path:** impact preview → Executive confirms \+ states a reason → invalidate the affected FFs' quotes for that leg → leg reopens to Ready for RFQ → notify the affected FF(s) → record the change → leg is redistributed. |

**Resolved:** RFQ-defining and Structural changes trigger the change-order path once RFQ Sent is reached. Quote-defining changes always take the free path, regardless of RFQ status.

### 11.3 Principles

- **Minimal blast radius:** a change reopens only the leg it actually touched — editing Leg 3's cargo does not affect Leg 1 or Leg 2, even within the same query (Stage 3 §11.3; Stage 3, D8).  
- **FF-scoped, not query-scoped:** if the same FF holds quotes on multiple legs of one RFQ (§2, D3) and only one leg changes, only that leg's section is invalidated and reopened — the FF's other leg sections and their quotes are untouched.  
- **Non-destructive:** an invalidated quote is marked invalid, not deleted — it remains visible to the Executive as historical context when reviewing the redistributed leg.  
- **FF is always told why:** the change-order notification to the FF states which leg reopened and, at minimum, that shipment details changed — never a silent link update.

### 11.4 Scope for this build

This build implements the full change-order cascade for RFQ-defining and Structural changes on legs at RFQ Sent, Partially Quoted, or Fully Quoted (§9.2).

**Caveat:** a change-order needs a small record of what/why, which touches the deferred audit trail / communication log (§3, out of scope). This build implements the cascade mechanics (impact preview, confirmation, invalidation, reopening, notification) but the recording mechanism itself is not yet decided — see Open Item, §14.

**Worked example:** Leg 2 (Air) has RFQ Sent to two FFs; FF-A has already submitted a quote, FF-B has not. The Executive edits Leg 2's cargo (a row's Gross Weight changes) — an RFQ-defining field. Impact preview shows: "This will invalidate FF-A's submitted quote and update the pending request to FF-B." Executive confirms with a reason. System actions: FF-A's quote → marked invalid (Forwarder status: RFQ Sent, reset from Quoted); FF-B's pending RFQ section → cargo data refreshed in place (no new email needed, since FF-B hasn't submitted yet); Leg 2 status → reverts to Ready for RFQ; the Executive redistributes Leg 2 to trigger fresh emails/deadlines for both FFs.

---

## 12\. Emails & Notifications

All FF-facing emails in this stage are **transmitted live** (§2, D9). Dynamic tokens are resolved by the system at send time.

### 12.1 RFQ Invitation

- **Trigger:** first Distribute RFQ action covering this FF (§8, S3).  
- **From:** [logistics@yankalfa.com](mailto:logistics@yankalfa.com) · **To:** FF's Primary Contact Email (§6)  
- **Subject:** "RFQ Request – {{RFQ\_Number}} – {{Origin}} to {{Destination}}"  
- **Body:** RFQ Number, leg name(s), origin/destination, cargo summary (Total Weight, CBM, Pieces), Submission Deadline, special handling flags (DG, etc. — from Stage 3 cargo rows), and the secure RFQ Access Link.

### 12.2 RFQ Updated

- **Trigger:** a subsequent Distribute RFQ action assigns this FF an additional leg on the same query (§8, S3 amendment).  
- Same template as §12.1, subject changes to: "RFQ Updated – {{RFQ\_Number}} – New Leg Added". Body highlights the newly added leg section; the access link is unchanged.

### 12.3 Reminder Notifications

- **Trigger:** T-36h / T-24h / T-12h / T-6h / T-2h before the Submission Deadline (§8, S7).  
- **To:** the FF, for each RFQ they have not yet submitted.  
- **Content:** escalating urgency per the schedule below; each includes a direct link to the RFQ Portal.

| Timeline | Content |
| :---- | :---- |
| T-36h | Standard reminder. |
| T-24h | 1-day-out marker. |
| T-12h | Urgent countdown. |
| T-6h | Final operational-window warning. |
| T-2h | Critical final warning, with the exact cutoff timestamp. |

- Cancelled automatically once the FF submits (§8, S7).

### 12.4 RFQ Expiry

- **Trigger:** Submission Deadline reached with no quote submitted for that FF/leg (§8, S8; Forwarder status → Expired, §9.1).  
- **To FF (email):** "Your RFQ {{RFQ\_Number}} submission window has expired. No further quotes can be accepted for this RFQ."  
- **To the assigned Executive (in-app):** "{{FF\_Name}} did not submit a quote for {{Leg\_Name}} — RFQ {{RFQ\_Number}} has expired."  
- Fires automatically the moment Forwarder status transitions to Expired; no manual trigger.

### 12.5 Submission Acknowledgement

- **Trigger:** FF's Submit Quote action passes validation (§10.4).  
- **To FF (email):** confirms receipt of their quote and states the internal review timeline.  
- **To assign Executive (in-app):** real-time notification; the Comparison Dashboard (Stage 5\) updates without a manual refresh.

---

## 13\. Form Actions

### 13.1 Executive workspace (Stage 4\)

| Action | Availability | Behaviour |
| :---- | :---- | :---- |
| Select FF(s) | Per leg panel (§7.2.2) | Toggles FF selection for that leg only (§8, S2). No save required — reflected immediately in Selected FF Count. |
| Preview RFQ | Per leg panel; before the first Distribute RFQ for that leg | Opens a read-only rendering of the RFQ package as it will appear to the selected FF(s) (§7.2.2). No system state change; does not send anything. |
| Distribute RFQ | Per leg panel; enabled when ≥1 FF selected (§8, S4) | Runs §10.1 validation. On success: generates/amends the RFQ (§8, S3), sends the invitation or update email (§12.1/§12.2), updates Forwarder and Leg status (§9.1, §9.2). On failure: inline validation messages on the leg panel. **Post-testing fix R1 (item 1):** After distribution the portal link is surfaced in a selectable text field with a copy button; the copy uses `navigator.clipboard` with an `execCommand('copy')` fallback so it works over plain HTTP (no secure-context requirement). Each distributed FF's card also exposes a **"Regenerate portal link"** action that calls the existing reissue-token endpoint, invalidates the old link, and returns a fresh copyable link — used when the operator missed or lost the link from the original distribute response. |
| View eligible FFs (broaden search) | Per leg panel, on E1 (§10.3) | Removes the country/mode filter; F5 (DG eligibility) still enforced at distribute. |
| Modify Search Criteria | Per leg panel, on E1 | Returns to the filtered view; no state change. |

### 13.2 FF Portal

| Action | Availability | Behaviour |
| :---- | :---- | :---- |
| Save Draft | Any point before deadline | Persists entered values against the secure link; no validation applied. Resumable from the same link. |
| Preview | Any point before submit | Read-only rendering of the quote as currently filled (§7.4.7). This is the FF's own review of their quote-in-progress — distinct from the Executive's pre-send Preview RFQ (§7.2.2, §13.1), which shows the RFQ package rather than a quote. |
| Download RFQ PDF | Throughout the RFQ's life | Generates the full RFQ document (requirements \+ any entered pricing). |
| Submit Quote | Before deadline | Runs §10.4 validation. On success: locks the quote, fires §12.5 notifications, sets Forwarder status to Quoted (§9.1). On failure: inline errors on the missing fields; submission blocked. |

---

## 14\. Open Items / Assumptions

| \# | Item | Current status | Owner / Next step |
| :---- | :---- | :---- | :---- |
| O1 | **RFQ amendment deadline mechanics.** | **Resolved:** the original RFQ's deadline applies to all legs, including any added later via amendment — no separate deadline per added leg. | Applied in §8, S6. |
| O2 | **Executive-side "Preview RFQ."** | **Resolved:** added, available before the first Distribute RFQ for a leg only; not available after RFQ Sent. | Applied in §7.2.2, §13.1. |
| O3 | **"No Response" query status and the full query-status enumeration** (§9.3). | **Resolved:** no separate Stage 0 document exists; §9.3 is the authoritative list for this stage. | Applied in §9.3. |
| O4 | **Mandatory charge lines per leg mode** (§10.4, Q1). | **Resolved:** freight team supplied the exact named lists — lines for Air and Sea. | Applied in §7.4.3.1 (Air), §7.4.3.2 (Sea). |

---

*End of stage 4*

[image1]: <data:image/png;base64,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>

[image2]: <data:image/png;base64,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>