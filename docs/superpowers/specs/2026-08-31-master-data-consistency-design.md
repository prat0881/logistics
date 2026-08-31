# Master Data Consistency — Design

**Date:** 2026-08-31
**Branch:** `claude/master-data-consistency-a920af`
**Predecessors:** `2026-08-25-master-data-expansion-design.md` (shipped, PR #53),
`2026-08-26-post-deploy-corrections.md` (outstanding), `docs/Masters - Session Handoff.md`
**Successor:** the Stage-4 pass (§9 of the expansion design) — see §8 for the interaction.

## 1. Why this exists

Six master screens — Client, Freight Forwarder, Vessel, Warehouse, FX Rates, Charge Catalogue —
were built across three separate efforts and do not behave like one product. The user's brief:

1. One Save button per screen, not save-then-add-contact-then-add-warehouse.
2. New FX rate should open like Client and Vessel do.
3. Every master's fields arranged sectionally, like the FF master.
4. Add Contact opens a dialog; contacts list as a proper table on the main screen.
5. At least one Primary contact is mandatory.
6. Contacts editable and deletable from the row.

This is a consistency and correctness pass over screens that already work. It adds **no new
database columns and no migration** (§7.1), which matters: `prisma migrate dev` in this repo
would propose dropping the three partial unique indexes the one-primary rule depends on.

## 2. Current state, measured

| | Client | Freight Forwarder | Vessel | Warehouse | FX Rates | Charge Catalogue |
|---|---|---|---|---|---|---|
| Create UX | `/new` route | `/new` route | `/new` route | `/new` route | **inline form on list** | `/new` route |
| Field layout | flat, 1 col, `max-w-md` | **sectioned, 2-col, `max-w-2xl`** | flat, 1 col | sectioned, 2-col | flat | flat |
| Save buttons on screen | **3** | **3** | 1 | **3** | 1 | 1 |
| Contacts | ✓ | ✓ | — | ✓ | — | — |
| Warehouse assignment | ✓ | ✓ | — | — | — | — |
| Vehicles | — | — | — | ✓ (add-only) | — | — |
| Status field in form | ✗ (schema has it) | ✓ | ✗ (schema has it) | ✓ | — | via list |
| Edit existing | ✓ | ✓ | ✓ | ✓ | **✗ create-only** | ✓ |

Beyond the six points in the brief, the audit found:

- **`designation` and `status` on contacts are unreachable.** Both are on `contactCoreSchema`,
  and the query wizard *reads* `contact.designation` (`Step1Client.tsx:221`) — but no master
  screen captures either, so every contact in the system has `designation = null`.
- **Warehouse vehicles are add-only.** `DELETE /:id/vehicles/:vehicleId` exists; the UI never
  exposed it.
- **Charge Catalogue's Input type dropdown can create an invisible charge line** — see §6.
- All six use raw `<select>`/`<table>` with the class string copy-pasted into four files, while
  `components/ui/select.tsx` and `table.tsx` sit unused.
- No toast system: every failure is a `role="alert"` paragraph, and each child section owns its
  own error slot.

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| C1 | **Children save atomically with the parent** — one request, one transaction | A single Save button is not a UI rearrangement. Contacts, warehouse assignment and vehicles are blocked on a saved parent today (`ContactList.tsx:49`, `WarehousePicker.tsx:76`), which *forces* the save→reload→add flow. Atomicity is also what makes the primary-contact rule server-enforceable. |
| C2 | **FX rates get a `/new` page; rates stay append-only** | Matches every other master. No PATCH/DELETE: rates are history keyed on `effectiveFrom`, and editing one retroactively changes what past quotes converted at. Supersede by adding a later effective date. |
| C3 | **Every Client, FF and Warehouse has exactly one PRIMARY contact after create** | User's rule, applied uniformly. The *payload* differs: Client and Warehouse must carry it in `contacts`; FF may instead supply it through `pic`/`contactNumber`/`email` (C5), which `create()` already converts into a PRIMARY row. The invariant is the same; only the input path differs. |
| C4 | **Never required on update; records without one get a warning banner, not a block** | User's call. A hard block would make every pre-existing row un-editable until someone fixed it — the fix being blocked behind the very screen that's blocking. |
| C5 | **FF keeps `pic`/`contactNumber`/`email` on the form; they mirror the primary contact row** | User's call. As those fields are filled, the contacts table shows a live PRIMARY row reflecting them; on edit they stay disabled and mirror whichever contact is primary. No double entry, no schema change, and it makes Stage-4 item 1 a deletion rather than a redesign. |
| C6 | **Charge Catalogue: Input type restricted, Sort order becomes reordering** | See §6. Both columns leave the list table. |
| C7 | **`syncPrimaryContactColumns` remains the sole writer of FF's derived columns** | The handoff names "two writers, no reconciliation" as a defect that recurred *twice* on this exact code. The composite transaction writes contacts, then calls the existing sync — it never sets those columns from form values. |
| C8 | **The standalone child endpoints stay** | `/:id/contacts`, `/:id/warehouses`, `/:id/vehicles` keep their routes, RBAC and specs. The UI stops calling them; nothing else changes. |
| C9 | **No `tagKey` field is added to the charge form** | The expansion design specified one ("Tag, when the line is tag-driven"); the build never had it. Stage-4 item 3 may remove the two-gate and `tagKey` with it. Building it now risks building something Stage 4 deletes. |
| C10 | **Fix `lib/api.ts`'s `raise()` at the boundary** | A deferred minor from the masters review: an empty `body.message` yields an empty `ApiError.message`, so alerts render blank. This design consolidates six scattered error slots into one region per form — that region silently rendering nothing on a real failure is strictly worse than six that do. |
| C11 | **Test fixtures, not 22 edited literals** | Adding required `contacts` to client and warehouse create breaks 22 HTTP call sites across 5 specs. The masters branch solved the identical problem with a shared `ffFixture()` across 49 call sites; `clientFixture()` and `warehouseFixture()` follow that precedent. |

## 4. Architecture

### 4.1 Shared form shell

Four components under `apps/web/src/features/masters/form/`, composed by all six forms:

- **`MasterForm`** — page chrome: `max-w-3xl`, `<h1>`, one form-level `role="alert"` region, an
  optional advisory banner slot (§5.3), and a footer action bar with **Save** and **Cancel**.
- **`FormSection`** — `<section>` + uppercase muted `<h2>` + the `grid sm:grid-cols-2
  gap-x-4 gap-y-3` body, lifted verbatim from the FF master.
- **`Field`** — Label + control + inline `role="alert"` error. Retires the `err()` helper
  currently redefined in four files.
- **`SelectField`** — wraps `ui/select`, retiring the four copies of the `selectClass` literal.

Per-field inline errors are kept, not replaced by a page-level summary. `ContractAndRatesSection`
documents why, and the masters branch tried the summary and reversed it: it left a twenty-field
form with no error attached to any field.

### 4.2 Sections per master

| Master | Sections |
|---|---|
| Client | Company · Address · **Contacts** · Warehouses |
| Freight Forwarder | Company & contact · Address · Service & commercial · **Contacts** · Warehouses |
| Vessel | Vessel *(one section, same chrome)* |
| Warehouse | Warehouse · Address · Capacity & capabilities · Operations · Contract & rates *(OWNED/CONTRACTED only)* · Vehicles · **Contacts** |
| Charge line | Classification · Presentation |
| FX rate | Rate |

Client and Vessel gain the **Status** field their schemas already carry but their forms never
rendered.

### 4.3 One draft, one Save

A single `react-hook-form` instance owns the parent fields *and* `contacts` (via
`useFieldArray`), `warehouseIds`, and `vehicles`. Nothing touches the network until Save. Save is
one POST (create) or one PATCH (edit).

Consequences: the "Save this record before adding contacts" guards disappear; a contact added and
then removed before Save never reaches the server; and promoting a contact to PRIMARY is a local
edit that demotes the incumbent, so the 409 and its `PROMOTION_HINT` ("demote the current primary
first") become unreachable and are deleted.

### 4.4 Composite create/update

`clients`, `freight-forwarders` and `warehouses` accept children on the parent endpoints and
reconcile them in **one `$transaction`**.

Reconcile order inside the transaction is **deletes → demotions → updates → promotions**. Any
other order trips `ClientContact_one_primary` / `FreightForwarderContact_one_primary` /
`WarehouseContact_one_primary` mid-transaction, on a payload that is perfectly valid as a whole.

Contact items carry an optional `id`: present means update, absent means create, omitted from the
array means delete.

| Endpoint | `contacts` | `warehouseIds` | `vehicles` |
|---|---|---|---|
| `POST /api/clients` | **required, min 1, exactly one PRIMARY** | optional | — |
| `PATCH /api/clients/:id` | optional | optional | — |
| `POST /api/freight-forwarders` | optional (C5 — derived from `pic`/`contactNumber`/`email` when absent, exactly as today) | optional | — |
| `PATCH /api/freight-forwarders/:id` | optional | optional | — |
| `POST /api/warehouses` | **required, min 1, exactly one PRIMARY** | — | optional |
| `PATCH /api/warehouses/:id` | optional | — | optional |

FF create stays backward-compatible by construction, so no FF spec changes.

**The update rule, stated once.** On every `PATCH`, `contacts` is optional, and when supplied it
must contain **at most one** PRIMARY — never two, never required to have one. The pressure to add
a missing primary comes from the banner (§5.3), not from a rejected save. The UI adds one
refinement the API does not: Save is blocked with *"One contact must be marked Primary"* when the
draft has contacts but no primary **and the record loaded with one** — i.e. the user is about to
demote away a primary that existed. A record that loaded without one saves freely, banner intact.

**Warehouse assignment under the draft.** `WarehousePicker` stops calling
`PUT /:id/warehouses` and instead toggles `warehouseIds` in the draft. Its own fetch of the
unassigned pool is unchanged, including the documented 100-row cap that search reaches past.

**Conflict mapping.** `mapUnique`'s `one_primary` branch is **dead code**: Prisma reports
`meta.target` as the column (`["clientId"]`), never the index name, so a second-primary conflict
has always returned the wrong message — and status-only assertions could not detect it. The
composite reconcile therefore does a **query-before-write** check for an existing primary and
raises the 409 itself, matching the two later conflict branches the masters branch built this way
deliberately. The dead branch is removed rather than left to look load-bearing.

### 4.5 Contacts section

A `ui/table` with columns **Name · Designation · Email · Phone · Channels · POC · Status ·
actions**.

- **Add contact** opens a `Dialog` carrying all nine fields of `contactCoreSchema` — including
  `designation` and `status`, capturable for the first time.
- **Edit** reopens the same dialog, prefilled. **Remove** confirms in-row. Both mutate the draft.
- Setting a row to PRIMARY auto-demotes the incumbent in the draft.
- Save is blocked with *"One contact must be marked Primary"* when the draft has none, on all
  three contact-bearing masters.

### 4.6 FX rates

New `/masters/fx-rates/new` route and `FxRateFormPage` on the shared shell. The list page gets a
**New FX rate** button identical to the Clients list's. `AddRateForm` moves off the list page.
Existing rates stay read-only history.

## 5. Behaviour details

### 5.1 The FF mirror

While creating, `pic` / `contactNumber` / `email` drive a synthetic PRIMARY row rendered in the
contacts table. The user may add further contacts but cannot mark a second primary. On submit, the payload
omits `contacts` when the mirrored row is the only contact, and `create()` seeds the primary
exactly as it does today. When the user has added further contacts, the payload carries all of
them **including** the mirrored primary — and `create()` skips its seed whenever `contacts`
already contains a PRIMARY, so the row is written once, not twice. That skip is the single line
that keeps `FreightForwarderContact_one_primary` from tripping on an otherwise valid payload.

On an existing record the three fields stay `disabled` and display whichever contact is PRIMARY.
Editing that contact in the dialog updates them after save, via `syncPrimaryContactColumns`.

### 5.2 Vehicles

`vehicles` joins the Warehouse draft as a `useFieldArray` with a Remove action, backed by the
existing DELETE endpoint through the composite reconcile.

### 5.3 The advisory banner

A record loaded without a PRIMARY contact renders a persistent banner in `MasterForm`'s slot:
*"This client has no primary contact. Add one so quotes can address correspondence."* — Client,
FF and Warehouse wordings differ only in the noun. The record stays saveable. The same state
renders as a marker in the list row.

In practice FF rows all have one from the migration backfill, and the Warehouse table is new
enough (no consumer yet — Stage-4 item 7) that few rows exist. The banner mostly matters for the
two production clients.

## 6. Charge Catalogue: Input type and Sort order

**Input type** decides the forwarder's input widget and how the line is priced. But
`resolveChargeConfig` filters the catalogue to `PLAIN` and `HEAVY_WEIGHT_CALC` only
(`charge-config.ts:79`), and `quote-engine.ts:240` skips anything else. `TRUCKING` and
`WAREHOUSE_STAGING` lines are seeded through separate FF-portal endpoints, never through the
matrix. The admin form offers all four, so **two of the four values silently create a charge line
that no RFQ will ever show** — saved successfully, invisible forever.

Fix: the create dropdown offers **Plain** and **Heavy-weight calculation** only. An existing row
carrying `TRUCKING` or `WAREHOUSE_STAGING` renders it read-only with a note that the line is
seeded through the portal, not the matrix.

**Sort order** orders the FF portal's charge list (`charge-config.ts:87`), orders both catalogue
queries, and is **frozen onto the quote** at distribute (`charge-config.snapshot.ts:27`) — so it
is real. But the service already auto-assigns `max + 10` within the mode+category group
(`charge-catalogue.service.ts:82`), the field appears only on edit, and `reference-seed.ts:168`
records fractional values being silently truncated to `Int`. An absolute hand-typed integer is
the wrong control for "third in this group".

Fix: the typed field is replaced by **↑ / ↓ actions within the mode+category group**, backed by a
new `PATCH /api/charge-line-definitions/reorder` taking an ordered id list and rewriting
`sortOrder` in one transaction, gated `@Roles(ADMINISTRATOR, MANAGER)` like every other write on
that controller. Reordering is scoped to a group because that is the only frame in which the
number is meaningful. The endpoint rejects an id list that spans more than one mode+category
group, so a reorder can never renumber rows the user was not looking at.

Both columns leave the list table. Input type renders as a badge beside the label only when it is
not `PLAIN`.

**Must survive the rework:** the list page's `.filter(l => l.category != null)`, which hides
`ROAD_WH_HANDLING` while warehousing is deferred (Stage-4 item 6).

## 7. What this touches, and what it must not

### 7.1 No migration

Every field surfaced already exists: `designation` and `status` on `contactCoreSchema`, `status`
on `clientCreateSchema` and `vesselCreateSchema`, `WarehouseVehicle`. This branch never runs
`prisma migrate dev`, which the handoff warns would propose **dropping the three partial unique
indexes** the one-primary rule depends on.

The one new endpoint (`/charge-line-definitions/reorder`) writes an existing column.

### 7.2 Do not touch

- `apps/api/src/seed/reference-seed.ts`'s upsert `update: {}`. `deploy.yml:62` runs the reference
  seed on **every** production deploy; a full overwrite would silently revert every admin edit to
  the catalogue.
- `deriveZone` / `deriveRole` and their `charge-derivation.spec.ts` oracle.
- `resolveChargeConfig`, `ChargeMatrix`, `LegSection`, `RfqPrintView`, `quote-engine.ts` — all
  Stage-4-pass territory.

### 7.3 Test ripple

Required `contacts` on client and warehouse create breaks **22 HTTP call sites across 5 specs**
(`clients.e2e-spec.ts` 6, `clients-address.e2e-spec.ts` 3, `warehouses.e2e-spec.ts` 10,
`warehouse-linking.e2e-spec.ts` 2, `master-audit.e2e-spec.ts` 1). Resolved with `clientFixture()`
and `warehouseFixture()` helpers per C11.

Prisma-direct `client.create` calls (7 across 5 specs) bypass Zod and are unaffected.

This is the same *shape* of break as masters' `FreightForwarderCreateInput` change. Any other
in-flight branch merging this should check `pnpm --filter @svyft/api typecheck` for
`ClientCreateInput` / `WarehouseCreateInput` before suspecting its own commits.

## 8. Interaction with the Stage-4 pass

The Stage-4 pass (§9 of the expansion design) is unblocked and unspecced. Checked item by item:

| Stage-4 item | Interaction |
|---|---|
| 1. Retire FF's `pic`/`contactNumber`/`email`/`whLocation` | **Helps.** C5 makes the three fields a projection of the primary contact row, so retiring the columns is deleting three mirrored inputs. |
| 2. Retire `zone`/`role` | None — they never appear in the UI. |
| 3. Remove the tag two-gate | None, and it dictates C9: no `tagKey` field is added. |
| 4. Make `variant` filter | None — `variant` stays immutable-after-create. |
| 5. Audit columns incl. `FxRate` | None — the FX change is a form page, no schema. |
| 6. Warehousing in the catalogue | The `category != null` filter must survive (§6). |
| 7. Wizard/`Point` migration | The Warehouse master gains its first consumer. C3 now guarantees every warehouse has a primary contact, so if the wizard needs a warehouse POC it will have one. |

**Still outstanding, and not addressed here:** the post-deploy corrections — two forwarders'
payment terms and 23 lead times. Both fields stay editable in the new FF form, so the correction
remains possible; this branch does not apply it. The three open workbook questions (destination
charges always-included?, shipment type, FSC/Peak/Heavy) also remain open and should be settled
before the Stage-4 pass starts.

## 9. Testing

- **Web (vitest):** per screen — draft-then-save (no network before Save), the primary-contact
  block, the advisory banner on a record loaded without one, dialog add/edit/remove, PRIMARY
  auto-demotion, the FF mirror, charge-line reordering.
  Auth-gated assertions must await the role-gated element itself, never "data loaded then assert
  role-gated UI" — that race caused PR #54's CI failure and 17 files share the shape.
- **API (e2e):** composite create and update for all three masters; reconcile ordering (a payload
  that both demotes and promotes in one request must succeed); the query-before-write 409 with
  its correct message; charge-line reorder.
- **Full `pnpm run ci`** plus `tsc` per task — vitest's esbuild does not type-check, so type
  errors otherwise pile up silently in test files.

## 10. Out of scope

- No toast system. Errors stay `role="alert"` regions.
- No hard-delete for master records; `status` remains the lifecycle.
- No changes to the query wizard, the FF portal, or the RFQ readers of `pic` / `whLocation` /
  `zone` / `role`.
- No FX rate edit or delete.
- The post-deploy corrections (§8).
