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
6. Contacts editable and deletable from the row. — **superseded 2026-08-31: all contact
   mutations happen in the dialog instead; see §4.5.**

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
| C6 | **Charge Catalogue: Input type restricted to its two working values; Sort order hidden entirely** | See §6. Both columns leave the list table; Sort order also leaves the form. No new endpoint, no migration. §6.3 records why adding reordering later needs neither. |
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

Reconcile order inside the transaction is **deletes → demotions → promotions → creates**.
Demoting before promoting is the load-bearing half: any other order trips
`ClientContact_one_primary` / `FreightForwarderContact_one_primary` /
`WarehouseContact_one_primary` mid-transaction, on a payload that is perfectly valid as a whole.
Creates run last, non-primary first, but that is defensive consistency rather than a second index
hazard — by then the payload has been capped at one PRIMARY and the deletes and promotions have
already run, so a lone primary create cannot collide with anything.

> **Correction (2026-09-01, whole-branch review).** This paragraph originally read "deletes →
> demotions → **updates** → **promotions**" — promotions last, creates unmentioned. That is not
> what `apps/api/src/common/reconcile-contacts.ts` does, and it is the single sentence a future
> maintainer is most likely to trust over the code. The order above is the implemented one.

Contact items carry an optional `id`: present means update, absent means create, omitted from the
array means delete.

| Endpoint | `contacts` | `warehouseIds` | `vehicles` |
|---|---|---|---|
| `POST /api/clients` | **required, min 1, exactly one PRIMARY** | optional | — |
| `PATCH /api/clients/:id` | optional | optional | — |
| `POST /api/freight-forwarders` | optional — but **exactly one PRIMARY when supplied**; derived from `pic`/`contactNumber`/`email` when absent (C5) | optional | — |
| `PATCH /api/freight-forwarders/:id` | optional | optional | — |
| `POST /api/warehouses` | **required, min 1, exactly one PRIMARY** | — | optional |
| `PATCH /api/warehouses/:id` | optional | — | optional |

FF create stays backward-compatible for callers that omit `contacts` entirely.

> **Correction (2026-09-01, whole-branch review).** The FF create row said `contacts` was
> "optional … exactly as today". It is now optional-but-`exactlyOnePrimary`-when-supplied, so an
> explicit `contacts: []` is a 400 rather than a no-op. The line "FF create stays
> backward-compatible by construction, so no FF spec changes" was true only of the omitted case
> and is narrowed above.

**The update rule, stated once.** On every `PATCH`, `contacts` is optional, and when supplied it
must contain **at most one** PRIMARY — never two, never required to have one. The pressure to add
a missing primary comes from the banner (§5.3), not from a rejected save. The UI adds one
refinement the API does not: Save is blocked with *"One contact must be marked Primary"* when the
draft has contacts but no primary **and the record loaded with one** — i.e. the user is about to
demote away a primary that existed. A record that loaded without one saves freely, banner intact.

**Warehouse assignment under the draft.** `WarehousePicker` stops calling
`PUT /:id/warehouses` and instead toggles `warehouseIds` in the draft. Its own fetch of the
unassigned pool is unchanged, including the documented 100-row cap that search reaches past.

**Conflict mapping.** The composite reconcile does a **query-before-write** check for a
second primary and raises the 409 itself, matching the two later conflict branches the masters
branch built this way deliberately. It does that because Prisma reports `meta.target` as the
column (`["clientId"]`), never the index name, so a conflict caught on the composite path could
not be told apart from any other unique violation on that column — checking first is what lets
the message name the rule.

`mapUnique`'s `one_primary` branch **stays**. It matches on exactly that column-based P2002
target, it fires, and it is the sole source of the 409 message four e2e specs assert for the
standalone `POST`/`PATCH /:id/contacts` endpoints (design C8 keeps those live).

> **Correction (2026-09-01, whole-branch review).** This paragraph originally called that branch
> "dead code" and said it "is removed". Both are false — `clients.service.ts` now carries a
> comment directly contradicting the earlier text. The mid-execution plan was corrected
> (`46a9020 docs: correct the plan's false "dead mapUnique branch" premise`); the design was not,
> until now.

### 4.5 Contacts section — every mutation is a dialog

**Decision (user, 2026-08-31), superseding the brief's point 6.** Add, Edit *and* Remove all
happen in the dialog. The table is a read-only list of records you select; it carries no per-row
action buttons and no inline editing. This replaced an earlier design with inline row edit and an
in-row delete confirm.

The table is a `ui/table` with columns **Name · Designation · Email · Phone · Channels · POC ·
Status**. There is no actions column.

- **Add contact** — a button above the table opens an empty `Dialog` carrying all nine fields of
  `contactCoreSchema`, including `designation` and `status`, capturable for the first time.
- **Selecting a row** opens that contact in the same dialog, prefilled. The control is a real
  `<button>` wrapping the contact's **name** in the Name cell, so the row is reachable by
  keyboard and announced as activatable rather than being a `<tr>` with a click handler.

  > **Correction (2026-09-01, whole-branch review).** This originally specified "a `<button>`
  > spanning the row". That is not achievable: a `<button>` cannot span `<td>`s without breaking
  > table semantics (the only markup that would span the row is a `<button>` wrapping the `<tr>`,
  > which is invalid HTML). The implementation puts the button in the Name cell, which is
  > correct; the text above now matches it.
- **Remove** is a destructive-styled button *inside* the dialog, present only when editing an
  existing contact. It asks for confirmation within the dialog, then closes.
- Every one of these mutates the **draft only**. Nothing reaches the server until the parent
  form's Save (§4.3), so a contact added and then removed never existed as far as the API is
  concerned, and Cancel on the parent form discards the lot.
- POC level is a field in the dialog. Setting a contact to PRIMARY auto-demotes the incumbent in
  the draft, so the second-primary conflict is unreachable from the UI.
- Save is blocked with *"One contact must be marked Primary"* per the rule in §4.4, on all three
  contact-bearing masters.

### 4.6 FX rates

New `/masters/fx-rates/new` route and `FxRateFormPage` on the shared shell. The list page gets a
**New FX rate** button identical to the Clients list's. `AddRateForm` moves off the list page.
Existing rates stay read-only history.

## 5. Behaviour details

### 5.1 The FF mirror

While creating, `pic` / `contactNumber` / `email` drive a synthetic PRIMARY row rendered in the
contacts table. The user may add further contacts but cannot mark a second primary. On submit the
payload **always** carries the full mirrored array — `[mirror, ...extras]` — never `contacts: []`
and never an omitted `contacts`. `create()` skips its own seed whenever the caller supplies
**any** `contacts` at all — the guard is `if (!contacts?.length)`, not a test for a PRIMARY in the
payload. The two coincide for every schema-valid body, since
`freightForwarderCreateSchema`'s `exactlyOnePrimary`-when-supplied refine guarantees a supplied
array already carries exactly one, which is how the record still ends with **exactly one PRIMARY
after create** — the real requirement.

> **Corrections (2026-09-01, whole-branch review).** Three claims here were wrong — the third
> introduced by this very correction pass and caught in re-review.
>
> 1. "the payload omits `contacts` when the mirrored row is the only contact" is superseded: the
>    FF page now always sends `[mirror, ...extras]`, because `freightForwarderCreateSchema`'s
>    `exactlyOnePrimary`-when-supplied refine makes an explicit `[]` a 400, and sending the array
>    uniformly removes the special case for "no extra contacts".
> 2. The skip was called "the single line that keeps `FreightForwarderContact_one_primary` from
>    tripping". It is not: `reconcileContacts` deletes before it creates, so that index never
>    trips on this path. The skip's real job is the exactly-one-PRIMARY-after-create invariant,
>    as restated above.
> 3. The 2026-09-01 rewrite of the paragraph above then restated the skip's *condition* wrongly,
>    as "whenever `contacts` already contains a PRIMARY". The guard is `if (!contacts?.length)` —
>    any supplied array skips the seed, primary or not — and
>    `freight-forwarders.service.ts:81-83` carries a comment warning against exactly that
>    phrasing. Extensionally equivalent for schema-valid payloads, so no behavioural
>    consequence, but it was the design contradicting the source it describes, in the paragraph
>    that exists to stop that.

On an existing record the three fields stay `disabled` and display whichever contact is PRIMARY.
Editing that contact in the dialog updates them after save, via `syncPrimaryContactColumns`.

### 5.2 Vehicles

`vehicles` joins the Warehouse draft as a `useFieldArray`, and follows the **same dialog pattern
as contacts** (§4.5) rather than keeping its own always-expanded add form: a read-only table,
an Add vehicle button, row-select to edit, and Remove inside the dialog. Consistency across the
two child collections on one screen is the point of this work; leaving vehicles on a different
interaction model would reintroduce exactly what this pass removes.

This is also where vehicles gain a Remove at all — `DELETE /:id/vehicles/:vehicleId` has always
existed and the UI never exposed it.

### 5.3 The advisory banner

A record loaded without a PRIMARY contact renders a persistent banner in `MasterForm`'s slot:
*"This client has no primary contact. Add one so quotes can address correspondence."* — Client,
FF and Warehouse wordings differ only in the noun. The record stays saveable.

In practice FF rows all have one from the migration backfill, and the Warehouse table is new
enough (no consumer yet — Stage-4 item 7) that few rows exist. The banner mostly matters for the
two production clients.

> **Dropped requirement (2026-09-01, whole-branch review).** This section also required that
> "the same state renders as a marker in the list row". **That was never built** — no list page
> was touched by this branch. It is recorded here as a deliberate omission rather than left as a
> silent one. The reasoning is this section's own: the state is rare (backfilled FF rows all
> have a primary, the Warehouse table is barely populated), so the marker's whole audience is
> the two production clients — who reach the banner the moment they open the record anyway. The
> list marker would need `ClientDto`/`WarehouseDto` list payloads to carry a primary-contact
> flag they do not carry today, which is a payload change on a hot list endpoint for a
> two-row-wide benefit. If it is wanted, it belongs to the Stage-4 pass alongside the other
> list-surface work.

## 6. Charge Catalogue: Input type and Sort order

Both columns are load-bearing, but for different reasons, and neither should be a control the
admin operates. This section records the full trace so the question does not have to be
re-litigated.

### 6.1 Input type — a structural marker, not a setting

`inputType` records **which pricing structure a charge line belongs to**. Across the ~70 seeded
definitions it is non-default on exactly three rows:

| Value | Rows | Meaning |
|---|---|---|
| `PLAIN` | ~67 | A flat amount box in the forwarder's charge matrix |
| `HEAVY_WEIGHT_CALC` | 1 — `AIR_MAIN_HEAVY_WEIGHT` | Renders piece weight / airline limit / rate-per-excess-kg instead of one amount box (`ChargeMatrix.tsx:137`) |
| `TRUCKING` | 1 — `ROAD_CORE_TRUCKING` | **Never in the charge matrix.** Priced through `draft.trucking` |
| `WAREHOUSE_STAGING` | 1 — `ROAD_WH_HANDLING` | **Never in the charge matrix.** Priced through `draft.warehouse` |

Four consumers read it: the filter in `resolveChargeConfig` (`charge-config.ts:79`), the widget
switch in `ChargeMatrix`, two validation branches in `quote-engine.ts:235-240`, and the client
re-reading it off `seededCharges` (`LegSection.tsx:313`). It is also frozen onto every quote as
`ResolvedChargeLine.inputType`.

**Dropping it entirely is not available.** Without the filter, the trucking and warehouse lines
render as flat-amount rows *in addition to* their real per-endpoint rate rows — the same charge
counted twice in the quote total. Without the widget switch, the air heavy-weight line gets one
amount box and its formula has no inputs.

**But it must not stay a free-choice dropdown.** The trucking and warehouse rate rows are
generated from the **leg's endpoints** in `seedQuoteDraft`, never from catalogue rows. No code
path anywhere instantiates a second trucking or staging line from a new catalogue entry. So an
admin selecting `TRUCKING` today does not hit a filter edge case — they create a row that
**nothing in the system will ever read**, saved successfully and invisible forever.

**Decision:** the form offers **Plain** and **Heavy-weight calculation** only. A row already
carrying `TRUCKING` or `WAREHOUSE_STAGING` renders it read-only with a note that the line prices
through the portal's rate rows, not the matrix. The column leaves the list table and renders as a
badge beside the label only when it is not `PLAIN`.

### 6.2 Sort order — required by the system, not by the user

**Correcting the record:** an earlier draft of this design said `sortOrder` is frozen onto the
quote at distribute. It is not. `ResolvedChargeLine` carries `definitionKey`, `role`, `inputType`,
`zone` and `label` and no ordering field (`charge-config.ts:46`). The `sortOrder: i` written in
`ff-portal.service.ts:540` is a different column on `ChargeLine`, set to the draft array index.

Its only effect is to `.sort()` the snapshot's `lines` array (`charge-config.ts:87`), and that
array order becomes the row order of the forwarder's charge matrix. The number itself is never
stored on a quote.

**Dropping it entirely is not free.** `findMany` with no `orderBy` returns heap order, which
shifts after any update — forwarders would see charges shuffled, and differently between two
RFQs. It would have to be replaced by something, not simply deleted.

**But the user never needs to see it.** `sortOrder` predates `category`: when it was designed
there was no grouping column, and the masters expansion added ORIGIN/FREIGHT/DESTINATION/
ADDITIONAL only in August 2026. Category now does the coarse ordering; `sortOrder` decides
position only *within* a group. Meanwhile the service already auto-assigns `max + 10` within the
mode+category group (`charge-catalogue.service.ts:82`), the field surfaces only on edit, and
`reference-seed.ts:168` records fractional values being silently truncated to `Int`. A hand-typed
absolute integer is the wrong control for "third in this group".

**Decision (user, 2026-08-31): keep the column, hide it completely.** It leaves the list table
*and* the edit form. The service keeps assigning it on create. Nobody types it. No new endpoint,
no migration, and the seeded order is preserved exactly.

**Accepted cost:** a newly created charge line always lands at the **end of its category group**.
There is no way to place it mid-group until reordering is built.

### 6.3 Adding reordering later — the upgrade path, for the record

Recorded at the user's request, because the decision above was taken on the understanding that it
does not paint us into a corner. It does not:

- **No schema change.** `sortOrder` stays exactly as it is. Hiding the field and a future
  reordering UI need the identical column; hiding changes nothing about storage.
- **No change to any existing endpoint.** `chargeLineUpdateSchema` already picks `sortOrder` as a
  patchable field (`masters/charge-catalogue.ts:117`), so reordering is implementable *today* with
  N existing `PATCH /api/charge-line-definitions/:id` calls and no API work at all.
- **The only optional addition** is a `PATCH /api/charge-line-definitions/reorder` taking an
  ordered id list and rewriting the group in one transaction — worth adding purely for atomicity,
  gated `@Roles(ADMINISTRATOR, MANAGER)` like every other write on that controller, and rejecting
  an id list spanning more than one mode+category group so a reorder can never renumber rows the
  user was not looking at. Strictly additive: nothing existing changes.

So the sequence is hide-now, reorder-later-if-business-asks, with no rework of anything shipped in
between.

### 6.4 Must survive the rework

The list page's `.filter(l => l.category != null)`, which hides `ROAD_WH_HANDLING` while
warehousing is deferred (Stage-4 item 6).

## 7. What this touches, and what it must not

### 7.1 No migration

Every field surfaced already exists: `designation` and `status` on `contactCoreSchema`, `status`
on `clientCreateSchema` and `vesselCreateSchema`, `WarehouseVehicle`. This branch never runs
`prisma migrate dev`, which the handoff warns would propose **dropping the three partial unique
indexes** the one-primary rule depends on.

**No new endpoint either.** An earlier draft of this design proposed
`PATCH /charge-line-definitions/reorder`; §6.2 supersedes it. The API surface is unchanged apart
from the composite create/update payloads in §4.4.

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
  block, the advisory banner on a record loaded without one, PRIMARY auto-demotion, the FF
  mirror, and the Charge Catalogue form offering only Plain and Heavy-weight while rendering an
  existing `TRUCKING`/`WAREHOUSE_STAGING` row read-only.
  For contacts and vehicles specifically: the table exposes **no** row action buttons; selecting
  a row opens the dialog prefilled; Remove lives inside the dialog and is reachable only when
  editing an existing record; and every mutation is asserted to leave the network untouched until
  the parent Save.
  Auth-gated assertions must await the role-gated element itself, never "data loaded then assert
  role-gated UI" — that race caused PR #54's CI failure and 17 files share the shape.
- **API (e2e):** composite create and update for all three masters; reconcile ordering (a payload
  that both demotes and promotes in one request must succeed); the query-before-write 409 with
  its correct message.
- **Full `pnpm run ci`** plus `tsc` per task — vitest's esbuild does not type-check, so type
  errors otherwise pile up silently in test files.

## 10. Out of scope

- No toast system. Errors stay `role="alert"` regions.
- No hard-delete for master records; `status` remains the lifecycle.
- No changes to the query wizard, the FF portal, or the RFQ readers of `pic` / `whLocation` /
  `zone` / `role`.
- No FX rate edit or delete.
- The post-deploy corrections (§8).
