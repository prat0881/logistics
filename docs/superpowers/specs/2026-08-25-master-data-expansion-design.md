# Master Data Expansion — Design

**Date:** 2026-08-25
**Branch:** `worktree-feat+masters`, cut from `main` @ `b875291`
**Source:** `Master Tables — Freight Forwarder / Client / Vessel / Warehouse (3).xlsx`
**Gap matrix:** https://claude.ai/code/artifact/49bbc1fe-ec04-4d89-ae26-144f0de76de4

> **AS BUILT (2026-08-31).** Delivered on `feat/masters`, **merged via PR #53** into `main`, and
> **deployed to production** — the CD run applies `prisma migrate deploy`, so every migration in §6
> is live. What this design did not anticipate is captured in `docs/Masters - Session Handoff.md`:
> ten defects found by implementers, two lossy production conversions decided as deploy-then-correct
> (`docs/superpowers/specs/2026-08-26-post-deploy-corrections.md` — **that file has an unfinished
> action; read it before anything else**), and four raw-SQL invariants Prisma cannot express.

## 1. Purpose

Bring the master-data layer up to the specification in the master-tables workbook: extend the
three existing masters (Client, Freight Forwarder, Vessel), add a Warehouse master, add an
admin-managed Charge Line Catalogue, and put actor-level audit columns on every master table.

## 2. Scope

### 2.1 The governing constraint

**No Stage-4 or Stage-5 code is modified in this build.** Masters are stabilised first; the
quote engine, FF portal, RFQ service and their tests are adapted in a later pass.

Every change below is therefore additive at the boundary. Where a master change would otherwise
alter something the quote layer reads, the old representation is kept populated alongside the
new one. Three specific collisions were found and contained:

| Master change | Stage-4 consumer | Containment |
|---|---|---|
| FF contacts move to a child table | `rfq.service.ts:228` snapshots `pic`, `contactNumber`, `email`, `whLocation` into the RFQ payload | The four columns stay, synced from the primary contact |
| `zone` → `category`, `role` → `isAdditional` | `resolveChargeConfig`, called once from `charge-config.snapshot.ts:35` | New columns added alongside; `zone` and `role` stay populated in sync |
| Removing the tag two-gate | `resolveChargeConfig` and the executive's selection UI | Deferred — `tagKey` and the two-gate keep working |

Verified clean, with no consumer outside the masters modules: `vesselType`, and every Client,
Warehouse and audit-column change.

**The catalogue is read at one moment, not continuously.** `resolveChargeConfig` runs at
distribute and freezes its result onto the quote: `ChargeLine` carries its own `zone`, `label`,
`definitionKey`, `sortOrder` and `rateVariant`. Everything downstream reads those frozen rows —
`RfqPrintView` reads `c.zone` off a `ChargeLine`, and `LegSection` shape-fills `role: "CORE"`
with the comment that it is unused. Likewise `FreightForwarderDto` in `rfq.service.ts` is a
transient read model rebuilt per request, never persisted. So the surface to protect is one
function at one moment, plus one DTO shape.

### 2.2 How the parallel change works

Three phases. Only the first is in this build.

**Phase 1 — expand (here).** Add the new columns and backfill them from the old. The admin
screen writes the new ones; the service derives the old ones in the same transaction.
`resolveChargeConfig` is untouched, so distribute produces identical snapshots and no frozen
data moves. Same shape for the forwarder: the contact table becomes the source of truth while
the four columns are rewritten from the primary contact on every contact write.

**Phase 2 — migrate reads (the Stage-4 pass).** Point `resolveChargeConfig` at `category` and
`isAdditional`, and `rfq.service.ts` at the contact table. Equivalence is proven here rather
than assumed: for every row in the catalogue, the old and new logic must produce the same
snapshot — a property assertable over the whole table.

**Phase 3 — contract.** Drop `zone`, `role`, `tagKey` and the four FF columns. Frozen
`ChargeLine.zone` is a different column on a different table and is untouched, so historical
quotes keep rendering.

**What prevents the two copies drifting** is one shared function, not discipline. The
derivations live in `packages/shared` and both writers — the seed and the catalogue service —
call them:

```
category     → zone   Origin → ORIGIN · Freight → MAIN_FREIGHT · Destination → DESTINATION · Additional → null
isAdditional → role   false → CORE · true with a tag → TAG_DRIVEN · true without → STANDARD
```

Both are pure and total, and an invariant test asserts `zone === deriveZone(category)` and
`role === deriveRole(isAdditional, tagKey)` across every row, so drift fails CI.

**Data can still change behaviour where code does not**, since data flows through unchanged
code. Two such paths exist and both are closed in this build:

- Three of the new lines are always-included, so they would price on every future Air and Sea
  RFQ the moment the seed ran. They seed **inactive** instead (D17).
- Editing a line's Category changes what future quotes freeze — moving an Air tag line to
  Additional derives `zone` to null, and the print view would render "—" instead of
  "Destination". Category and Additional are therefore **set on create and immutable
  afterwards** in this build (D18).

Together these give the build's acceptance criterion: **distribute must produce byte-identical
snapshots before and after.**

### 2.3 In

1. Client master — address fields, contact channels, contact lifecycle.
2. Freight Forwarder master — mandatory address, enumerated payment terms, numeric lead time,
   a contacts child table, and a link to warehouses.
3. Vessel master — mandatory IMO and shipping line, vessel type relaxed to free text.
4. Warehouse master — new entity, with contacts, a vehicle breakdown, a rate card, and
   ownership links to a forwarder or a client.
5. Charge Line Catalogue — admin CRUD over `ChargeLineDefinition`, seeded with the 19 lines the
   workbook names that have no definition today.
6. Audit columns (`createdById`, `updatedById`) on the master tables.

### 2.4 Out, and why

- **FX Rate master.** Already built on the Stage-5 branch as `FxRate`, with fields identical to
  the workbook's (`currency`, `unitsPerUsd`, `effectiveFrom`, `note`). Building a second one
  guarantees a schema conflict. Follow-up: add audit columns to it once Stage 5 merges.
- **Warehouse charge lines in the catalogue.** Deferred by decision — the category list is
  Road/Air/Sea only. Warehouse charges remain defined by the Warehouse Charges sheet and priced
  from the Warehouse master's rate card.
- **Everything in §2.1's containment table** — the Stage-4 pass, specced separately (§9).
- **Air Direct/Indirect as a priced quoting variant.** Same pass. The catalogue stores the
  variant; nothing filters on it yet.
- **The wizard/`Point` migration.** Warehouses on a query keep working as they do today; the
  master is standalone in this build.
- **Audit columns on the other 28 models.** A later pass, once the pattern is proven here.

## 3. Decisions taken

| # | Decision | Note |
|---|---|---|
| D1 | Warehouse types stored as `OWNED` / `CONTRACTED` / `CLIENT` / `FF` | Labelled neutrally in the UI too; no brand name in either layer |
| D2 | Country and city are free text on all masters | Until a geography source exists. FF `availableCountries` keeps its enum — a different concept |
| D3 | Warehouse type is independent of ownership | Type is a plain dropdown; linking happens from the Forwarder and Client forms |
| D4 | Rates live on the Warehouse master; calculation happens at quotation | Plus `rateCurrency`, since an unconverted rate cannot be quoted |
| D5 | Contacts share a nine-field shape across FF, Client and Warehouse | WhatsApp / WeChat / Botim as three separate booleans |
| D6 | `POC Level` (Primary / Secondary / None) replaces the primary boolean | Applied to all three contact tables, including FF, whose sheet still shows the boolean |
| D7 | Newly-mandatory fields are backfilled, then made `NOT NULL` | Including IMO — see D8 |
| D8 | IMO backfills with generated seven-digit numbers | Taken against recommendation: a generated value is indistinguishable from a real IMO once it reaches an RFQ. The migration logs every vessel it touches |
| D9 | Vessel type drops its enum for free text | Taken against recommendation: nothing constrains the field afterwards, so spellings will drift. Verified to have no consumer outside the vessels module |
| D10 | Charge variant is a single stored value including `BOTH` | Multi-select in the UI; both selected collapses to `BOTH`. Stored now, filtered on in the Stage-4 pass |
| D11 | The tag two-gate is **deferred, not removed** | Removing it changes `resolveChargeConfig` and the executive UI, which §2.1 forbids. `tagKey` stays, and the gate keeps working, until the Stage-4 pass |
| D12 | Client `industry` is retained | Optional free text, though it appears on no version of the workbook |
| D13 | Audit columns cover master tables only in this build | The remaining 28 models follow later |
| D14 | No Stage-4 or Stage-5 file is edited | The governing constraint — see §2.1 |
| D15 | FF's four snapshot columns stay, synced from the primary contact | The same contact is stored twice until the Stage-4 pass retires the columns |
| D16 | The charge catalogue gains new columns beside the old, not instead of them | `zone` and `role` stay populated so the quote layer is untouched |
| D17 | The three new always-included lines seed **inactive** | Air Insurance, Sea Container Transport, Sea LSS would otherwise price on every future Air and Sea RFQ the moment the seed ran. The other 16 new lines are executive-selected, so they ship active — they only appear in the selection list |
| D18 | Category and Additional are set on create and immutable afterwards | Both derive `zone` and `role`, which get frozen onto quotes. Unlocked once Phase 2 has repointed the reads and there is only one representation to change |

## 4. Data model

### 4.1 Audit columns

Every table in §4.2–§4.6 gains:

```prisma
createdById String?  @db.Uuid   // User.id, null for seeded and system-created rows
updatedById String?  @db.Uuid
createdAt   DateTime @default(now())
updatedAt   DateTime @updatedAt
```

`createdAt` / `updatedAt` already exist on all of them. The two actor columns are new — no model
in the repo carries one today, and `ChangeLog.actorId` cannot substitute because `ChangeLog`
requires a `queryId` and so cannot describe master-data edits.

Nullable rather than required, because seed rows and migration backfills have no acting user.
Populated in the service layer from the authenticated request, not by the database.

### 4.2 Client

Added: `streetAddress` (required), `city` (required, free text), `postalCode` (optional).
Unchanged: `country` stays required free text; `industry` stays optional.

`ClientContact` — `email` and `contactNo` become required; add `whatsappAvailable`,
`wechatAvailable`, `botimAvailable` (booleans, default false), `status` (`MasterStatus`), and
`pocLevel` (`PocLevel`: `PRIMARY` / `SECONDARY` / `NONE`, default `NONE`), replacing `isPrimary`.

### 4.3 Freight Forwarder

`companyAddress`, `country` and `city` become required. `paymentTerms` becomes a `PaymentTerm`
enum with ten values (7 / 15 / 30 / 45 / 60 Days Credit, 100% Advance, 50:50, 30:70, 70:30,
100% After Delivery). `typicalLeadTime` changes from `String?` to `Int?`.

New `FreightForwarderContact` with the same shape as `ClientContact`, backfilled from the
existing `pic`, `contactNumber` and `email` columns.

**Those three columns are not dropped** (D15). They stay, kept in sync with whichever contact
carries `pocLevel = PRIMARY`, because `rfq.service.ts` snapshots them into the RFQ payload. The
same applies to `whLocation`, which stays populated with the primary warehouse's name while the
warehouse relation in §4.5 becomes the real link. Both retire in the Stage-4 pass.

Sync happens in the service layer on contact create, update and delete: whenever the primary
contact changes, the three columns are rewritten in the same transaction. Note the sync does not
touch `whLocation` — that column tracks warehouses and has no counterpart on the contact table;
Task 14 wires it to the warehouse relation instead.

**The columns must have exactly one writer.** Two consequences follow, and missing either
produces silent data corruption rather than an error:

- `update()` must **not** write `pic`, `contactNumber` or `email`. If it does, an admin editing
  the forwarder form sets them, and the next contact write of any kind silently reverts them.
  The form renders those three read-only once the record exists, pointing at the contact list.
- `create()` must **seed a PRIMARY contact** from the `pic`/`contactNumber`/`email` it accepts,
  in the same transaction. The migration's backfill establishes "every forwarder has exactly one
  primary contact" for existing rows; without seeding, every row created afterwards breaks that
  invariant — populated columns, empty contact list.

When the primary contact is deleted or demoted, the sync falls back to the oldest remaining
active contact. Only when none remain are the columns left as they were: they are NOT NULL, so
naming a departed contact beats failing the write — but naming a departed contact while a live
one exists would put the wrong person on an RFQ.

### 4.4 Vessel

`imoNumber` and `shippingLine` become required. `vesselType` changes from the `VesselType` enum
to `String`, with existing values converted to human labels (`CONTAINER` → "Container Vessel").
`vesselCode` is retained — it is rendered in the vessels list today.

### 4.5 Warehouse

```prisma
model Warehouse {
  id                 String        @id @default(uuid()) @db.Uuid
  tenantId           String?       @db.Uuid
  name               String        @unique
  type               WarehouseType
  freightForwarderId String?       @db.Uuid   // at most one owner
  clientId           String?       @db.Uuid
  streetAddress      String
  country            String
  city               String
  pinCode            String
  capacity           Decimal       @db.Decimal(14, 2)
  capacityUnit       CapacityUnit
  capabilities       WarehouseCapability[]
  agreementValidUntil DateTime?                // required when type is OWNED/CONTRACTED
  insuranceValidUntil DateTime?                // ditto
  isBonded           Boolean       @default(false)
  weekendWorking     Boolean       @default(false)
  weekendWorkingFee  Decimal?      @db.Decimal(14, 2)
  workingEmployees   Int?
  forkLiftCount      Int?
  dipTrayCount       Int?
  freeStorageDays    Int           @default(0)
  rateCurrency       String?
  handlingRate       Decimal?      @db.Decimal(14, 2)
  handlingUnit       HandlingUnit?
  storageRate        Decimal?      @db.Decimal(14, 2)
  storageUnit        StorageUnit?
  status             MasterStatus  @default(ACTIVE)
}
```

`totalVehicles` is derived from the vehicle table and stored nowhere.

Ownership is one-to-many in both directions and deliberately not a join table: a join table
would permit the many-to-many that the requirement rules out. Both columns are nullable and
independent of `type` (D3). Links are edited from the Forwarder and Client forms; the warehouse
form shows its owner read-only.

`WarehouseContact` mirrors the other contact tables, plus `isWeekendIncharge`. This replaces the
three Weekend POC fields the workbook put on the record — weekend cover is a contact like any
other. `WarehouseVehicle` holds `tonnage` (the existing `TruckTonnage` enum, which the workbook
now matches exactly) and `quantity`.

New enums: `WarehouseType`, `CapacityUnit` (CBM / PALLETS / SQ_FT / MT), `HandlingUnit` (per
pallet / CBM / MT / shipment / package), `StorageUnit` (per CBM/day, CBM/month, pallet/day,
pallet/month, sq ft/month, MT/day), `WarehouseCapability` (six values), `PocLevel`.

Conditional requirements — agreement date, insurance date, bonded flag, free storage days and
the rate card apply only to `OWNED` and `CONTRACTED` warehouses — are enforced in the Zod schema
via `superRefine`, not by the database, because the columns must stay nullable for the other two
types.

### 4.6 Charge Line Catalogue

`ChargeLineDefinition` gains three columns. Nothing is renamed and nothing is removed (D16).

| Field | Status | Notes |
|---|---|---|
| `mode` | existing | Unchanged |
| `variant` | **new** | `DEDICATED` / `GROUPAGE` / `DIRECT` / `INDIRECT` / `FCL` / `LCL` / `BOTH`, validated against `mode`. Stored only — no resolver filters on it yet |
| `category` | **new** | `ORIGIN` / `FREIGHT` / `DESTINATION` / `ADDITIONAL`. Road allows only `FREIGHT` and `ADDITIONAL` |
| `isAdditional` | **new** | Executive-configurable when true; always included when false |
| `label` | existing | Unchanged |
| `zone` | existing, **kept in sync** | Derived from `category`: Origin → `ORIGIN`, Freight → `MAIN_FREIGHT`, Destination → `DESTINATION`, Additional → `null` |
| `role` | existing, **kept in sync** | Derived from `isAdditional` and `tagKey`: false → `CORE`; true with a tag → `TAG_DRIVEN`; true without → `STANDARD` |
| `tagKey` | existing, retained | The two-gate keeps working (D11) |
| `inputType` | existing | Drives the forwarder's input widget |
| `isActive` | existing | The only safe retirement — deleting a used line is refused by the database |
| `key` | existing | Generated, immutable — quote rows reference definitions by key |
| `sortOrder` | existing | Defaults to the current maximum plus ten within its mode and category |

The admin form shows Mode, Variant, Category, Label, Additional, Tag (when the line is
tag-driven), Input type, Sort order and Active. `zone` and `role` never appear in the UI — they
are written by the service from `category` and `isAdditional`, and exist only so that
`resolveChargeConfig` and the FF portal keep working unchanged.

`ROAD_WH_HANDLING` has no valid category while warehousing is deferred. It stays in the table,
untouched, and is filtered out of the Charge Master screen.

**Seed — 70 lines** (51 existing, 19 new); 69 appear on the screen. Existing definitions keep
their current keys — renaming them would mean rewriting `definitionKey` on every quote row that
references them, which §2.1 forbids. Only new lines use the new key pattern. The new ones:

- Air: Insurance (Origin), Magnetic Fee, Europe T1 Document, EDD Security Check, Custom
  Documents T1 (Destination), File Opening Charges (Destination).
- Sea: Container Transport / Loading and LSS (Origin); CFS, DO Release, Container Cleaning,
  Devanning, Wharfage, BAF, CAF, DDF (Destination); Gas Measuring and Emergency Surcharge
  (Additional).
- Road: Bonded Licence Fee (Additional).

Container Cleaning and Devanning seed as `FCL`; everything else as `BOTH`. New Destination lines
are `isAdditional`, following the convention already in the seed rather than the workbook's
"always included" header — see §10.

The three new always-included lines — Air Insurance, Sea Container Transport, Sea LSS — seed
with `isActive: false` (D17), so they exist in the catalogue and price nothing until someone
switches them on from the screen. The other 16 ship active: being executive-selected, they only
add an option to the selection list.

## 5. Code layout

`packages/shared/src/masters.ts` is 134 lines and this roughly triples it, so it becomes a
`masters/` directory — `client.ts`, `freight-forwarder.ts`, `vessel.ts`, `warehouse.ts`,
`contacts.ts`, `charge-catalogue.ts`, `index.ts` — re-exported so no import site changes.

New `apps/api/src/modules/warehouses/` mirroring the clients module. Charge-catalogue writes
extend the existing config module, whose controller exposes only a `GET` today. Web gains
`features/masters/warehouses/` and a catalogue screen, following the existing list/form pair.

All writes are gated `@Roles(ADMINISTRATOR, MANAGER)`, matching every existing master.

## 6. Migrations

Ordered, one per concern. Note there is no drop step — §2.1 keeps every existing column.

1. Additive — new tables, new enums, new nullable columns, audit columns, and the three new
   charge-catalogue columns.
2. Backfill — FF contacts from `pic` / `contactNumber` / `email`; `category` and `isAdditional`
   from `zone` and `role`; addresses from existing values with a placeholder only where
   genuinely empty; IMO numbers generated for vessels lacking one, with the affected vessel ids
   logged.
3. Constrain — `NOT NULL` on the newly-mandatory columns; partial unique indexes for one primary
   contact per parent, which Prisma cannot express and so are raw SQL.

## 7. Testing

Repo conventions: Zod and resolver unit tests in `packages/shared`, an e2e suite per API module,
React Testing Library tests per page. `tsc` runs per task rather than relying on vitest, which
does not type-check.

Specific coverage: the conditional warehouse validation by type; the one-primary-per-parent
constraint; the FF contact backfill; the FF column sync when the primary contact changes; the
`category`/`isAdditional` to `zone`/`role` derivation; the variant/mode validation on charge
lines; and the refusal path when deleting a charge line that a quote references.

**Regression guard:** the existing Stage-4 suites must pass untouched. If a change requires
editing one of their tests, that change belongs to the later pass, not this build.

**Acceptance criterion.** Distribute must produce byte-identical snapshots before and after this
build. The test captures `resolveChargeConfig`'s output for a representative leg against the
pre-change catalogue, then asserts the post-change catalogue yields the same result — which
holds precisely because the three new always-included lines are inactive (D17) and no existing
line's `category` can move (D18). A diff here means the containment has failed somewhere.

## 8. Sequencing

1. Vessel and Client — smallest, and they prove the contact pattern.
2. Freight Forwarder — the contact table, backfill and column sync.
3. Warehouse — the largest, but depends on nothing.
4. Charge Line Catalogue — additive columns, the derivation, and the 19 new lines.
5. FF and Client warehouse linking — last, since it needs both sides to exist.

## 9. The Stage-4 pass, specced separately

Everything deferred by §2.1, to be done as one piece once masters are stable:

- Retire FF's `pic`, `contactNumber`, `email` and `whLocation`; update `rfq.service.ts` and the
  RFQ payload to read the contact table and warehouse relation.
- Retire `zone` and `role`; update `resolveChargeConfig`, `ChargeMatrix`, `LegSection` and
  `RfqPrintView` to read `category` and `isAdditional`.
- Remove the tag two-gate (D11).
- Make `variant` actually filter — including Air Direct/Indirect as a priced quoting variant,
  which adds `DIRECT` and `INDIRECT` to `ChargeRateVariant` and makes air quotes per-variant like
  road and sea.
- Audit columns on the remaining 28 models, and on `FxRate` once Stage 5 merges.
- Warehousing in the charge catalogue.
- The wizard/`Point` migration, so queries select warehouses from the master.

~~Merge order against the Stage-5 branch needs agreeing before this pass starts~~ — **RESOLVED
2026-08-31: both branches are merged**, so there is no ordering left to agree. The five shared files
(`ff-portal.service.ts`, `ChargeMatrix.tsx`, `QuoteSummary.tsx`, `RfqPrintView.tsx`,
`quote-engine.ts`) now have one history. The predicted cost was 47 broken Stage-5 fixture files, 32
of them as conflicts; **the actual cost was 17 create sites across 16 files with zero conflicts**,
fixed in `c2691c9` — the estimate was pessimistic because masters' `ffFixture()` conversion had
already absorbed most of the overlap.

**Two items in this list changed status on that merge:**

- *"Audit columns … and on `FxRate` once Stage 5 merges"* — **Stage 5 has merged. This is now
  unblocked** and is the cheapest item in the pass.
- *"The wizard/`Point` migration"* — worth promoting. Until it lands the **Warehouse master has no
  consumer at all**: users maintain warehouse records that nothing in the product reads. It is the
  most visible gap of the seven to anyone actually using the app.

## 10. Open questions

- **Destination charges: always included, or executive-selected?** The seed matrix lists them
  under "Always included Charges at FF view", but every destination line in the build today is
  executive-selected. Seeded as `isAdditional`, following the build. If the sheet is right,
  thirteen lines flip.
- **Shipment type.** Destination charges are specified as conditional on Door-to-Door or
  Port-to-Door, but the system has no shipment-type field — only Incoterms.
- **Fuel, Peak Season and Heavy Weight.** Seeded as always-included Air freight lines; the
  Additional Configurable sheet lists them as executive-configurable. The catalogue screen makes
  flipping them a UI action rather than a code change.
- ~~**Production row counts**~~ — **ANSWERED before merge** and recorded under "Production data —
  checked, not assumed" in `docs/Masters - Session Handoff.md`: 23 forwarders, 1 vessel, 2 clients.
  No vessel needed a generated IMO, no client contact needed a placeholder, and no client had two
  primary contacts, so the partial unique indexes built cleanly. One forwarder takes a
  `'Not recorded'` address placeholder, and two conversions are lossy — see the post-deploy
  corrections file.

**The other three questions above are still open**, and all three change quoting behaviour, so they
should be settled before the Stage-4 pass starts rather than during it.
