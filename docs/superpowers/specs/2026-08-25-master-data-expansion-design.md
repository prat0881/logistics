# Master Data Expansion — Design

**Date:** 2026-08-25
**Branch:** `worktree-feat+masters`, cut from `main` @ `b875291`
**Source:** `Master Tables — Freight Forwarder / Client / Vessel / Warehouse (3).xlsx`
**Gap matrix:** https://claude.ai/code/artifact/49bbc1fe-ec04-4d89-ae26-144f0de76de4

## 1. Purpose

Bring the master-data layer up to the specification in the master-tables workbook: extend the
three existing masters (Client, Freight Forwarder, Vessel), add a Warehouse master, add an
admin-managed Charge Line Catalogue, and put actor-level audit columns on every master table.

## 2. Scope

**In:**

1. Client master — address fields, contact channels, contact lifecycle.
2. Freight Forwarder master — mandatory address, enumerated payment terms, numeric lead time,
   a contacts child table (replacing three embedded columns), and a link to warehouses.
3. Vessel master — mandatory IMO and shipping line, vessel type relaxed to free text.
4. Warehouse master — new entity, with contacts, a vehicle breakdown, a rate card, and
   ownership links to a forwarder or a client.
5. Charge Line Catalogue — admin CRUD over `ChargeLineDefinition`, seeded with the 19 lines the
   workbook names that have no definition today.
6. Audit columns (`createdById`, `updatedById`) on the master tables.

**Out, and why:**

- **FX Rate master.** Already built on the Stage-5 branch as `FxRate`, with fields identical to
  the workbook's (`currency`, `unitsPerUsd`, `effectiveFrom`, `note`). Building a second one
  guarantees a schema conflict. Follow-up: add audit columns to it once Stage 5 merges.
- **Warehouse charge lines in the catalogue.** Deferred by decision — the category list is
  Road/Air/Sea only. Warehouse charges remain defined by the Warehouse Charges sheet and priced
  from the Warehouse master's rate card.
- **Air Direct/Indirect as a priced quoting variant.** Specified separately (§9) — it is a
  quote-engine change, not master data.
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
| D9 | Vessel type drops its enum for free text | Taken against recommendation: nothing constrains the field afterwards, so spellings will drift |
| D10 | Charge variant is a single stored value including `BOTH` | Multi-select in the UI; both selected collapses to `BOTH` |
| D11 | The tag two-gate is removed | Taken against recommendation: DG, Fragile, Heavy, OOG and Non-stackable become ordinary selectable charges, so DG handling can be quoted on non-DG cargo |
| D12 | Client `industry` is retained | Optional free text, though it appears on no version of the workbook |
| D13 | Audit columns cover master tables only in this build | The remaining 28 models follow later |

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

New `FreightForwarderContact` with the same shape as `ClientContact`. The existing `pic`,
`contactNumber` and `email` columns are migrated into a first contact row per forwarder and then
dropped.

`whLocation` (free text) is retired in favour of the warehouse relation in §4.5.

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

`ChargeLineDefinition` gains `variant` and `isAdditional`; `zone` is renamed and widened to
`category`; `role` collapses.

| Field | Source | Notes |
|---|---|---|
| `mode` | workbook | Unchanged |
| `variant` | workbook | `DEDICATED` / `GROUPAGE` / `DIRECT` / `INDIRECT` / `FCL` / `LCL` / `BOTH`, validated against `mode` |
| `category` | workbook | `ORIGIN` / `FREIGHT` / `DESTINATION` / `ADDITIONAL`. Road allows only `FREIGHT` and `ADDITIONAL` |
| `label` | workbook | Unchanged |
| `isAdditional` | workbook | Executive-configurable when true; always included when false |
| `inputType` | existing | Drives the forwarder's input widget — trucking, warehouse staging, heavy-weight calculator |
| `isActive` | existing | The only safe retirement, since deletion of a used line is refused by the database |
| `key` | existing | Generated, immutable — quote rows reference definitions by key |
| `sortOrder` | existing | Defaults to the current maximum plus ten within its mode and category |

`tagKey` is removed (D11), along with the `TAG_DRIVEN` branch of `resolveChargeConfig`, its
tests, and the tag column in the executive's selection UI. The fifteen tag-driven definitions
become `isAdditional` lines in the `ADDITIONAL` category.

`ROAD_WH_HANDLING` has no valid category under this model. It stays in the table, untouched and
referenced by existing quotes, and is filtered out of the Charge Master screen until warehousing
is decided.

**Seed — 70 lines** (51 existing, 19 new); 69 appear on the screen, since `ROAD_WH_HANDLING` is filtered out. The new ones:

- Air: Insurance (Origin), Magnetic Fee, Europe T1 Document, EDD Security Check, Custom
  Documents T1 (Destination), File Opening Charges (Destination).
- Sea: Container Transport / Loading and LSS (Origin); CFS, DO Release, Container Cleaning,
  Devanning, Wharfage, BAF, CAF, DDF, Gas Measuring, Emergency Surcharge (Destination).
- Road: Bonded Licence Fee.

Container Cleaning and Devanning seed as `FCL`; everything else as `BOTH`. New Origin lines are
always-included; new Destination lines are `isAdditional`, following the convention already in
the seed rather than the workbook's "always included" header, which contradicts how destination
charges are currently built.

## 5. Code layout

`packages/shared/src/masters.ts` is 134 lines and this roughly triples it, so it becomes a
`masters/` directory — `client.ts`, `freight-forwarder.ts`, `vessel.ts`, `warehouse.ts`,
`contacts.ts`, `charge-catalogue.ts`, `index.ts` — re-exported so no import site changes.

New `apps/api/src/modules/warehouses/` mirroring the clients module. Charge-catalogue writes
extend the existing config module, whose controller exposes only a `GET` today. Web gains
`features/masters/warehouses/` and a catalogue screen, following the existing list/form pair.

All writes are gated `@Roles(ADMINISTRATOR, MANAGER)`, matching every existing master.

## 6. Migrations

Ordered, one per concern:

1. Additive — new tables, new enums, new nullable columns, audit columns.
2. Backfill — FF contacts from `pic` / `contactNumber` / `email`; addresses from existing values
   with a placeholder only where genuinely empty; IMO numbers generated for vessels lacking one,
   with the affected vessel ids logged.
3. Constrain — `NOT NULL` on the newly-mandatory columns; partial unique indexes for one primary
   contact per parent, which Prisma cannot express and so are raw SQL.
4. Drop — the three FF contact columns and `whLocation`, only after the backfill is verified.

Production row counts for `Vessel`, `FreightForwarder` and `Client` are needed before step 2;
they are not reachable from the development environment.

## 7. Testing

Repo conventions: Zod and resolver unit tests in `packages/shared`, an e2e suite per API module,
React Testing Library tests per page. `tsc` runs per task rather than relying on vitest, which
does not type-check.

Specific coverage: the conditional warehouse validation by type; the one-primary-per-parent
constraint; the FF contact backfill; the variant/mode validation on charge lines; and the
refusal path when deleting a charge line that a quote references.

## 8. Sequencing

1. Vessel and Client — smallest, and they prove the contact pattern.
2. Freight Forwarder — the contact migration.
3. Warehouse — the largest, but depends on nothing.
4. Charge Line Catalogue, including removal of the two-gate.
5. FF and Client warehouse linking — last, since it needs both sides to exist.

## 9. Follow-ups, specced separately

- **Air Direct/Indirect as a priced quoting variant.** Adds `DIRECT` and `INDIRECT` to
  `ChargeRateVariant` and makes air quotes per-variant like road and sea. Touches
  `ff-portal.service.ts`, `ChargeMatrix.tsx`, `QuoteSummary.tsx`, `RfqPrintView.tsx` and
  `quote-engine.ts` — the same files the Stage-5 branch is working through, so merge order needs
  agreeing before either starts.
- **Audit columns on the remaining 28 models.**
- **Audit columns on `FxRate`**, once Stage 5 merges.
- **Warehousing in the charge catalogue.**
- **The wizard/`Point` migration**, so queries select warehouses from the master.

## 10. Open questions

- **Shipment type.** Destination charges are specified as conditional on Door-to-Door or
  Port-to-Door, but the system has no shipment-type field — only Incoterms. Belongs to the
  quoting spec.
- **Fuel, Peak Season and Heavy Weight.** Seeded as always-included Air freight lines; the
  Additional Configurable sheet lists them as executive-configurable. The seed keeps them
  always-included, and the catalogue screen makes flipping them a UI action rather than a code
  change.
