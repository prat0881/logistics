# YankAlfa Logistics — Stage 4: RFQ → Freight Forwarder
## Technical Design · Architecture · Data Model · APIs · Extensibility (realized) · Frontend

---

## 0. Orientation for a new session (read this first)

If you are a Claude session picking this up to build **Stage 4**, read in this order:

1. **`Stage 4 - RFQ Send to Freight Forwarder (v2).md`** — the Functional Spec (the *what*): FF selection, RFQ generation, the FF Portal, quoting, deadlines, the change-order cascade, status lifecycle (§9), validation catalogue (§10).
2. **`Stage 3 - Technical Design.md`** — the foundation this stage plugs into: the **Extensibility Core (§7)** and **§10 (scope vs reserved-for-later)** matter most. Stage 4 is the *first real plug* into that socket.
3. **This document** — the *how* for Stage 4: new modules, entities, APIs, the realized status/change machinery, and the FF Portal surface.

**Golden rules carried forward from Stage 3 §0 (do not break):**
- **Never bypass a module's service.** New modules call Stage-3 modules through their public services, never their tables. The **leg is the spine of all 9 stages** — leg reads/mutations go through `LegsService`.
- **Never hand-write a status.** All status changes go through the **Status Machine** (`StatusService.fire`); add edges by *contributing* to `StatusRegistry`.
- **Never mutate user-editable data with a raw write.** Route it through the **Change Mediator** (`ChangeMediator.apply`) so impact classification and the Free/Change-order fork happen in one place.
- **New stage = new module(s) + contributed transitions + declared impact classes.** No core rewrite.

**The atomic unit:** the **quote** — one Freight Forwarder's priced bid on one leg — mirrors how the **leg** was Stage 3's atomic unit. FF selection, distribution, quoting, status, and change-impact all operate leg-wise.

---

## 1. Decisions locked

### 1.1 Functional (from the v2 spec, D1–D11) — do not re-litigate
RFQs distributed **per leg** (D1) · FFs interact via a **secure per-FF link → RFQ Portal**, no login (D2) · **one RFQ per FF per query**, amended (not re-issued) as legs are added (D3) · **strict leg-level visibility** — an FF sees only their leg(s) (D4) · FF sets **Freight Density** per cargo row, system computes **Chargeable Weight** (D5) · quotes **itemised by charge zone** (Air/Sea) or trucking blocks (Road) (D6) · deadline = send + **48h** default, tiered reminders (D7) · FFs quote in **their own currency**, USD conversion at Stage 5 (D8) · **change handling follows Stage 3 §11** — RFQ send freezes the leg; RFQ-defining/Structural edits take the change-order path (D11).

### 1.2 Build-phase decisions (locked in brainstorming) — the deltas that shape this build
| # | Decision | Effect |
|---|---|---|
| B1 | **Six sequenced sub-builds** (§1.4), each its own spec → plan → implementation. | Ships incrementally; the FF Portal and cascade come last. |
| B2 | **FF-facing emails are compose-&-log this build** — *overrides spec D9.* Live send is reserved. | Reuses Stage 3's `EmailsService`/`EmailLog` pattern (T9). The secure link is surfaced from the logged row for testing. The scheduler still runs and still drives status. |
| B3 | **Secure link = opaque high-entropy token**, stored hashed, scoped to the RFQ's legs, valid for the RFQ's life; **submission** gated by the deadline. | §8.1. No login; the link *is* the credential. |
| B4 | **Change-order cascade is IN scope**, full trigger set (RfqDefining **and** Structural). | Realizes the Stage 3 `reopen` seam for the first time (§7). Makes the post-RFQ editable flow safe. |
| B5 | **`ChangeLog` table built now** — *flips Stage 3 T10's "reserved" no-op sink.* | The cascade needs a durable what/why (§7.4). Still **not** the full audit trail (deferred). |
| B6 | **Post-RFQ edits happen via the Stage 3 wizard** (cargo/leg/point edits, add/remove leg-cargo) **+ the Stage 4 workspace** (remove an FF from a leg). | Two entry points into the Change Mediator (§7.2). |
| B7 | **Distribute = leg-wise button + page-level "Distribute All Ready Legs"**, the batch **grouped by FF**. | A multi-leg FF gets one RFQ / one notification; the amend path is reserved for genuinely later additions (§5.2). |
| B8 | **Road trucking = one charge + Remarks** (no `[+ Add Charge]`). Air/Sea zones and Warehouse staging **do** allow custom lines. | §4.2 `TruckingCharge` has no custom-line child; `ChargeLine`/`WarehouseStagingLine` do. |
| B9 | **Navigation = Query Workspace hub + stage rail**; the Stage 3 wizard is **re-parented** as the "Create" panel. | §9.1. Scales across all 9 stages; handles reopen/back-navigation. Requires a light, coordinated rehoming of the Stage 3 shell. |

### 1.3 Technical (this build) — extends Stage 3 §1.2 (T1–T11)
| # | Decision | Note |
|---|---|---|
| S4-T1 | **New modules** `freight-forwarders`, `rfq`, `quotes` + contributions to `status`/`changes`. | §2.2. No core rewrite. |
| S4-T2 | **FF Portal is a separate, unauthenticated route tree** (`/ff/rfq/:token`, path-based — no subdomain, O-S4-1) with its own minimal shell. | §8.1, §9.5. No app chrome, no session — data isolation by construction. |
| S4-T3 | **Isomorphic chargeable-weight & quote-totals engine** in `packages/shared`. | §6. Mirrors the route-validation engine: one source of truth, client + server. |
| S4-T4 | **PDF generation via `pdfkit`**, server-side streamed. | §8.4. Mirrors the `exceljs` streaming pattern (Stage 3 §8.6). |
| S4-T5 | **RFQ reminder/expiry scheduler reuses `@nestjs/schedule` cron-poll** + `RfqReminder` rows. | §8.2. Mirrors the Escalation model (Stage 3 §8.2); no Redis/BullMQ. |
| S4-T6 | **Density & chargeable weight are per-quote, not per-cargo-row.** | §4.3 — corrects the Stage 3 `CargoItem` columns, which cannot hold per-FF values. |

### 1.4 Sub-build sequence (B1)
1. **FF Master** — `freight-forwarders` module + admin screens.
2. **RFQ engine + status/quote machines** — data model, RFQ mint/amend, token, `status`/`changes` contributions.
3. **Internal RFQ workspace** — Query Workspace hub + stage rail, leg panels, eligibility filtering, FF selection, Distribute (leg-wise + Distribute All), manifest freeze.
4. **FF Portal + quoting** — token access, scoped route diagram, density/chargeable weight, mode-driven quotation, transit plan, draft/preview/PDF/submit.
5. **Notifications + deadline/reminder scheduler** — compose-&-log templates, `RfqReminder` cron, expiry sweep.
6. **Change-order cascade** — scope resolver, impact preview, invalidate/reopen saga, re-distribute, `ChangeLog`.

---

## 2. Architecture

### 2.1 Still one modular monolith
Stage 4 arrives as **new modules that depend on Stage-3 modules through their service interfaces**, never their tables — exactly the extension shape Stage 3 §2.1 was built for. Boundaries stay enforced by NestJS provider visibility + the ESLint import-boundary rule. No microservices, no new datastore.

### 2.2 Module map — additions to `apps/api/src/modules/`
| Module | Owns | Public service (examples) |
|---|---|---|
| `freight-forwarders` | **FF Master** (lookup + eligibility source) | `FreightForwardersService` |
| `rfq` | **RFQ aggregate**: mint/amend, access token, distribution, reminders, PDF | `RfqService`, `RfqTokenService` |
| `quotes` | **Quote** capture: density lines, charge lines, trucking, warehouse, transit, submission | `QuotesService` |
| *(contrib)* `status` | Stage-4 **leg forward edges** + **Quote machine** + query-rollup extension | `StatusRegistry.contribute(…)` |
| *(contrib)* `changes` | **ScopeResolver** override + **ChangeOrder** strategy + `ChangeLog` | `scope.resolver`, `ChangeOrderStrategy` |
| *(reuse)* `emails` | FF-facing templates (compose-&-log) | `EmailsService` |
| *(reuse)* `notifications` | quote-received / expiry / reopened in-app feed | `NotificationsService` |
| *(reuse)* `files` | MSDS read-through to the portal | `FilesService` |
| *(reuse)* `config` | fixed density factors (seed), currency list | `ConfigService` |

`FreightDensityFactor` (Stage 3 §4.2, `config`) already exists — Stage 4 **reads** it to seed the portal; the factors remain fixed industry constants, not FF-editable.

### 2.3 Repo layout — additions
```
apps/web/src/features/
├─ query-workspace/     # NEW shared shell: header + stage rail (hosts all stage panels)
├─ rfq-workspace/       # Stage-4 internal: leg panels, FF selection, distribute, impact-preview
├─ ff-portal/           # NEW separate unauthenticated app surface (/ff/rfq/:token)
└─ masters/freight-forwarders/   # FF Master list + editor
packages/shared/
└─ src/quote/           # chargeable-weight + quote-totals engine + Zod schemas (isomorphic)
```

### 2.4 Stage-readiness — first real exercise
Stage 4 is where the Stage-3 seams stop being theoretical: `StatusRegistry.contribute` gets its first forward edges, the `ScopeResolver` starts returning real downstream work, and the `ChangeOrder` strategy fires for the first time. If any of these needs a shape change to fit Stage 4, fix it **in the core once** so Stages 5–9 inherit it — do not fork the pattern per stage.

---

## 3. Tech stack — additions
- **Backend:** `pdfkit` (RFQ PDF, streamed) · Node `crypto` (token mint + SHA-256 hash) · reuse `@nestjs/schedule` (reminders/expiry) · reuse `@nestjs/event-emitter` (status events).
- **Frontend:** reuse the full Stage-3 stack. The **FF Portal is a separate React route tree** with no auth context, no app nav, its own minimal shell. The scoped route diagram reuses the Stage-3 `RouteDiagram`, filtered to the FF's legs.
- **Shared:** extend `packages/shared` with FF/RFQ/quote Zod schemas + the **chargeable-weight & quote-totals engine** (§6).

---

## 4. Data model

### 4.1 Relationship map (additions)
```
Query ──▶ Rfq (one per FF per query) ──ffId──▶ FreightForwarder
             │  rfqNumber · accessTokenHash · deadline · currency? · validity?
             ├──▶ Quote (one per leg in this RFQ)  ──legId──▶ Leg
             │       status(Forwarder status) · manifestSnapshot · totals
             │       ├──▶ QuoteCargoLine ──cargoItemId──▶ CargoItem   (density + chargeable wt, per FF)
             │       ├──▶ ChargeLine           (Air/Sea zones: preset + custom)
             │       ├──▶ TruckingCharge        (Road blocks: one charge + remarks)
             │       ├──▶ WarehouseStagingLine  (per warehouse endpoint: preset + custom)
             │       └──▶ TransitPlan (1:1)
             └──▶ RfqReminder (T-36/24/12/6/2h)
ChangeLog ▶ (polymorphic: entity + id + queryId + reason + affected scope)
```

### 4.2 New entities by module
Every table carries `id` (uuid), nullable `tenantId`, `createdAt`/`updatedAt` (Stage 3 §4.2 convention). `ᵁ`=unique, `ᶠᵏ`=foreign key.

**`freight-forwarders`**
| Entity | Key columns | Notes |
|---|---|---|
| **FreightForwarder** | **freightForwarderCode** ᵁ (`FF-####`), companyName ᵁ, address?, pic, contactNumber, email, **availableCountries[]**, **modes[]** (ROAD·AIR·SEA), **handleDg** (bool), vatTrnEori?, whLocation?, **defaultCurrency**?, paymentTerms?, typicalLeadTime?, **status** (ACTIVE·INACTIVE) | Admin-maintained. `freightForwarderCode` minted via `CodeSequence` (key `FREIGHT_FORWARDER`), mirroring `VS-`/`CL-`. `availableCountries`+`modes`+`handleDg` drive eligibility (§8-spec S1). Inactive → excluded from new eligible lists; historical RFQs unaffected. |

**`rfq`**
| Entity | Key columns | Notes |
|---|---|---|
| **Rfq** | queryId ᶠᵏ, freightForwarderId ᶠᵏ, **rfqNumber** ᵁ (`YAL[YY]-[NNNN]-RFQ[NNN]`), **accessTokenHash** ᵁ, submissionDeadline, incoterms (snapshot), **currency**?, **quoteValidityUntil**? | **unique(queryId, freightForwarderId)** enforces D3 (one RFQ per FF per query). `currency`+`validity` are RFQ-level (FF-entered once, shared across legs). Deadline set once at first distribute (spec S6); reset only on change-order re-distribute. |
| **RfqReminder** | rfqId ᶠᵏ, **tier** (T36H·T24H·T12H·T6H·T2H), dueAt, firedAt?, cancelledAt? | Mirrors `Escalation`. Cron fires *due & unfired & not cancelled*; all cancelled on submit (spec S7). |

**`quotes`**
| Entity | Key columns | Notes |
|---|---|---|
| **Quote** *(the atomic unit)* | queryId ᶠᵏ, legId ᶠᵏ, freightForwarderId ᶠᵏ, rfqId ᶠᵏ?, **status** (SELECT·RFQ_SENT·QUOTED·EXPIRED·INVALID·REQUOTED·CLOSED·APPROVED), **manifestSnapshot** JSONB?, totalChargeableWeightT?, grandTotal?, dgSurchargeNote?, termsConditions?, submittedAt? | **unique(legId, freightForwarderId)** — one engagement per FF per leg, from tick to submission. The row **is** the FF selection: created at `SELECT` (rfqId null), deletable while still `SELECT` (deselect); `rfqId` + `manifestSnapshot` set at distribute (freeze). `status` **is** the Forwarder status (spec §9.1). Totals persisted on submit for a stable Stage-5 record. |
| **QuoteCargoLine** | quoteId ᶠᵏ, cargoItemId ᶠᵏ, **freightDensity** (kg/CBM), **chargeableWeightT** | unique(quoteId, cargoItemId). Per-FF density (seeded from `FreightDensityFactor`, editable); chargeable wt computed by §6 engine. |
| **ChargeLine** | quoteId ᶠᵏ, **zone** (ORIGIN·MAIN_FREIGHT·DESTINATION), label, **isPreset** (bool), presetKey?, amount, note?, sortOrder | Air/Sea only. Presets (§7.4.3.1/.2 of spec) seeded on portal load; custom lines via `[+ Add Charge]` = rows with `isPreset=false`. |
| **TruckingCharge** | quoteId ᶠᵏ, legEndpointPointId ᶠᵏ, **truckingType** (DEDICATED·GROUPAGE), **basis** (PER_TRUCK·PER_CBM·PER_TON·FIXED), amount, remarks? | One block per Pickup/Delivery Point. **No custom-line child** (B8) — extras fold into `remarks`. |
| **WarehouseStagingLine** | quoteId ᶠᵏ, warehousePointId ᶠᵏ, **position** (ORIGIN·DESTINATION), label, isPreset, amount, note?, cargoAcceptanceWindow? | One "Warehousing (In/Out)" preset per warehouse endpoint + custom lines. Position inferred from the FF's leg-chain order (§6, attention). |
| **TransitPlan** | quoteId ᶠᵏ ᵁ, carrier?, flightVoyageNo?, **departureDate**, **arrivalDate**, carrierSurcharge?, guaranteedTransitDays? | 1:1 with Quote. Dep/arr mandatory (spec Q6). |

**`changes`**
| Entity | Key columns | Notes |
|---|---|---|
| **ChangeLog** (append-only) | entity, entityId, queryId ᶠᵏ, actorId, **reason**, fieldChanges JSONB, affectedScope JSONB, at | The "middle tier" (Stage 3 §7.7). Written by the `ChangeOrder` strategy only. Distinct from `StatusTransition` (auto) and the deferred audit trail. |

### 4.3 Modeling decisions
1. **Density & chargeable weight are per-FF (per-quote), not cargo-row properties (S4-T6).** They are *pricing assessments each FF makes*, not physical facts of the cargo — so several FFs quoting the same leg legitimately hold **different** densities and totals. The FF-wise design:
   - **`QuoteCargoLine`** — one row per (FF's quote × cargo row) — holds that FF's `freightDensity` (seeded from the fixed `FreightDensityFactor` by mode, editable, label clears on edit per spec S12) and the computed `chargeableWeightT = max(grossWtT, cbm × density / 1000)` (§6).
   - **`Quote.totalChargeableWeightT`** = Σ *that FF's* `QuoteCargoLine`s — a **per-FF leg total**; two FFs on one leg can differ.
   - The **shared, immutable** cargo facts (gross, dims, CBM) stay on the frozen `Quote.manifestSnapshot` (and `CargoItem`) — identical across FFs, so Stage-5 comparison lines the cargo up while each FF's density/chargeable weight sits beside it.
   - Consequently the Stage-3 `CargoItem.freightDensity`/`chargeableWeight`, `Leg.totalChargeableWeight`, and `LegCargo.manifestSnapshot` columns are **dropped** in a Stage-4 migration (O-S4-3) — all four are null in every Stage-3 row (never populated), so the drop is non-destructive.
2. **RFQ identity = (queryId, ffId).** One row, one number, one link — forever (D3). Additional legs *amend* by adding `Quote` rows under the same `Rfq`.
3. **Manifest freeze is per `Quote` (per FF per leg), captured at distribute.** This is correct across timing skew (leg sent to FF-A Monday, FF-B Wednesday, cargo edited Tuesday). The Stage 3 `LegCargo.manifestSnapshot` reservation is **superseded** by `Quote.manifestSnapshot`.
4. **Non-destructive invalidation.** A change-order sets `Quote.status = INVALID` and keeps the row (+ its lines) as history; it is never deleted (spec §11.3).
5. **Token stored hashed.** `accessTokenHash = sha256(token)`; the raw token exists only in the (logged) email link. Lookup by hash.

### 4.4 ID generation — `YAL[YY]-[NNNN]-RFQ[NNN]`
The `YAL[YY]-[NNNN]` prefix is the parent `queryCode` (Stage 3 §4.4). The `RFQ[NNN]` suffix is a **per-query RFQ sequence** — a row-locked counter scoped to the query, incremented inside the mint transaction (same pattern as `QuerySequence`). Minted on **first Distribute** to an FF; immutable thereafter.

### 4.5 Derived vs stored
- **Computed by the §6 engine (not stored until submit):** `QuoteCargoLine.chargeableWeightT`, `Quote.totalChargeableWeightT`, zone subtotals, `Quote.grandTotal`. **Persisted on submit** so Stage-5 comparison reads a stable snapshot even if reference data later changes.
- **Derived-on-read, never stored:** Leg status, Query status (projected from Quote statuses via the machine/projector, §7.1); Eligible/Selected FF counts.
- **Stored:** `Quote.status` (system-only via the machine), `Quote.manifestSnapshot` (frozen).

### 4.6 Tenant-readiness
All new tables carry nullable `tenantId` and pass through the scoping interceptor (Stage 3 §4.6). **Exception:** the unauthenticated portal resolves scope from the **token**, not the tenant interceptor — the token's `Rfq` fixes the tenant + the visible legs (§8.1).

---

## 5. API surface (REST, NestJS) — additions

### 5.1 Conventions
Same as Stage 3 §5.1: `/api` prefix, Zod DTOs from `packages/shared`, RBAC guard, `422 { findings: Finding[] }` envelope. **Portal routes are the exception** — unauthenticated, guarded by a **token guard** (§8.1) instead of the JWT/RBAC guard, rate-limited, and scoped strictly to the token's RFQ.

### 5.2 Endpoints by area
| Area | Endpoints | Notes |
|---|---|---|
| **FF Master** (Admin) | `GET /freight-forwarders` (search/filter/paginate) · `POST` · `GET/PATCH /freight-forwarders/:id` | CRUD; never edited from within Stage 4. |
| **Eligibility** | `GET /queries/:id/legs/:legId/eligible-ffs?broaden=bool` | Filters by endpoint country + mode + DG (spec S1); `broaden` returns all active FFs (E1), DG guard still enforced at distribute. |
| **Selection** | `PUT /queries/:id/legs/:legId/ff-selection` (body: `ffIds[]`) | Per-leg tick (spec S2); reflected in Selected-FF-Count. |
| **Preview RFQ** | `GET /queries/:id/legs/:legId/rfq-preview` | Read-only package as the FF will see it; pre-first-distribute only (spec §7.2.2). |
| **Distribute** | `POST /queries/:id/legs/:legId/distribute` · `POST /queries/:id/distribute-all` | Runs §10.1 (spec) checks → mint/amend RFQ (grouped by FF for `distribute-all`, B7) → freeze → compose-&-log invite/update → fire statuses. |
| **RFQ (internal)** | `GET /queries/:id/rfqs` · `GET /rfqs/:id/pdf` | Executive views/downloads. |
| **Portal** *(token-guarded, under `/ff/*`)* | `GET /ff/rfq/:token` (resolve scope) · `PATCH /ff/rfq/:token/quotes/:legId` (draft save, no validation) · `POST /ff/rfq/:token/quotes/:legId/submit` · `GET /ff/rfq/:token/pdf` | The whole `/ff/*` prefix uses the `RfqTokenGuard` only (never JWT/RBAC). Strictly scoped to the token's legs (D4). Submit runs §10.4 (spec) via the §6 engine. |
| **Change-order** | `POST /queries/:id/changes/preview` · `POST /queries/:id/changes/apply` (body: patch + **reason**) | Preview = impact without applying; apply = the cascade saga (§7.2). Ordinary edits still flow through `PATCH /queries/:id/...` (Change Mediator decides free vs change-order). |
| **Notifications** | *(reuse Stage 3)* | + quote-received / expiry / reopened event types. |

### 5.3 Error / validation envelope
Unchanged — `Finding[]` (`{ rule, severity, scope, message }`). The §6 quote engine emits the **same shape** as the route engine, so the portal and workspace render findings through one code path.

---

## 6. Chargeable-weight & quote-totals engine
*(mirrors the Stage 3 route-validation engine, §6)*

### 6.1 Location & signature
Pure, isomorphic functions in `packages/shared/src/quote`, no Nest/DB deps:
```ts
computeChargeableWeight(grossWtT, cbm, densityKgPerCbm) → number   // max(gross, cbm × density / 1000)
computeQuoteTotals(quote) → { zoneSubtotals, truckingSubtotal, warehouseSubtotal, totalChargeableWeightT, grandTotal }
validateQuote(quote, mode, deadline) → Finding[]                   // spec §10.4 Q1–Q8
```

### 6.2 Catalogue coverage
Implements spec §10.4 (submit): Q1 mandatory charge lines per mode · Q2 density on every row · Q3 validity ≥ deadline · Q4 currency · Q5 DG surcharge note · Q6 transit dep/arr · Q7 not past deadline · Q8 warehouse in/out per warehouse endpoint.

### 6.3 Client + server usage
Runs **client-side** in the portal for live chargeable-weight and Grand-Total recalculation as the FF types (spec S13), and **authoritatively server-side** at submit. One codebase, zero drift.

### 6.4 Warehouse Origin/Destination inference *(attention)*
A warehouse endpoint is labelled **Origin** or **Destination** staging by its position in the FF's own assigned leg-chain (spec §7.4.3.3). This is real logic, not a label: build the FF's leg subgraph (reusing the Stage-3 routing primitives), order it, and classify each warehouse node as before/after the FF's main-carriage responsibility. Covered by unit tests alongside the engine.

---

## 7. Extensibility Core — **realized**
*(Stage 3 §7 built the socket as a stub that could never fire; Stage 4 is the plug.)*

### 7.1 Status Machine extensions
Contributed via `StatusRegistry.contribute` — **no edit to Stage-3 code**:

**Leg machine — Stage-4 forward edges** (states already reserved in the enum, Stage 3 §7.2):
```
READY_FOR_RFQ ──distribute──▶ RFQ_SENT ──first quote──▶ PARTIALLY_QUOTED ──last resolves──▶ FULLY_QUOTED
        ▲                                                                                        │
        └──────────────────────── reopen (change-order) ─────────────────────────────────────────┘
```
- **Guards:** `distribute` requires spec §10.1 F1–F5 pass. `reopen` is the change-order-driven reverse edge (already declared, Stage 3 §7.2).
- **Leg-status derivation from Quote statuses** (the aggregate, spec §9.2): first `Quote → QUOTED` ⇒ PARTIALLY_QUOTED; all selected FFs **resolved** (QUOTED/EXPIRED/CLOSED) ⇒ FULLY_QUOTED.

**Quote machine — new** (`key: 'quote'`; the Forwarder status, spec §9.1):
```
SELECT ─distribute─▶ RFQ_SENT ─submit─▶ QUOTED
                        │                  │
                        ├─deadline─▶ EXPIRED
                        └─change-order─▶ INVALID ─(re-distribute)─▶ RFQ_SENT
   (REQUOTED · CLOSED · APPROVED reserved — driven by Stage 5)
```

**Query rollup extension** — the projector (`deriveQueryStatus`, Stage 3 §7.2) gains Stage-4 outputs: any leg ≥ RFQ_SENT and not all FULLY_QUOTED ⇒ **RFQ Sent**; all legs FULLY_QUOTED ⇒ **Quoted**; every Quote on every leg EXPIRED ⇒ **No Response**. Least-advanced gate unchanged.

> **Status ≠ distribution granularity.** `distribute-all` (B7) still fires `distribute` per leg — each leg's status moves individually; the query status is always the rollup. The leg stays the atomic unit.

### 7.2 Change-Order strategy — realized
The one mediator (`ChangeMediator.apply`) is unchanged; Stage 4 supplies the two pieces Stage 3 stubbed:

1. **ScopeResolver override** — `downstreamWork(scope)` now answers *"do any non-INVALID Quotes reference these legs at RFQ_SENT+?"* (was hardcoded `false`).
2. **Impact declarations** — new fields registered via `ImpactRegistry.declare`:
   - `quotes` module: `@delete` (remove an FF from a sent leg) = **Structural** (change-order — voids that FF's quote, recomputes coverage); `@create` (add an FF) = **free path** — a new distribution that invalidates nothing. FF's own price/density/transit = **PricingAwardDefining** (always free path — Stage 5's concern).
   - Existing `cargo`/`legs`/`queries` declarations (weight/dims/DG, origin/dest/mode/dates, incoterms) already = **RfqDefining** — no change needed; they simply start hitting the change-order path now that downstream work exists.
3. **`ChangeOrderStrategy`** (the saga, one transaction):
```
preview  → compute minimal affected scope (legs touched × their non-INVALID quotes); return, apply nothing
apply    → require reason
   a  apply the edit; re-freeze affected Quote.manifestSnapshot
   b  submitted quotes → status QUOTED→INVALID (kept); pending quotes → snapshot refreshed in place
   c  statusService.fire('leg', legId, 'reopen')   ← THE SEAM → RFQ_SENT/…→ READY_FOR_RFQ
   d  StatusTransition rows written; leg.status.changed emitted; query rollup recomputes
   e  changeLog.record({ fieldChanges, reason, affectedScope, actor })   ← REAL (B5)
   f  compose-&-log "leg reopened" to affected FF(s)
→ Executive manually re-distributes the leg (fresh +48h deadline; affected FF(s) re-notified, compose-&-log)
```

### 7.3 Blast radius (spec §11.3) — enforced by construction
The resolver names **only the touched leg's** quotes; `reopen` fires only for that leg. An FF holding quotes on other legs of the same RFQ keeps them — invalidation is `Quote`-scoped (per leg per FF), not `Rfq`-scoped. A `legName` typo (Corrective) stays free-path even post-RFQ.

### 7.4 Logging tiers (Stage 3 §7.7) — the middle tier lands
`StatusTransition` (auto, cascade reads prior state from it) **+ `ChangeLog`** (the change-order's durable what/why, B5). Full audit trail still deferred. The three are not substitutes.

---

## 8. Cross-cutting concerns — additions

### 8.1 FF Portal auth — token, not session
- **Mint:** 256-bit `crypto.randomBytes` at first distribute; the raw token goes only into the link; `sha256` stored as `Rfq.accessTokenHash`.
- **Guard:** a Nest **`RfqTokenGuard`** resolves `:token` → `Rfq` by hash; injects a **scoped context** = that RFQ's legs only. Every portal query filters by this scope — an FF can never address another leg/FF/query (D4). No JWT, no cookie, no RBAC.
- **Boundary (O-S4-1 — path-based, not a subdomain):** the FF SPA lives at `/ff/rfq/:token` and its API under `/ff/rfq/:token/*`. The token guard applies to the **whole `/ff/*` prefix and is the only guard there** — the internal JWT cookie is never honored on `/ff/*` (even though, same-origin, the browser may send it). **Data isolation stays server-enforced by the token scope, independent of the shared origin/bundle** — the frontend split is convenience, the server scope is the guarantee.
- **Transport (interim):** served over **plain HTTP** while there is no domain/certificate. Safe **for this phase only**, because emails are compose-&-log (B2) — no real token is transmitted to an external FF yet. ⚠️ **Go-live gate:** a bearer token in a URL over cleartext HTTP is network-interceptable, so **TLS (domain + cert) is mandatory before live email / real external FFs** — it lands together with the B2 live-send swap.
- **Validity:** the link is valid for the **RFQ's life** (read + PDF "throughout", spec §13.2); **submission** is separately gated by `submissionDeadline`. Same token survives a change-order (D3 "same link") — the reopened section refreshes and the deadline resets; no rotation.
- **Hardening:** rate-limit per token + per IP; no enumeration (hash lookup, constant-time); the portal SPA carries no internal data or routes and is served `noindex`.

### 8.2 Reminder & expiry scheduler
Reuse `@nestjs/schedule` cron-poll (every minute, single replica — Stage 3 §8.2). On distribute → create `RfqReminder` rows (dueAt = deadline − 36/24/12/6/2h). Cron picks *due & unfired & not cancelled* → composes-&-logs the reminder + writes a `Notification`. On submit → cancel remaining. A separate **expiry sweep**: at `submissionDeadline`, disable submit, **discard the unsubmitted draft** (permanent, spec S8/E3), fire `quote → EXPIRED`, notify FF + Executive. All timing is **UTC-instant offset math — timezone-agnostic**, so no DST/zone edge cases in firing (O-S4-5).

### 8.3 Emails — compose-&-log (B2)
Reuse `EmailsService`/`EmailLog`. New templates (spec §12): RFQ Invitation, RFQ Updated, Reminder ×5, Expiry, Submission Acknowledgement. Rendered with dynamic tokens, `status = LOGGED`, **not transmitted**. The secure link is read from the logged row for testing. **Live send is a transport swap later**, not a redesign (the token/link model is already final). Timestamps in templates (esp. the T-2h "exact cutoff") render in the **org timezone + explicit IANA label** *and* as a duration, via Stage-3 `timezone.ts` helpers (O-S4-5, Option A); the FF's personalised local view lives in the portal countdown.

### 8.4 PDF generation
`RfqPdfService` streams via `pdfkit` (mirrors `exceljs`, Stage 3 §8.6): the full RFQ document (leg details + cargo manifest + any entered pricing), available throughout the RFQ's life to both the Executive (`/rfqs/:id/pdf`) and the FF (`/ff/rfq/:token/pdf`).

### 8.5 Concurrency
- **Distribute:** first-submit-wins on simultaneous same-leg distributes (spec S9/D10); the second refreshes with an explanatory message. No record locking.
- **Quote draft:** last-write-wins (Stage 3 §8.5).
- **Change-order:** the saga runs in one transaction; a `Quote` submitted a moment before is invalidated by the cascade like any other.

### 8.6 File storage
MSDS (Stage 3 `FilesService`) is surfaced **read-only** to the FF through the token-scoped portal — the file is served only when its cargo row belongs to a leg in the token's scope.

### 8.7 Post-testing fixes — Round 1 (branch: fix/stage-4-testing-r1)

No schema or API changes. Six UI/UX fixes shipped as web-only helpers:

- **`copyToClipboard(text: string): Promise<boolean>`** — uses `navigator.clipboard.writeText` with an `execCommand('copy')` textarea fallback so portal-link copy works over plain HTTP (no secure-context assumption — TLS is a go-live gate, §8.1).
- **`PortalLinkRow({ url })`** — selectable text field + copy button wrapping `copyToClipboard`; rendered on the FF card after a successful distribute.
- **`getCountryName(code: string): string`** — resolves an ISO country code to its full display name using the static `COUNTRIES` reference list; used on FF selection cards.
- **`CargoTagIcons({ cargo })`** — renders deduplicated Heavy / Fragile / Non-stackable (from `referenceTags`) + DG (from `isDangerous`) icons across all cargo rows; shown in the Query Overview Header Totals area.
- **`RegeneratePortalLink({ queryId, freightForwarderId })`** — per-FF action component on the selection card; calls the existing `POST /queries/:id/rfqs/reissue-token` endpoint (PR #29) and renders the fresh link via `PortalLinkRow`.
- **`useReissueToken(queryId)`** — TanStack mutation wrapping the reissue endpoint; returns `mutateAsync(ffId): Promise<ReissueTokenResult>`.
- **`RouteDiagram` (read-only)** — reused with hover tooltips and no editing; displayed in the Query Workspace after the header, visible only while the query is in a pre-distribution status (DRAFT / CREATED / RFQ_READY).

---

## 9. Frontend architecture & screens

### 9.1 Query Workspace hub + stage rail (B9) — the shared shell
`/queries/:id` becomes the persistent per-query home:
```
┌ header: Query ID · client · status badge · modes · origin→destination · key dates ┐
├ stage rail: ①Create ─ ②RFQ ─ ③Compare&Award ─ ④Booking ─ ⑤Tracking  (status-gated) ┤
└ stage panel: the current stage's workspace                                          ┘
```
- The **Stage 3 wizard is re-parented** as the ①Create panel (internals untouched). ②RFQ is Stage 4's workspace. Future stages append.
- **Status-gated rail:** RFQ unlocks at `RFQ_READY`, Compare at `Quoted`, etc.; locked stages show a reason.
- **Traversal:** Create-success advances the rail + offers "Proceed to RFQ →"; the Query List opens a query **at its current stage**; a change-order jumps back to ①Create then returns to ②RFQ to re-distribute.
- **Sequencing:** the shell is the head of sub-build 3 and re-parents the wizard — coordinate the rehoming with the in-flight Stage-3 fix branch (merge-order note, §1.2 B9).

### 9.2 Routes / screens
| Route | Screen | Roles |
|---|---|---|
| `/queries` | Query List — status-aware row actions (Open/Send RFQ/Compare/Track) | Exec+ |
| `/queries/:id` | **Query Workspace** (header + rail + current panel) | Exec+ |
| `/queries/:id` ②RFQ panel | **RFQ workspace** — overview header, leg panels, FF grid, distribute | Exec+ |
| `/masters/freight-forwarders(/:id)` | **FF Master** list + editor | Admin/Manager |
| `/ff/rfq/:token` | **FF Portal** — separate unauthenticated shell (path-based, HTTP for now) | *(external FF)* |

### 9.3 Feature folders
`query-workspace/` (shell + stage rail) · `rfq-workspace/` · `ff-portal/` · `masters/freight-forwarders/`. Shared quote engine + schemas in `packages/shared/src/quote`.

### 9.4 RFQ workspace decomposition (internal)
`QueryOverviewHeader` (derived, read-only) · `LegPanel` (expand/collapse) → `LegSummary` + `EligibleFfGrid` (FF cards, status badges, checkboxes, counts, deadline field) · `DistributeBar` (leg-wise + Distribute-All with per-FF grouping preview; **soft warning when amending an already-sent FF whose deadline is <12h out**, O-S4-6) · `PreviewRfqDialog` · `DuplicateSendConfirm` · `ImpactPreviewDialog` (change-order: what-breaks + mandatory reason).

### 9.5 FF Portal decomposition (external, unauthenticated)
`PortalShell` (RFQ header: no., incoterms, deadline countdown, currency, validity) · per-leg `LegSection` → `ScopedRouteDiagram` (contiguous/non-contiguous segments) + `CargoManifestTable` (read-only) + `DensityChargeableGrid` + mode-driven `ChargeZonePanel` (Air/Sea) / `TruckingBlocks` (Road) / `WarehouseStaging` + `TransitPlanForm` · `SubmissionBar` (DG note, T&C, Save Draft/Preview/PDF/Submit).

### 9.6 Screen states (spec "wherever applicable")
Empty/loading/error throughout; **no-eligible-FF** (E1: broaden / view-all); portal **expired-link**, **already-submitted**, **invalid/revoked-token** terminal screens.

### 9.7 Shared validation on the client
The §6 quote engine runs live in the portal (chargeable weight, Grand Total, submit findings), re-run authoritatively on submit — one codebase, mirroring Stage 3 §9.6.

---

## 10. Stage-4 scope vs reserved-for-later
| Concern | This build (Stage 4) | Reserved / later |
|---|---|---|
| Leg lifecycle | forward edges `RFQ_SENT → PARTIALLY → FULLY_QUOTED` + `reopen` | `→ AWARDED/DELIVERED` (Stage 5+/8–9) |
| Quote lifecycle | `SELECT → RFQ_SENT → QUOTED/EXPIRED/INVALID` | `REQUOTED/CLOSED/APPROVED` (Stage 5) |
| Change handling | **change-order cascade** realized (RfqDefining + Structural) | further-stage scopes (margin, award, PO) |
| Quote comparison / award / requote | out | **Stage 5** |
| Currency | stored as entered (FF's currency) | USD conversion at Stage 5 |
| Emails | FF-facing **compose-&-log** | **live send** |
| Logging | `StatusTransition` + `ChangeLog` | full audit trail |
| Deadline | 48h default + reminders + expiry | extension / post-expiry FF add |
| FF Master | lookup + eligibility (this build) | onboarding/maintenance workflow (Admin) |

---

## 11. Deployment — additions
- **New public surface (O-S4-1 — resolved):** the portal is **path-based on the same origin** — `/ff/rfq/:token` (SPA) + `/ff/rfq/:token/*` (API, token-guarded, §8.1). **No subdomain, served over HTTP for now** (no domain yet). One SPA build with a code-split `/ff/rfq/*` route tree + distinct shell (promotable to a separate bundle or a `rfq.<domain>` subdomain later with **zero API change** — the `/ff/*` guard boundary is stable). Rate-limit `/ff/*` in-app.
- **Go-live gate (carried from §8.1):** **TLS is mandatory before live email + real external FFs.** Whenever a domain/edge is introduced, front `/ff/*` with HTTPS; this lands together with the B2 live-send swap. Until then, no real token leaves the system (compose-&-log).
- **Migrations:** new tables + **drop** the four superseded null columns (O-S4-3, non-destructive); `prisma migrate deploy` before cutover (Stage 3 §11.6) is unchanged.
- **Scheduler:** single-replica assumption holds (reminders fire once); multi-replica later needs a leader-lock (Stage 3 §11.8).

---

## 12. Open items / assumptions
| # | Item | Assumption / next step |
|---|---|---|
| O-S4-1 | Portal subdomain | **Resolved:** path-based `/ff/rfq/:token` on the same origin, **HTTP for now** (no domain yet); token-guarded `/ff/*` boundary. TLS = go-live gate before live email/external FFs (§8.1, §11). |
| O-S4-2 | Currency list | **Resolved:** **static** reference list (constant / `config` seed) now; **admin-managed screen reserved for later.** FF `defaultCurrency` pre-fills; symbols resolved client-side. |
| O-S4-3 | Superseded Stage-3 columns | **Resolved: drop** in a Stage-4 migration (§4.3.1) — `CargoItem.freightDensity`/`chargeableWeight`, `Leg.totalChargeableWeight`, `LegCargo.manifestSnapshot`; all null in Stage-3 data (non-destructive). Per-FF handling on `QuoteCargoLine`/`Quote`. |
| O-S4-4 | Token TTL vs deadline | **Resolved:** no hard link-expiry — the link stays valid for the **RFQ's life** (read + PDF), **submission** gated by the deadline; revoked only on query closure (§8.1). |
| O-S4-5 | Deadline/reminder timezone | **Resolved (Option A):** deadline stored **UTC**; reminders/countdown are **UTC-offset math — timezone-agnostic firing**. Email cutoff renders in the **org zone + IANA label** (+ a duration); in-app renders **viewer-local + label** with the **countdown primary**. Reuses Stage-3 `timezone.ts` / `ZonedDateTimeField` / `TimezoneCombobox` + org-zone fallback (`useOrgTimezone`). |
| O-S4-6 | Amended-leg deadline squeeze | **Resolved:** no logic change (one deadline per RFQ, O1; no extension, D7). **Soft warning** when distributing an added leg to an already-sent FF whose deadline is **<12h out** (inside T-12h); the "RFQ Updated" email states the shared deadline explicitly. Largely avoided by Distribute-All (B7). |

---

## 13. Glossary — additions
- **RFQ** — one Freight Forwarder's request-for-quote for a query; identity = (query, FF); one number, one secure link, one or more leg sections (D3).
- **Quote** — one FF's priced bid on **one leg**; the atomic unit of Stage 4 (as the leg was Stage 3's). Carries the Forwarder status.
- **Forwarder status** — per FF, per leg (`Quote.status`): Select → RFQ Sent → Quoted/Expired/Invalid.
- **Chargeable weight** — `max(gross, volumetric)`, volumetric = CBM × freight density; the pricing basis. Per-quote (per-FF density).
- **Charge zone** — Origin / Main Freight / Destination itemisation for Air/Sea legs (D6).
- **Manifest freeze** — the leg's cargo captured onto a `Quote` at distribute so the FF never quotes stale cargo; re-frozen on change-order re-distribute.
- **Change-order** — the cascade that reopens a leg (RfqDefining/Structural edit post-RFQ): impact preview → reason → invalidate/refresh → `reopen` → re-distribute (spec §11).
- **RFQ access token** — the opaque, hashed, scoped credential behind the FF's no-login link (§8.1).

---

*End of Stage 4 Technical Design*
