# YankAlfa Logistics — Stage 3: Technical Design
## Architecture · Data Model · APIs · Extensibility Core · Frontend

> **Status:** Draft for review · **Date:** 16 July 2026
> **Companion to:** `Stage 3 - Create Query - Functional Spec.md` (behaviour, source of truth) and `Stage 3 - Session Handoff.md` (decision log).
> **This document is the source of truth for _how_ Stage 3 is built.** The functional spec is the source of truth for _what_ it does. Where this doc references a rule like §10.2 or a decision like D7, that citation points into the functional spec.

---

## 0. Orientation for a new session (read this first)

If you are a Claude session picking this up — especially to build **Stage 4 onwards** — read in this order:

1. **`Stage 3 - Create Query - Functional Spec.md`** — the behaviour, field tables, validation catalogue (§10), status model (§9), and change model (§11). This is the *what*.
2. **This document** — the *how*: architecture, entities, APIs, and the **Extensibility Core** (§7) you will extend.
3. Then: **§7 (Extensibility Core)** and **§10 (Stage-3 scope vs reserved-for-later)** are the two sections that matter most for adding a new stage.

**Golden rules for extending this system (Stages 4–9):**
- **Never bypass a module's service.** Domain modules expose a service; other modules call it, never its tables. The *leg is the spine of all 9 stages* — all leg mutations go through `LegsService`.
- **Never hand-write a status.** Status changes go through the **Status Machine** (§7.2). Add new transitions by *contributing* them to the registry; do not scatter `if (status === …)` checks.
- **Never mutate through a raw write for anything user-editable.** Route it through the **Change Mediator** (§7.3) so impact classification and the Free/Change-order fork happen in one place.
- **New stage = new module(s) + contributed transitions + declared impact classes.** No rewrite of the core.

---

## 1. Decisions locked

### 1.1 Functional (from the spec §2, decisions D1–D12) — do not re-litigate
Manual plug-n-play legs (D1) · first-class reusable **points** (D2) · **per-leg mode** (D3) · freight density + chargeable weight are **cargo-level, deferred to Stage 4** (D4) · atomic cargo rows (D5) · divergent routing allowed, hub date = MAX (D6) · cargo attached to a leg by **explicit selection** (D7) · legs saved **individually** with stable IDs (D8) · change handling is **query-wide + impact-aware** (D9) · tracking model now / UI later (D10) · **stepped wizard** UI (D11) · emails **composed & logged, not sent** (D12).

### 1.2 Technical (this build)
| # | Decision | Note |
|---|---|---|
| T1 | **Node + React**, all TypeScript | — |
| T2 | **Backend: NestJS** | Modular monolith; one module per domain |
| T3 | **DB: PostgreSQL + Prisma** | Relational fits the leg/point/cargo graph + FK integrity |
| T4 | **Frontend: Vite + React + shadcn/ui + Tailwind** | + TanStack Query/Table, React Hook Form + Zod, React Router |
| T5 | **Monorepo (pnpm workspaces)** with isomorphic `packages/shared` | Zod schemas + route-validation engine shared by both apps |
| T6 | **Real login + RBAC** — Executive / Manager / Administrator | JWT in httpOnly cookie + refresh token table (§8.1) |
| T7 | **Single-tenant, tenant-ready** | Nullable `tenantId` on every table + scoping helper |
| T8 | **Escalation scheduler built now** | `@nestjs/schedule` cron-poll; no Redis (§8.2) |
| T9 | **Email compose-&-log built now**; no live send | `EmailLog` rows (§8.7) |
| T10 | **Audit trail deferred**; `StatusTransition` log **included now**; change-log reserved for the Stage-4 cascade | See §7.7 |
| T11 | **Scope = Stage-3 manual-create only** + Client & Vessel Masters + All-Records list | No dependency on other stages |

---

## 2. Architecture

### 2.1 Modular monolith (chosen)
One NestJS app, one Postgres database, **one module per domain with enforced boundaries**. Rejected alternatives: microservices-per-stage (premature — the stages are tightly coupled around the leg; distributed transactions would hurt) and a plain layered monolith (no boundaries → ball of mud by Stage 5 as leg logic leaks across features).

**Why it is stage-ready:** each future stage (RFQ, quotes, awards, PO, tracking) arrives as a **new module** that depends on Stage-3 modules through their **service interfaces**, never their tables. Module boundaries are enforced by NestJS's provider visibility (a provider not exported from its module is invisible outside it) plus an ESLint import-boundary rule.

### 2.2 Module map (`apps/api/src/modules/`)
| Module | Owns | Public service (examples) |
|---|---|---|
| `auth` | login, JWT, guards | `AuthService` |
| `users` | users, roles (RBAC) | `UsersService` |
| `clients` | Client Master + contacts | `ClientsService` |
| `vessels` | Vessel Master | `VesselsService` |
| `queries` | Query aggregate root | `QueriesService` |
| `points` | reusable points (5 types) | `PointsService` |
| `legs` | legs + leg-cargo assignment | `LegsService` |
| `cargo` | cargo rows | `CargoService` |
| `routing` | server-side route validation | `RoutingService` |
| `status` | **Status Machine** (query + leg) | `StatusService`, `StatusRegistry` |
| `changes` | **Change Mediator** (impact + paths) | `ChangeMediator`, `ImpactRegistry` |
| `notifications` | in-app notifications | `NotificationsService` |
| `escalations` | tiered escalation timers | `EscalationsService` |
| `emails` | compose & log | `EmailsService` |
| `config` | reference data (density, checklist) | `ConfigService` |
| `files` | uploads (MSDS) | `FilesService` |
| *(future)* `rfq`, `quotes`, `awards`, `po`, `tracking` | Stages 4–9 | contribute to `status`/`changes` |

### 2.3 Repo layout (pnpm workspaces)
```
svyft-logistics/
├─ apps/
│  ├─ api/                      # NestJS + Prisma
│  │  └─ src/modules/…          # the module map above
│  │  └─ src/common/            # guards, interceptors, filters, tenant scope
│  └─ web/                      # Vite + React + shadcn/ui + Tailwind
│     └─ src/features/          # query-list, query-wizard, masters, auth, notifications
├─ packages/
│  └─ shared/                   # TS types · Zod schemas · route-validation engine (isomorphic)
└─ prisma/                      # schema.prisma + migrations
```

### 2.4 Stage-readiness principles (summary)
1. Domain modules with explicit public services (§2.2).
2. Status as a **state machine**, not scattered conditionals (§7.2).
3. Change handling behind a **pluggable mediator** (§7.3).
4. **Isomorphic validation** in `packages/shared` — one source of truth, client + server (§6).
5. **Tenant-ready** schema (§4.6).

---

## 3. Tech stack (consolidated)
- **Backend:** NestJS · TypeScript · PostgreSQL · Prisma · Passport (JWT) · `@nestjs/schedule` · `@nestjs/event-emitter` (in-process domain events) · `exceljs` (export).
- **Frontend:** Vite · React · TypeScript · shadcn/ui + Tailwind · TanStack Query (server state) · TanStack Table (Query List) · React Hook Form + Zod (forms) · React Router.
- **Shared:** `packages/shared` — Zod field schemas + route-validation engine + DTO types, imported by both apps.
- **Tooling:** pnpm workspaces · Docker Compose (Postgres) for local dev · Vitest/Jest for tests · ESLint import-boundary rule for module isolation.

---

## 4. Data model

### 4.1 Relationship map
```
User ──assigned──▶ QUERY ──clientId──▶ Client ──▶ ClientContact
                    │  └─vesselId──▶ Vessel
                    ├──▶ Point   (5 types, reusable within the query)
                    ├──▶ Cargo ──▶ Package ──▶ Item   (re-modelled — was flat CargoItem)
                    │              └─msdsFileId──▶ FileAsset   (per package, DG-triggered)
                    ├──▶ Leg ──origin/destPointId──▶ Point
                    │      └──▶ LegPackage ◀──packageId── Package   (D7/C13 join, was LegCargo)
                    ├──▶ QueryChecklistItem
                    └──▶ Escalation · EmailLog · Notification
StatusTransition ▶ (polymorphic: entity + id)      RefreshToken ▶ User
```

### 4.2 Entities by module
Every table also carries `id` (uuid PK), nullable `tenantId`, and `createdAt`/`updatedAt` unless noted. Only architecturally significant columns are listed; full field semantics live in the functional spec §7. `ᵁ` = unique, `ᶠᵏ` = foreign key. Cargo/Package/Item/LegPackage reflect the Cargo→Package→Item re-model — source of truth `docs/superpowers/specs/2026-08-05-stage3-cargo-packing-list-design.md` (decisions cited below as C1–C14).

**Identity & Access** — `auth`, `users`
| Entity | Key columns | Notes |
|---|---|---|
| **User** | name, email ᵁ, passwordHash, **role** (EXECUTIVE·MANAGER·ADMINISTRATOR), isActive | 3 fixed roles as enum + roles guard; no permission tables yet. |
| **RefreshToken** | userId ᶠᵏ, tokenHash, expiresAt, revokedAt? | Hashed; enables logout/revoke (§8.1). |

**Masters** — `clients`, `vessels`
| Entity | Key columns | Notes |
|---|---|---|
| **Client** | **clientCode** ᵁ ("Client ID"), companyName ᵁ, industry, country, **status** (ACTIVE·INACTIVE) | Inactive hidden from query lookup. Unique name = duplicate prevention (§7.1). No inline create (v2). |
| **ClientContact** | clientId ᶠᵏ, name, designation, contactNo, email, isPrimary | Query **snapshots** the chosen contact; editing on the query never writes back. Primary surfaced in the master list. |
| **Vessel** | **vesselCode** ᵁ ("Vessel ID"), name, imoNumber (7-digit) ᵁ, shippingLine, vesselType (enum), **status** (ACTIVE·INACTIVE) | IMO duplicate cross-check. Voyage fields (ETA/ETB/ETD/Port of Call) live on the Query, not here. |

**Query aggregate** — `queries`, `points`, `legs`, `cargo`
| Entity | Key columns | Notes |
|---|---|---|
| **Query** (root) | **queryCode** ᵁ `YALYY-NNNN`, queryDate, priority (default MEDIUM), responseDeadline(+remarks), clientId ᶠᵏ, **contact snapshot** (name/designation/email/phone/whatsappEnabled/fax), **vessel block** (vesselId ᶠᵏ?, vesselName, imoNumber, eta, etb, etd, portOfCall), incoterms (enum), shipmentDescription, **dgIndicator**, readyDate, targetDelivery, internalNotes, **status**, rfqReadyAt?, assignedUserId ᶠᵏ | `status` system-written only (§4.5, §7.2). Contact + vessel fields are **snapshots** so master edits never rewrite historical queries (§7.1). |
| **Point** (single-table inheritance) | queryId ᶠᵏ, **type** (PICKUP·DELIVERY·WAREHOUSE·AIRPORT·SEAPORT), name, streetAddress, city, postalCode, country, contactName, contactPhone, contactEmail, warehouseType?, iataCode?, icaoCode?, unLocode?, terminal? | One table + type discriminator; per-type required fields enforced in Zod, not DB nullability. Reusable within the query → connectivity by shared point (D2). |
| **Leg** | queryId ᶠᵏ, **legCode** (stable, never reused within a query), legName?, originPointId ᶠᵏ, destinationPointId ᶠᵏ, **mode** (ROAD·AIR·SEA), readyDate, targetDelivery, **status**, **executionStatus** (PENDING·IN_TRANSIT·COMPLETED), totalChargeableWeight? | Roll-ups (packages/CBM/gross/net) computed on read. `executionStatus` = tracking model (§12 of spec), UI in Stage 8–9. `totalChargeableWeight` null in Stage 3 (D4). |
| **Cargo** | queryId ᶠᵏ, rowIndex, poReference?, label?, **dimUnit** (CM·MM, default CM), **weightUnit** (KG·**TONNE**·GM, default KG) | The PO/reference **grouping** row (C1/C11) — owns the entry-unit selectors for its packages; carries no dims/weight/DG of its own. Derived-on-read header **H4–H8** (`packageCount`, Σ`grossWeightKg`, Σ`volumeCbm`, ⋃`tags`, `chargeableWeight`=null) — never stored (C7, §4.5). |
| **Package** (ex-`CargoItem`, C2) | queryId ᶠᵏ (denormalised, avoids touching queryId-scoped services) + cargoId ᶠᵏ, rowIndex, **packageNo** (ᵁ per query case-insensitive, V-5), **packageType** (BOX·PALLET·CRATE·CARTON·DRUM·BUNDLE), dimL, dimW, dimH, grossWt, netWt?, tags[] (HEAVY·FRAGILE·NON_STACKABLE·OUT_OF_GAUGE·**DG**), msdsFileId ᶠᵏ?, **volumeCbm** (generated), packageCount (parked) | **The freight unit** — same physical row `LegPackage`/`QuoteCargoLine` reference (still `CargoItem`'s old FK target, C2). Dims/weight **stored canonical cm/kg** (C6) — the entry unit lives on the parent Cargo, converts on write, converts back on read (BL-6). `volumeCbm` = Postgres generated column `dimL·dimW·dimH / 1e6` — always m³; no `×qty`, no unit CASE (dims are already canonical, unlike the old per-row unit-aware formula). `packageCount` default 1, reserved/not calculated/not shown (C5). Dropped from the old `CargoItem` shape: `poReference` (→ Cargo), `productName`/`qty`/`hsCode` (→ Item), `isDangerous` (→ the DG tag), `dimUnit`/`weightUnit` (→ Cargo), `freightDensity`/`chargeableWeight` (Stage-4's `QuoteCargoLine` already carries these per package, so the Stage-3 placeholder columns are dropped, not moved). |
| **Item** (new) | packageId ᶠᵏ, rowIndex, product?, qty?, **uom** (PC·SET·BOX·KG·M·ROLL; required only when `qty` present, V-4), hsCode?, tags[] | The commercial/customs line inside a package (HSN, product, qty) — a package may hold many items (many HS codes) or none. An item with neither `product` nor `qty` is discarded on save (V-4). No separate customs-form output; this popup entry **is** the customs form (C12). |
| **LegPackage** (was `LegCargo`) | legId ᶠᵏ, packageId ᶠᵏ | `unique(legId, packageId)`. Explicit tick (D7), **package grain** (C13). Plain many-to-many — **no snapshot column** carried forward; the old `LegCargo.manifestSnapshot` reservation isn't on this join. The Stage-4 RFQ freeze snapshot lives on `Quote.manifestSnapshot` (+ `chargeConfigSnapshot`) per FF instead, refreshed by the change-order cascade (§7.5). |
| **FileAsset** | queryId ᶠᵏ, kind (MSDS…), filename, mime, sizeBytes, storageKey, uploadedById | Behind a storage service: local disk in dev → object store later (§8.4). |
| **ChecklistDefinition** | itemKey, label, order, dgConditional | Admin-maintained reference data; seeded with the 9 items (spec §7.5). |
| **QueryChecklistItem** | queryId ᶠᵏ, itemKey, checked | Per-query checkbox state; drives follow-up enablement. |

**Notifications & Ops** — `notifications`, `escalations`, `emails`
| Entity | Key columns | Notes |
|---|---|---|
| **Notification** | recipientUserId ᶠᵏ, type, queryId ᶠᵏ?, message, readAt? | In-app feed, FE-polled (§8.3). |
| **Escalation** | queryId ᶠᵏ, **tier** (T30M·T2H·T6H), recipientRole, dueAt, firedAt?, cancelledAt? | Scheduler polls *due & unfired & not cancelled*; cancelled on RFQ Ready / closure (§8.2). |
| **EmailLog** | queryId ᶠᵏ, template (FOLLOW_UP·ACKNOWLEDGEMENT·ESCALATION), fromAddress, toAddress, subject, bodyRendered, tokens JSONB, composedById, status = LOGGED | Compose-&-log only, no send (D12, spec §15). |

**Reference / Config & sequences** — `config`
| Entity | Key columns | Notes |
|---|---|---|
| **FreightDensityFactor** | mode (ROAD·AIR·SEA), kgPerCbm | Admin-editable (O4); seeds Stage-4 density, **not applied in Stage 3**. |
| **QuerySequence** | year (PK), lastNumber | Row-locked increment mints `YALYY-NNNN`; resets yearly (§4.4). |

**Cross-cutting log** — `status`
| Entity | Key columns | Notes |
|---|---|---|
| **StatusTransition** (append-only) | entity, entityId, from, to, event, actorId, at | Written by `StatusService.fire`. Operational history; distinct from audit (§7.7). |

*(Incoterms = 12-value enum: EXW·FCA·FAS·FOB·CFR·CIF·CPT·CIP·DAP·DPU·DDP·**NA** — `NA` added in Round 3, displayed "N/A"; Country = static reference list.)*

### 4.3 Modeling decisions
1. **Point = single-table inheritance.** One `points` table + `type` discriminator + per-type Zod validation. Legs FK cleanly to any point and the routing engine reads a uniform node shape.
2. **Package↔leg is an explicit join** (`LegPackage`, was `LegCargo`) — plain `(legId, packageId)` many-to-many, package grain (C13); a package rides every leg it's ticked onto, a live reference in Stage 3. It carries **no snapshot column** — the Stage-4 RFQ freeze lives on `Quote.manifestSnapshot` per FF instead (not on the join), refreshed by the change-order cascade so FFs never quote stale cargo.
3. **Snapshots for client-contact + vessel fields on the Query** — master edits never rewrite historical queries (spec §7.1 "never changes the master").

### 4.4 ID generation (`YALYY-NNNN`)
Minted on **first persist** (first Save, or first leg save — whichever comes first, spec §5). A row-locked `QuerySequence` row for the current year is incremented inside the same transaction; formatted `YAL` + 2-digit year + `-` + 4-digit zero-padded number; resets when the year rolls over. Immutable thereafter. `clientCode`/`vesselCode` use a simpler prefix+sequence (`CL-0001`, `VS-0001`) — **open item O-T1**, confirm house convention.

### 4.5 Derived vs stored
- **Derived-on-read, never stored:** `Query.freightMode` (distinct leg modes), `Query.origin`/`destination` (from pickup/delivery points), leg roll-ups (packages/CBM/gross/net), and the **Cargo header H4–H8** (`packageCount`, Σ`grossWeightKg`, Σ`volumeCbm`, ⋃`tags`, `chargeableWeight`=null — C7). Zero drift.
- **Two deliberate exceptions:** `Package.volumeCbm` (ex-`CargoItem.volumeCbm`; a deterministic Postgres *generated column*) and `Query.dgIndicator` (a stored bool a service keeps in sync — auto-true when any **Package or Item** carries the DG tag, union derived on write, manual override allowed and never auto-cleared, spec §7.2).
- **Status is persisted but system-only** (§7.2).
- **Leg roll-ups simplify to a pure canonical Σ (Cargo→Package→Item re-model, C6, supersedes Round 3 below):** `totalPackages` = count of assigned packages, `totalGrossWt`/`totalNetWt` = Σ `Package.grossWt`/`netWt`, `totalCbm` = Σ `Package.volumeCbm` — every input is already canonical kg/m³, so no per-row unit normalization runs anymore.
- **Round 3 (superseded):** the old per-row model normalized `totalGrossWt`/`totalNetWt` to kg before summing (`weightUnit = GM` rows divided by 1000) and summed each row's own unit-aware `volumeCbm` directly. Net behaviour is unchanged — leg roll-ups were always effectively kg/m³ sums — the per-row conversion step is simply gone now that storage is canonical.

### 4.6 Tenant-readiness
Every table carries a nullable `tenantId`; all reads pass through a scoping helper/interceptor. Single-tenant today; multi-tenant is a config flip, not a migration.

---

## 5. API surface (REST, NestJS)

### 5.1 Conventions
`/api` prefix · JSON · Zod-validated DTOs (from `packages/shared`) via a Nest `ZodValidationPipe` · RBAC guard per route · offset/cursor pagination on lists · a consistent `422` error envelope carrying the same `Finding[]` shape the route engine emits (§6).

### 5.2 Endpoints by area
| Area | Endpoints | Notes |
|---|---|---|
| **Auth** | `POST /auth/login` · `/refresh` · `/logout` · `GET /auth/me` | httpOnly cookies (§8.1). |
| **Users** (Admin) | `GET/POST/PATCH /users` | Role management. |
| **Clients** | `GET /clients` (search/paginate) · `POST` · `GET/PATCH /clients/:id` · `GET/POST/PATCH /clients/:id/contacts` | CRUD Admin/Manager-governed. |
| **Vessels** | `GET /vessels` · `POST` · `GET/PATCH /vessels/:id` | |
| **Queries (list)** | `GET /queries` | All-Records: search, filters, sort, pagination; returns derived freightMode/origin/destination/status. |
| **Query (save)** | `POST /queries` (first Save → mints `queryCode`) · `GET /queries/:id` · `PATCH /queries/:id` | PATCH = per-step partial save; runs the Change Mediator (§7.3). |
| **Create Query** | `POST /queries/:id/create` | Full validation → `RFQ_READY`; returns `Finding[]` if blocked. |
| **Points** | `POST/PATCH/DELETE /queries/:id/points` | Reusable within query. |
| **Legs** | `POST /queries/:id/legs` (Save leg → mints `legCode`, partial allowed) · `PATCH/DELETE …/legs/:legId` | Package tick via `assignedPackageIds` in body → `LegPackage` (was `assignedCargoIds`/`LegCargo`, package grain, C13). |
| **Cargo** | `GET/POST /queries/:id/cargo` · `PATCH/DELETE …/cargo/:cid` · `POST …/cargo/export` (xlsx) | The PO/reference grouping (Cargo→Package→Item re-model). H4–H8 header derived on read; export = single worksheet `Packing List`, one row per Item (§8.6). |
| **Packages / Items** | `POST …/cargo/:cid/packages` · `PATCH/DELETE …/packages/:pid` · `POST …/packages/:pid/msds` (multipart) · `POST …/packages/:pid/copies` ("add N copies", 2–50, C4) · `POST …/packages/:pid/items` · `PATCH/DELETE …/items/:iid` | Package = the freight unit (dims/weight/tags, `volumeCbm` generated column). Item = commercial/customs line (product/qty/HSN). MSDS is per package, required when effectively DG (F6). |
| **Checklist** | `PATCH /queries/:id/checklist` | Drives follow-up enablement. |
| **Validate** | `POST /queries/:id/validate?phase=draft\|create` | Runs the shared engine server-side; returns findings. |
| **Emails** | `POST /queries/:id/emails/follow-up` · `/acknowledgement` · `GET …/emails` | Compose & **log** (no send). |
| **Notifications** | `GET /notifications` · `/unread-count` · `PATCH /notifications/:id/read` | FE-polled. |
| **Config** (Admin) | `GET/PATCH /config/density-factors` · `/checklist-definition` | Reference data (O4). |

### 5.3 Error / validation envelope
`422` responses carry `{ findings: Finding[] }` where `Finding = { rule, severity: 'blocking'|'warning', scope: { type, id }, message }` — the identical structure produced by the route engine (§6), so the client renders server and client findings through one code path.

---

## 6. Route-validation engine

### 6.1 Location & signature
A **pure, isomorphic function** in `packages/shared`: `validateRoute(graph, phase) → Finding[]`. No Nest or DB dependencies; unit-testable in isolation.

### 6.2 Catalogue coverage
Implements the entire functional-spec §10 catalogue: field (F1–F6, via Zod), connectivity/continuity R1–R5, mass-balance R6, mode↔endpoint V-M1, downstream-readiness R7–R9, temporal T1–T3, completeness C1–C3, edit-integrity E1.

### 6.3 Algorithm
The route is a **graph** — points are nodes, legs are directed edges, `LegPackage` labels which package rides which edge (was `LegCargo`; **one routable unit per Package**, not per Cargo grouping — Cargo→Package→Item re-model, C13). **Per package**, build its leg subgraph and verify: it is a simple path Pickup→Delivery (R1/R2/R4), enters==leaves at every intermediate hub (R6), and is time-ordered with hub MAX-date convergence (T1/T3, spec §8.5). Then cross-cutting: orphans (R3), mode↔endpoint compatibility (V-M1), country presence on both endpoints (R7). Parallel legs of *different* packages meet at shared points — continuity is checked per package, not as one global sequence (spec §10.2).

### 6.4 Client + server usage
- `phase='draft'` downgrades structural rules to **warnings**; `phase='create'` makes them **blocking** (spec §10 preamble).
- Runs **client-side** for live route-diagram highlights + inline errors, and **authoritatively server-side** at leg-save / validate / create. One codebase, zero drift — the payoff of the isomorphic `packages/shared`.

---

## 7. Extensibility Core — Status Machine + Change-Impact Hook  *(the section future stages extend)*

> **The mental model:** **Change-Impact = the _decision_** (what changed, why, how far it reaches). **Status Machine = the _movement_** (is this state change legal, what side-effects fire). They are separate subsystems connected at exactly **one seam**: a change-order *drives* reverse ("reopen") transitions. Neither reaches into the other's internals.

### 7.1 Why two subsystems
Separating decision from movement is what keeps the blast radius minimal and the code extensible: new flows declare *what a change means* and *what states exist* independently, and the plumbing between them never changes.

### 7.2 Status Machine
The spec (§9) has **two kinds of status**, and the framework models both:

| Kind | Example | Behaviour |
|---|---|---|
| **Owned / transitioned** | Leg status | Own column; moves only via explicit, guarded transitions. |
| **Derived / rollup** | Query status | Never stored as truth; **projected** from children (leg statuses) + query-level milestones (spec §9.1). |

**Owned status — declarative transitions** (in `packages/shared`, pure):
```ts
type Guard<C>  = (ctx: C) => true | Finding[];          // Finding[] explains WHY blocked
type Effect<C> = (ctx: C) => Promise<void>;

interface Transition<S extends string, E extends string, C> {
  from: S | S[];
  on:   E;                       // trigger, e.g. 'validate.pass', 'reopen'
  to:   S;
  guard?: Guard<C>;              // e.g. route valid for this leg
  effect?: Effect<C>;            // emit events, invalidate caches…
  kind?: 'forward' | 'reopen';   // reopen = change-order-driven reverse edge (spec §9.2)
}
interface Machine<S extends string, E extends string, C> {
  key: 'leg' | 'query' | 'rfq' | 'quote' | 'award' | string;
  initial: S;
  transitions: Transition<S, E, C>[];
}
```

**Leg machine — Stage-3 slice** (full state *vocabulary* declared in the enum; only these edges active):
```
        validate.pass ✓guard(route valid)
 DRAFT ─────────────────────────────────▶ READY_FOR_RFQ
   ▲                                            │
   └──────────── reopen (change-order) ─────────┘        ← edge exists, unreachable in Stage 3
   ┆ …RFQ_SENT · PARTIALLY_QUOTED · FULLY_QUOTED · AWARDED · IN_TRANSIT · DELIVERED · CLOSED
   ┆ (states reserved now; forward edges contributed by Stage 4+)
```

**The only door to a status change:**
```ts
statusService.fire(key, entityId, event, ctx)
// 1 load current state   2 match (from, on)   3 guard → block with Finding[] if false
// 4 persist new state (same DB tx as the trigger)   5 write StatusTransition row
// 6 emit `${key}.status.changed`   7 run effect
// no match → IllegalTransitionError    (one enforcement point)
```

**Derived status — a projection + subscriber** (query status is *not* a machine):
```ts
deriveQueryStatus(legStatuses, milestones): QueryStatus   // least-advanced gate + client milestones (spec §9.1)

@OnEvent('leg.status.changed')                            // in-process (Nest EventEmitter)
recomputeQueryStatus(e) { /* query.status = deriveQueryStatus(...) */ }
```

**Extensibility — how Stage 4+ contributes without touching Stage 3:**
```ts
StatusRegistry.contribute('leg', stage4LegTransitions);   // adds READY_FOR_RFQ → RFQ_SENT → …
```
- The **state vocabulary** (enum) is shared/reserved centrally now — one source of truth for "what states a leg can be in."
- **Transition edges** are owned by the contributing stage: Stage 4 adds forward edges; the `changes` module contributes the `reopen` reverse edges.
- Illegal transitions and guards stay centrally enforced.

### 7.3 Change-Impact Hook
Every mutation flows through **one mediator**, transport-agnostic (called by use-cases, not an HTTP interceptor — classification needs domain context):
```
ChangeRequest{ entity, id, patch, actor, reason? }
        │
   ┌────▼──────┐  (entity,field) → ImpactClass + touched scope   (declared per module)
   │ Classifier│
   └────┬──────┘
   ┌────▼──────────┐  "does anything downstream depend on this scope?"
   │ Scope Resolver│   Stage 3: ALWAYS false (no RFQs/quotes exist)
   └────┬──────────┘   Stage 4+: "which RFQs/quotes reference these legs?"
        ▼
   class ≤ RfqDefining  AND  no downstream work  ──▶  FREE PATH
   RfqDefining+         AND  downstream exists    ──▶  CHANGE-ORDER PATH
```
```ts
enum ImpactClass { Internal, Corrective, RfqDefining, PricingAwardDefining, Structural }  // spec §11.1

// declared next to each entity — legs module owns leg field classes:
ImpactRegistry.declare('leg', {
  origin: RfqDefining, destination: RfqDefining, mode: RfqDefining,
  readyDate: RfqDefining, targetDelivery: RfqDefining,
  legName: Corrective,
  '@create': Structural, '@delete': Structural,      // add/remove a leg
});

changeMediator.apply(req) {
  const d = classifier.classify(req);                       // class + minimal scope (spec §11.3)
  d.path = (d.class <= RfqDefining && !scopeResolver.downstreamWork(d.scope))
             ? 'free' : 'change-order';
  return strategies[d.path].run(req, d);
}
```

**Two paths are swappable strategies:**
| Strategy | Built in | Behaviour |
|---|---|---|
| **FreePath** | **Stage 3** | apply in a tx → re-run route validation → `changeLog.record()` (**no-op sink** now) |
| **ChangeOrder** | Stage 4+ | impact preview → confirm + reason → cascade to *minimal* scope → **drive `reopen` transitions** → invalidate quotes → record |

Stage 3 ships the ChangeOrder strategy as a **stub that can never fire** (resolver always returns "no downstream work"), so the wiring is proven end-to-end now and the real cascade drops in later without re-plumbing.

### 7.4 The seam
```
edit Leg 4 cargo ─▶ changeMediator.apply()   (class=RfqDefining, downstream=[RFQ-4])
                      ▼  → CHANGE-ORDER → cascade: invalidate RFQ-4
                      └─▶ statusService.fire('leg', leg4, 'reopen')     ← THE SEAM
                                │ guard ok → RFQ_SENT ➜ READY_FOR_RFQ
                                └─▶ emits 'leg.status.changed' ➜ query rollup recomputes
```
Change module says *"reopen leg 4 and why."* Status machine says *"that's a legal reverse edge, here's the side-effect."* Minimal blast radius (spec §11.3) falls out: the change names only Leg 4's scope, so only Leg 4 reopens.

### 7.5 Worked example — the same edit, Pre-RFQ vs Post-RFQ
**Scene — Query `YAL26-0042`:**
```
Cargo C1 "10 × pallet, machine parts" ─▶ Package P1, grossWt 5,000 kg
   L1 Road  Pickup(Mumbai) ─▶ Seaport(Nhava Sheva)     ┐
   L2 Sea   Seaport(Nhava Sheva) ─▶ Seaport(Rotterdam) ├─ P1 rides all three
   L3 Road  Seaport(Rotterdam) ─▶ Delivery(Hamburg)    ┘
```
**Edit (identical in both worlds):** `PATCH /queries/YAL26-0042/cargo/C1/packages/P1 { grossWt: 6200 }` — weight lives on the **Package**, not the Cargo grouping (Cargo→Package→Item re-model).
Both enter the same door; the classifier returns `class=RfqDefining, scope=legs carrying P1={L1,L2,L3}` (via `legsCarryingPackage`). The **only** fork is `scopeResolver.downstreamWork(scope)`.

**PRE-RFQ** — legs `READY_FOR_RFQ`, no RFQ distributed → `downstreamWork=false` → **FREE PATH**:
```
1 apply      P1.grossWt = 6200   (canonical kg)
2 recompute  L1/L2/L3 roll-ups (derived-on-read, cache-bust) + Cargo C1's H4-H8 header
3 revalidate validateRoute(phase='draft') → warnings only ✓
4 log        changeLog.record(...) → NO-OP
5 status     untouched — legs stay READY_FOR_RFQ
→ 200 OK, instant, no dialog, no reopen.
```

**POST-RFQ** — Stage 4 live, `L1=FULLY_QUOTED, L2=PARTIALLY_QUOTED, L3=RFQ_SENT` → `downstreamWork=true` → **CHANGE-ORDER**:
```
STEP 1 PREVIEW (nothing applied): "P1 5,000→6,200 kg invalidates L1(3 quotes),
       L2(1 quote), L3(RFQ open). FFs re-quote. Reason required."
   → Exec confirms + reason "client revised packing list"
STEP 2 COMMIT (one saga):
   a apply    P1.grossWt=6200; affected legs' pending Quote rows (manifestSnapshot)
              marked for re-freeze — the freeze snapshot lives on Quote now, not on
              the leg↔package join (LegPackage carries no snapshot column, §4.3)
   b cascade  for L1,L2,L3: void quotes; statusService.fire('leg', Lx, 'reopen')  ← seam
   c status   FULLY/PARTIALLY_QUOTED / RFQ_SENT ─▶ READY_FOR_RFQ
              · writes StatusTransition rows · emits leg.status.changed ×3
              · query rollup recomputes (Quoted → RFQ Ready)
   d log      changeLog.record({what:P1 grossWt 5000→6200, why, affected:[L1,L2,L3]}) → REAL
   e re-distribute RFQ, notify affected FFs
```

**The decision is 2-D (class × downstream), not a pre/post flag:**
- **Minimal blast radius:** if only L2 had an RFQ out, the resolver returns `{L2}` → only L2 reopens; L1/L3 take the edit free in the same operation.
- **Class still gates:** a `legName` typo fix (class=`Corrective`) stays on the **Free path even post-RFQ** — FFs never quoted against the label.

### 7.6 How future flows plug in
| Future flow | New field/action | Impact class | Plug-in work — **no core rewrite** |
|---|---|---|---|
| S4 FF submits quote | `quote.submit` | *(own machine)* | Register Quote/RFQ transitions; leg `Partially/FullyQuoted` derive |
| S4 edit package post-RFQ | `package.*` | RfqDefining | ScopeResolver: "RFQs referencing leg" (via `legsCarryingPackage`); `reopen` edge |
| S5 change margin | `margin` | PricingAwardDefining | Reopen client-quotation scope |
| S5 award FF | `award` | *(own machine)* | Leg `→ AWARDED` transition |
| S8 PO change | `po.*` | Structural | Recompute awarded legs |
Every new flow = **declare an impact class** (+ optional scope-resolver contribution) **+ register transitions**. The mediator, classifier pipeline, and status service never change.

### 7.7 Logging tiers — StatusTransition vs Change-log vs Audit
| | **StatusTransition** *(now)* | **Change-log** *(Stage 4, w/ cascade)* | **Audit trail** *(deferred)* |
|---|---|---|---|
| **Answers** | "How did this leg reach its state?" | "Why was this leg/RFQ reopened, by whom?" | "Who ever touched *any* field?" |
| **Records** | status `from→to` + event | change-order: fields, reason, affected scope | every create/update/delete, full field diffs |
| **Scope** | status changes only | change-order events only | all fields · all entities · all actors · logins · exports |
| **Written by** | `StatusService.fire` (auto) | change-order strategy | a global audit interceptor |
| **Volume** | low | low–moderate | **high** |
| **Cascade depends on it?** | **Yes** (reads prior state) | **Yes** (the record *is* the change-order) | No |
| **Nature** | operational data | operational data | compliance subsystem |

**Core distinction:** `StatusTransition` is **operational, narrow, system-authored** — the cascade *reads prior state from it* to reopen correctly, and rollup/debugging lean on it; cheap enough to keep on forever. The **audit trail is compliance-grade and broad** — every field by every actor, dragging in retention policy, tamper-evidence, access controls, and PII handling, which is exactly *why it's deferred* (it's a subsystem, not a table). They are **not substitutes**: you keep `StatusTransition` even after audit lands, because the cascade needs it and a narrow status history is far cheaper to query. The **change-log** is the middle tier — it exists because the cascade needs a durable "what/why" per change-order.

**This build:** `StatusTransition` **in**, change-log seam reserved (no-op sink), full audit **deferred**.

---

## 8. Cross-cutting concerns

### 8.1 Auth & RBAC
JWT **access token** in an httpOnly, `SameSite=strict` cookie (~15 min) + **refresh token** in an httpOnly cookie, stored *hashed* in `RefreshToken` for revocation/logout. `@Roles()` decorator + `RolesGuard` reads role claims; a tenant-scoping interceptor injects `tenantId`. Isolated in the `auth` module, so swapping to a server-side session store later is contained.

### 8.2 Escalation scheduler
`@nestjs/schedule` cron polling **every minute** (single-tenant, low volume — **no Redis/BullMQ**). On first persist → create 3 `Escalation` rows (`dueAt` = +30m/+2h/+6h; recipientRole Exec/Manager/Admin, spec §14). Cron picks up *due & unfired & not cancelled* → writes `Notification` rows + composes/logs escalation emails → sets `firedAt`. Reaching `RFQ_READY` or closure cancels remaining escalations. Escalation is **informational only** — no reassignment, no auto-close (spec §14). **BullMQ+Redis is the documented scale-up path**, not built now.

### 8.3 Notifications (in-app)
FE polls `/notifications/unread-count` every ~30–60 s and `/notifications` on open. SSE/WebSocket deferred — polling suffices for informational escalations.

### 8.4 File storage
`FileAsset` behind a storage service — local disk in dev → S3-compatible object store later. MSDS is PDF-only, per effectively-DG **package** (spec §7.3, F6; was "per DG cargo row" pre-re-model).

### 8.5 Concurrency
Per spec §13: **last-write-wins, no record locking.** `updatedAt` is returned for display only.

### 8.6 Excel export
Server-side `exceljs` stream, single worksheet named **`Packing List`** (was `Product`, spec §7.3) — **one row per Item**, package/cargo context repeated per row, trailing totals row. Excel **import** is out of scope.

### 8.7 Email compose & log
`EmailsService` renders the templates (spec §15) with dynamic tokens and writes an `EmailLog` row with `status=LOGGED`. **No live transmission** (D12). Follow-up compiles the unchecked checklist items into `{Missing_Fields_List}`.

---

## 9. Frontend architecture & screens

### 9.1 Stack & libraries
Vite + React + TypeScript · shadcn/ui + Tailwind · TanStack Query (server state/caching) · TanStack Table (Query List) · React Hook Form + Zod (per-step forms, schemas from `packages/shared`) · React Router. The route-validation engine from `packages/shared` runs in the browser for live feedback.

### 9.2 Routes / screens (from functional spec §5–§7)
| Route | Screen | Roles |
|---|---|---|
| `/login` | Login | all |
| `/queries` | **Query List (All Records)** — TanStack Table: search, filters, sort, columns, `+ Create Query` (spec §6) | all |
| `/queries/new` | Create Query Wizard (blank) | Exec+ |
| `/queries/:id` | Create Query Wizard (loaded; step via param) | Exec+ |
| `/masters/clients`, `/masters/clients/:id` | Client Master list + editor (+ contacts) | Admin/Manager |
| `/masters/vessels`, `/masters/vessels/:id` | Vessel Master list + editor | Admin/Manager |
| `/admin/config` | Density factors + checklist definition | Admin |
| *(dropdown)* | Notifications feed (bell + unread badge) | all |

### 9.3 Feature-folder structure (`apps/web/src/features/`)
`query-list/` · `query-wizard/` (with `steps/` and `legs/` = leg builder + route diagram + point editor) · `masters/` · `auth/` · `notifications/` · `admin-config/`. Shared UI primitives in `components/ui/` (shadcn); API hooks in `lib/` (TanStack Query).

### 9.4 Wizard shell, steps & save model
- **`WizardShell`** = persistent header (Query ID, status badge, editable Priority) + stepper + per-step body + action bar (`Cancel · Back · Save · Next`; final step adds `Create Query`, `Send Follow-up`, `Send Acknowledgement`) + a **route-validation findings panel**.
- **Steps (order O2, cargo before legs):** 1 Client & Query Details · 2 Shipment Details · 3 Cargo Details (dynamic table + Export to Excel) · 4 Legs / Route Builder · 5 Internal Notes & Checklist.
- **Save model (spec §5, §13):** Save persists a Draft (no completeness gate); **first Save (or first leg save) creates the record + mints Query ID** and lists it. Next/Back retain state; once the record exists, the stepper allows jumping to any step. Create Query runs full validation (§10) and, on success, sets `RFQ_READY`.

### 9.5 Key component decomposition (Step 4 — the hard one)
`LegEditor` (origin/destination pickers, mode, assigned-cargo multi-select, dates) · `PointEditor` (type-aware form: 5 point types) · `RouteDiagram` (derived from legs; updates on every add/edit/remove; doubles as the tracking view later, spec §7.4.3/§12) · `CargoAssignmentControl` (the D7 tick list). Legs are saved individually (`Save leg`), partial allowed; validation shows warnings in draft, blocks at Create Query.

> **Stage-4 reuse (PR #38 / post-testing fixes R1):** `RouteDiagram` is now also rendered read-only in the Stage-4 RFQ workspace (`RfqWorkspace`) as a persistent "Route overview" section beneath the query header, shown on every query regardless of distribution status. Edit callbacks (`onEditPoint`/`onEditLeg`) are omitted → component is non-interactive; hover tooltips are retained. No change to `RouteDiagram` itself or the route data model.

### 9.6 Shared validation on the client
Field schemas (Zod) and `validateRoute` come from `packages/shared`. The wizard runs them against in-memory state for **live** inline errors + route-diagram highlights; the server re-runs them authoritatively on save/create. Findings render through one component regardless of origin.

---

## 10. Stage-3 scope vs reserved-for-later  *(explicit, for a future session)*

| Concern | This build (Stage 3) | Reserved / later |
|---|---|---|
| Query lifecycle | `DRAFT → CREATED → RFQ_READY` | RFQ Sent → Quoted → … → Closed (rollup logic registers in `status`) |
| Leg lifecycle | `DRAFT ↔ READY_FOR_RFQ` | Forward edges to Awarded/Delivered (Stage 4+ contribute) |
| Change handling | **Free path** + impact classification + `reopen` seam wired | Change-order **cascade** strategy (Stage 4+) |
| Cargo manifest | live reference via `LegPackage` (package grain, was `LegCargo`) | **freeze** into `Quote.manifestSnapshot` per FF at RFQ (Stage 4) |
| Density / chargeable weight | null / read-only (D4) | FF sets per-row density; leg `totalChargeableWeight` sums (Stage 4) |
| Tracking | `Leg.executionStatus` field + derived-position model | tracking **updates + screen** (Stage 8–9) |
| Logging | `StatusTransition` | change-log (Stage 4), full audit (later) |
| Emails | compose & **log** | live send |
| Tenancy | single-tenant, `tenantId` present | multi-tenant activation |
| Notifications | in-app polling + email log | SSE/WebSocket; live email |

---

## 11. Deployment & Environments

### 11.1 Targets
- **Code:** GitHub (monorepo) → image registry **GHCR**.
- **Runtime:** DigitalOcean droplet, **shared with other Dockerized apps**.
- **Database:** **Neon** (managed Postgres) — a **separate Neon project** for logistics.

### 11.2 Topology
```
GitHub (monorepo)
   │  PR → CI (lint · typecheck · test · build)
   │  merge to main → build Docker image (tag = git SHA) → push GHCR
   ▼
DigitalOcean Droplet  (shared with other Dockerized apps)
 ┌───────────────────────────────────────────────────────┐
 │ Caddy container (OUR edge)  :80/:443  automatic HTTPS   │
 │   logistics.<domain> ─▶ api:4000                        │
 │   (neighbor apps reach their own host ports — untouched)│
 │  OUR docker compose project (isolated)                  │
 │   ┌─────────────────────────────────────────────────┐  │
 │   │ api (NestJS)  :4000 · mem/cpu limits · restart   │  │
 │   │   serves /api  +  built React SPA (static)       │  │
 │   │   volume → /uploads (MSDS)                        │  │
 │   └─────────────────────────────────────────────────┘  │
 └───────────────────────────────────────────────────────┘
        │  pooled connection · SSL
        ▼
 Neon — its OWN project/database (isolated compute, pool, creds)
        DATABASE_URL (pooled, pgbouncer)   ·   DIRECT_URL (migrations)
```

### 11.3 Coexistence — isolation boundaries (no impact on neighbors)
| Shared resource | Isolation measure |
|---|---|
| **Ports** | Own port `:4000`, localhost-bound; existing ports audited first (§11.9). |
| **Runtime / deps** | Own Docker container (own Node + libs); neighbor runtimes untouched. |
| **Edge / proxy** | Own Caddy container; only our subdomain config added — no neighbor config edited (§11.4). |
| **CPU / RAM** | `mem_limit` + `cpus` caps — a leak can't starve neighbors. |
| **Disk (logs)** | json-file log rotation (`max-size`/`max-file`). |
| **Disk (uploads)** | Dedicated named volume. |
| **Database** | Separate **Neon project** → own compute, pool, credentials. |
| **Deploy blast radius** | `docker compose up -d` recreates **our** container only. |
| **Build load** | Image built **in CI, never on the droplet** → no OOM risk to neighbors. |

### 11.4 Edge / reverse proxy — containerized Caddy, pre-flight gated
Neighbors are Dockerized with **no known shared proxy**. Plan: a **Caddy container** (automatic HTTPS) as the edge for `logistics.<domain>`, proxying to `api`.
**Mandatory pre-flight before first deploy:** audit `:80`, `:443`, and published ports.
- **`:80/:443` free** → Caddy binds them, routes **only our subdomain**; neighbors (direct host ports) untouched.
- **Occupied** → an edge already exists; add our route to it instead (or coordinate). **Traefik** (Docker-label auto-discovery) is the alternative if one edge should later front all apps.

### 11.5 Database (Neon + Prisma)
- **Separate Neon project** for logistics → isolated from neighbor data + connections.
- `DATABASE_URL` = **pooled** endpoint (`-pooler`, `sslmode=require`) for runtime; `DIRECT_URL` = **direct** endpoint for `prisma migrate deploy`. Wired via `datasource { url; directUrl }`.
- Conservative Prisma `connection_limit` (serverless Postgres).
- **Region-match** the Neon project to the droplet's DO region (per-request latency).
- **Neon branching** gives a cheap staging DB later (§11.7).

### 11.6 CI/CD — auto on merge to main
1. **PR:** CI runs lint · typecheck · tests · build (never touches the droplet).
2. **Merge to main:** build + tag image (git SHA) → push **GHCR**.
3. **Deploy (auto):** SSH → `prisma migrate deploy` (DIRECT_URL) **before** cutover → `docker compose pull && up -d` → container **HEALTHCHECK** gates readiness.
4. **Rollback:** redeploy previous image tag (seconds, our container only).
5. **Secrets:** GitHub Actions secrets (CI) + root-owned droplet `.env` (runtime); never committed.

### 11.7 Environments
**Production only** now (Neon main project). **Staging reserved:** a Neon **branch** DB + a second compose stack on its own subdomain/port — cheap to add later, no second server.

### 11.8 App-specific notes
- **Escalation cron (§8.2):** single container replica → timers fire once (correct). Multi-replica later needs a leader-lock or BullMQ.
- **MSDS uploads (§8.4):** named volume now; **DO Spaces** (S3-compatible) is the durable path — a `FilesService` config swap.
- **Ops hygiene:** `restart: unless-stopped`; DO firewall allows `:80/:443` (public) **plus `:22`/SSH** (the CD pipeline SSHes in each deploy); app port stays internal.

### 11.9 Pre-flight / operational checklist
- [ ] Audit `:80` / `:443` / published ports (decides §11.4 branch).
- [ ] Confirm droplet RAM headroom (size up if tight — but we build in CI, so no build-time pressure).
- [ ] DNS: `logistics.<domain>` A-record → droplet IP.
- [ ] Neon project created, region matched, URLs in secrets.
- [ ] DO firewall: 80/443 public **plus 22/SSH** (key-only) — the CD pipeline SSHes in on every deploy; don't restrict to only 80/443.

---

## 12. Open items / assumptions
| # | Item | Assumption |
|---|---|---|
| O1 | Priority default | **Medium** (from spec §16). |
| O2 | Wizard step order | Client → Shipment → **Cargo → Legs** → Notes (cargo before legs). |
| O4 | Freight density factors | Admin-configurable reference data. |
| O-T1 | `clientCode`/`vesselCode` format | Proposed `CL-0001` / `VS-0001` — confirm house convention. |
| O-T2 | Auth token TTLs | Access ~15 min / refresh ~7 days — confirm. |
| O-T3 | Deployment target | **Resolved:** DigitalOcean droplet (Docker) + Neon (Postgres) + GitHub/GHCR; auto-deploy on merge to main. See §11. |
| O-T4 | App subdomain | Proposed `logistics.<domain>` — confirm exact host + DNS. |
| O-T5 | Droplet `:80/:443` / edge | Pre-flight audit pending (§11.9); plan = containerized Caddy if free, else attach to existing edge. |
| O-T6 | Neon region + droplet region | Match them for latency — confirm regions. |

---

## 13. Glossary
- **Point** — a first-class, reusable location (5 types) referenced as a leg endpoint; connectivity is by shared-point reference (D2).
- **Leg** — one biddable transport segment; the atomic unit every later stage operates on; the spine of all 9 stages.
- **Free path / Change-order path** — the two routes a change can take (spec §11); Stage 3 uses only the Free path.
- **Owned vs derived status** — leg status is transitioned; query status is projected from legs + milestones (§7.2).
- **The seam** — a change-order drives `reopen` transitions on the status machine; the single connection point between the two core subsystems (§7.4).
- **Isomorphic** — the same validation code runs unchanged on client and server (§6).

---

*End of technical design.*
