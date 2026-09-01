# Master Data — Session Handoff & Progress

> Resume point for a fresh session. Records what shipped, what was decided and why, what the plan got wrong, and the exact next step. Sibling of `Stage 3 - Session Handoff.md` and `Stage 4 - Session Handoff.md`. This work is **not** a numbered stage — it is the master-data layer the client specified in the four master-table workbooks, plus a charge-line catalogue.

## Current status (2026-08-31 — MERGED)

- ✅ **Master Data Expansion — MERGED to `main` via [PR #53](https://github.com/sj132q/svyft-logistics/pull/53).** Stage 5 ([PR #52](https://github.com/sj132q/svyft-logistics/pull/52)) merged alongside it; `main` tip `d58972d`. **CI and Deploy both green on `main`** (31 Aug, two runs) — which also settles the migration-interleaving question: masters' eight migrations and Stage-5's seven applied to production without error despite Stage-5's carrying earlier timestamps.
- ✅ **The predicted merge cost was real but ~3× smaller than estimated.** Masters made `FreightForwarder.companyAddress`/`city`/`country` NOT NULL, which broke Stage-5's e2e fixtures — **17 create sites across 16 api specs**, fixed in `c2691c9` by adding the three fields. No assertion needed changing; none of those specs asserts on forwarder shape. The handoff's original estimate of 47 files counted every file *containing* `freightForwarder.create`, not the files that would actually fail. **If another long-lived branch merges `main` later, expect the same break and the same fix** — check `pnpm --filter @svyft/api typecheck` for `FreightForwarderCreateInput` before suspecting the branch's own commits.
- 🟡 **One item outstanding: the post-deploy correction.** The pre-deploy capture WAS taken, so this is mechanical — see "Production data" below.
- ✅ **Master-data consistency pass — 13 tasks complete** on branch `claude/master-data-consistency-a920af` (`.superpowers/sdd/2026-08-31-master-data-consistency/`). Every master form moved onto one shared shell with one Save; fixed silent-save and role-gating defects on the four forms that had them; rebuilt the FreightForwarder form's contacts UI to full edit/delete; gave FX rates a `/new` route on that same shell; and — the final task — restricted Charge Catalogue's `inputType` to the two values `resolveChargeConfig` actually resolves (`PLAIN`, `HEAVY_WEIGHT_CALC`) and removed `sortOrder` from the admin UI entirely (the API still accepts it; nothing sends it any more). **No migration in this pass** — but the API contract did change, see the next bullet. **The deferred Stage-4 pass (below) is still next** — none of its seven items were touched. **The post-deploy corrections (below) are still owed** and now apply through the rebuilt FF form rather than the original one.
- ⚠️ **That pass DOES change the API contract, despite an earlier line here saying "No API/schema change in this pass".** No migration and no new column — that part is true and must stay true — but `contacts` / `warehouseIds` / `vehicles` joined three create/update payloads, and **`contacts` is now required with exactly one PRIMARY on Client and Warehouse create**. The design's own §7.3 puts the cost at **22 HTTP call sites across 5 api specs**, resolved with `clientCreateBody()` / `warehouseCreateBody()` helpers. **Any other in-flight branch merging this should check `pnpm --filter @svyft/api typecheck` for `ClientCreateInput` / `WarehouseCreateInput` before suspecting its own commits** — the same shape of break as masters' `FreightForwarderCreateInput` change one bullet up.

  Two smaller corrections to that entry, made 2026-09-01: it credited the branch with "added FX-rate zoned-datetime handling" (`ZonedDateTimeField` was pre-existing — the FX form only moved onto it), and with fixes "the whole-branch review found", which was written before this branch's whole-branch review had run. That review ran on 2026-09-01; its fix wave is the last six commits on the branch — `9485eec` lint unblock, `e02a987` the `warehouseIds` data-loss gate on the Client and FF forms, `4b229a6` coverage for the state-3 residual and the cross-owner contact guard, `ebaf588` the reconcile create-ordering comment correction, `65e3b6a` real validation messages in place of the literal "Validation failed", and `919a45c` these doc corrections.

### Delivery detail (unchanged)

Branch `feat/masters`, worktree `.claude/worktrees/feat+masters`, **49 commits over `main@b875291`**, 127 files, +11,311/−603. **`pnpm run ci` GREEN — 1,498 tests** (shared 369 · web 662 · api 467) plus lint, typecheck and all three builds. Design: `docs/superpowers/specs/2026-08-25-master-data-expansion-design.md`. Plan: `docs/superpowers/plans/2026-08-25-master-data-expansion.md` (15 tasks). Post-deploy corrections owed: `docs/superpowers/specs/2026-08-26-post-deploy-corrections.md`.
- 🟢 **The governing constraint held.** **No Stage-4 or Stage-5 file was modified** across all 48 commits — verified by the final whole-branch review, not merely asserted. The only changes under protected paths are **three test-fixture literals** (`ClientPicker.test.tsx`, `VesselPicker.test.tsx`, `FfSelectionGrid.test.tsx`), each authorised individually after confirming the type error was the only one monorepo-wide and no production code under those paths was affected.
- 🔵 **Reference artifacts** (private, shareable): [Master Data Gap Matrix](https://claude.ai/code/artifact/49bbc1fe-ec04-4d89-ae26-144f0de76de4) — field-by-field workbook-vs-build comparison with all design decisions; [Master Data Handover](https://claude.ai/code/artifact/000b8158-2521-49b0-94fa-de323d16cbec) — per-master schema read from the live database, plus the Stage-4/5 fit.

## What shipped, per master

- **Client** — `streetAddress` + `city` (both NOT NULL, free text) + `postalCode`. `ClientContact`: `email`/`contactNo` become NOT NULL, gains `whatsappAvailable`/`wechatAvailable`/`botimAvailable`, a `status` lifecycle, and `pocLevel` (`PRIMARY`/`SECONDARY`/`NONE`) replacing `isPrimary`. `industry` retained despite appearing on no workbook version.
- **Freight Forwarder** — `companyAddress`/`city`/`country` become NOT NULL; `paymentTerms` becomes a ten-value `PaymentTerm` enum; `typicalLeadTime` becomes `Int`. New `FreightForwarderContact` child table, backfilled from the old embedded contact. **`pic`/`contactNumber`/`email`/`whLocation` are RETAINED and DERIVED** — see the containment section.
- **Vessel** — `imoNumber` and `shippingLine` become NOT NULL; `vesselType` drops its 7-value enum for free text. `vesselCode` (`VS-####`) retained — the vessels list renders it.
- **Warehouse** — **new master.** 32 columns + `WarehouseContact` + `WarehouseVehicle`. Ownership by at most one forwarder *or* client, enforced by the `Warehouse_single_owner` CHECK constraint. Rate card (`handlingRate`/`handlingUnit`, `storageRate`/`storageUnit`, `freeStorageDays`, `weekendWorkingFee`) plus `rateCurrency`. `totalVehicles` derived on read, never stored.
- **Charge Line Catalogue** — was read-only and hardcoded in the seed. Now admin-managed at `/masters/charge-catalogue`, gated Administrator/Manager. **70 definitions** = the 51 that existed + 19 the workbook named. Gains `category`/`variant`/`isAdditional`; **`zone`/`role` RETAINED and DERIVED**.
- **Audit** — `createdById`/`updatedById` (plain TEXT, no FK) on the ten master tables, written only through `apps/api/src/common/audit.ts`.
- **9 new enums**: `PocLevel`, `PaymentTerm`, `WarehouseType`, `CapacityUnit`, `HandlingUnit`, `StorageUnit`, `WarehouseCapability`, `ChargeCategory`, `ChargeVariant`.
- **8 migrations**, `20260826090000` … `20260826100000`, all backfill-then-constrain.

## The containment design — read this before touching anything

The whole build rests on one idea: **where a master change would alter something the quote layer reads, the old representation stays populated by derivation.**

| Stage-4 reader | Kept | Maintained by |
|---|---|---|
| `rfq.service.ts:228` snapshots `pic`, `contactNumber`, `email`, `whLocation` into the RFQ payload | all four columns | `syncPrimaryContactColumns` on every contact write; `setWarehouses` for `whLocation` |
| `resolveChargeConfig` reads `zone`/`role` at distribute, then **freezes** the result onto `ChargeLine` rows | both columns | `deriveZone(category, mode)` / `deriveRole(isAdditional, tagKey)` in `packages/shared/src/masters/charge-catalogue.ts` |

Two properties make this safe, and both are machine-checked:

1. **One derivation, two writers.** The seed and the catalogue service both call the same pure functions. `charge-derivation.spec.ts` asserts all 50 categorised legacy definitions reproduce their original `zone`/`role` — it lands green today and fails if anyone edits either function.
2. **`deriveZone` returns null for ROAD unconditionally.** Every Road definition stores `zone = null`, trucking included. A Road freight line deriving `MAIN_FREIGHT` would change what distribute freezes. This is the single most important line in the module.

**Acceptance criterion, verified:** an Air leg with nothing selected resolves to exactly the eleven definitions it did before this branch (`charge-catalogue-snapshot.e2e-spec.ts`).

## Decisions taken, and why

| # | Decision | Why |
|---|---|---|
| D1 | Warehouse types stored `OWNED`/`CONTRACTED`/`CLIENT`/`FF`, labelled neutrally in the UI | The workbook named an operating company; a rebrand would otherwise be a migration |
| D2 | Country and city are **free text on every master** | No geography source exists. Client country was NOT moved to `COUNTRY_CODES` — consistency over partial typing. FF `availableCountries` keeps its enum: different concept (service coverage, not a postal address) |
| D3 | Warehouse `type` is independent of ownership; linking happens from the Forwarder and Client forms | User's call. The warehouse form shows its owner read-only |
| D4 | Rates live on the Warehouse master; calculation happens at quotation | User: "these are master so all the calculation will be on while doing quotation" |
| D5 | Contacts share one nine-field shape across FF/Client/Warehouse; WhatsApp/WeChat/Botim as three separate booleans | Workbook v2 |
| D6 | `POC Level` replaces the primary boolean on **all three** contact tables | Workbook v3 changed Client and Warehouse only; applying it to FF too avoids a third pattern |
| D7 | Newly-mandatory fields backfill, then constrain | Standard |
| D8 | **IMO backfills with generated 7-digit numbers** | ⚠ **Taken against recommendation.** A generated value is indistinguishable from a real IMO once it reaches an RFQ. Mitigations: the `8000000` block (real IMOs in service start `9xxxxxx`) and a `RAISE NOTICE` per row. **Moot in practice — prod has 1 vessel with an IMO already** |
| D9 | **Vessel type drops its enum for free text** | ⚠ **Taken against recommendation.** Nothing constrains the field now; spellings will drift |
| D10 | Charge variant is a single stored value including `BOTH` | User: multi-select in the UI, both selected collapses to Both |
| D11 | **The tag two-gate is DEFERRED, not removed** | User asked to remove it; removing it edits `resolveChargeConfig` and the executive UI, which the constraint forbids. **DG/Fragile/Heavy/OOG/Non-stackable still require both a selection AND a matching package tag** |
| D12 | Client `industry` retained | User asked to keep it as optional free text |
| D13 | Audit columns on master tables only in this build | Prove the pattern on ten tables first |
| D14 | **No Stage-4/5 file edited** | The governing constraint |
| D15 | FF's four snapshot columns stay, derived | `rfq.service.ts` reads them |
| D16 | The catalogue gains columns **beside** the old, not instead of | `resolveChargeConfig` reads the old pair |
| D17 | **Three new always-included lines seed INACTIVE** — Air Insurance, Sea Container Transport, Sea LSS | Active, they would price on **every** future Air/Sea RFQ the moment the seed ran. Dormant, the deploy changes no pricing |
| D18 | `category`/`isAdditional` set on create, immutable after | Both derive columns that get frozen onto quotes |
| — | Existing tests **may** be edited, narrowly, where they assert a contract a decision deliberately changes | User ruling. Three conditions: the decision is named, only those assertions change, and the edit is logged |
| — | Contacts get **full edit and delete** in the UI, not just add | User ruling — added as Task 15, sequenced before the Warehouse screen so the shared component was fixed once |
| — | FX Rate master **NOT built here** | `FxRate` already exists on the Stage-5 branch with identical fields |
| — | **Deploy as-is; correct the lossy conversions in the UI** | User ruling — see `2026-08-26-post-deploy-corrections.md` |

## What the plan got wrong — ten defects found by implementers

Recorded because the pattern is instructive: the plan was reliable about *what to build* and unreliable about *what already exists*. Every one was caught by an implementer stopping rather than guessing.

1. **Task 1 redefined `contactCreateSchema`** — a name already bound by `clients.controller.ts`, `clients.service.ts` and `masters.test.ts` — with Task 4's stricter shape, one task before the migration that made it true. Task 1 became a pure move; Task 4 owns the contract change.
2. **The no-editing-existing-tests constraint was unsatisfiable** alongside D8/D9 and the mandatory-field decisions. Four assertions encoded contracts the workbook deliberately changes. Narrowed rather than dropped.
3. **`WAREHOUSE_TYPES`/`WarehouseType` collided** with an unrelated Point-level concept in `points.ts`, sharing the `@svyft/shared` barrel → renamed `WAREHOUSE_MASTER_TYPES`/`WarehouseMasterType`. The Prisma enum keeps `WarehouseType` (different namespace).
4. **`variantsForMode` collided** with an export in `quote.ts` (do-not-touch, same barrel) → `chargeVariantsForMode`.
5. **`/api/config/charge-catalogue` never existed** — the controller is `@Controller("charge-line-definitions")`. Corrected in 12 places before the screen was built against it.
6. **`.pick().partial()` does not reject unknown keys** — Zod strips by default, so a PATCH carrying `category` returned 200 with the field silently ignored. The immutability was nominal until `.strict()` was added.
7. **The seed upsert's `update: {}` must stay** — the plan changed it to a full overwrite. `deploy.yml:62` runs the reference seed on **every** production deploy, so that would have silently reverted every admin edit to the catalogue on the next deploy. The file already documented the convention two functions up.
8. **The existing `GET` could not serve the admin screen** — it filters `isActive: true` (so the screen could not show the three dormant lines it exists to activate), returns the old DTO shape, and is consumed by `rfq-workspace` under a do-not-touch path. Added `GET /admin` instead; `ChargeLineDefinitionAdminDto` had been dead code since Task 9.
9. **`ChargeLineDefinitionAdminDto.category` was typed non-null** — a full-table read can never satisfy it, because `ROAD_WH_HANDLING` has none.
10. **`deriveZone` needed the mode.** Without it a Road Freight line derives `MAIN_FREIGHT` where every Road row stores null — the exact failure the containment exists to prevent. Caught in self-review before dispatch.

## Approaches tried that did not work

- **A UUID-shape guard on the audit columns** (Task 2). Added so non-UUID test fixtures would not break `@db.Uuid` columns, it silently nulled malformed actor ids — giving an audit trail the one failure mode it must not have. **Removed**; the columns became plain TEXT via a follow-up migration.
- **`@default("Not recorded")` on FF address columns** (Task 5). Added to avoid editing 33 test files, it let the database accept an address-less forwarder and silently label it, indistinguishably from a legitimate backfill. **Rejected**; replaced with a shared `ffFixture()` test helper across 32 files / 49 call sites.
- **Bending design to satisfy a supplied test** (Task 8, twice). Blank `capacity` was mapped to `0` so a Zod abort would not skip `superRefine`, and per-field error alerts were replaced by a single summary so an unfiltered `findByRole("alert")` would resolve. Both were reversed — the tests were fixed instead. The summary had left a twenty-field form with no error attached to any field.

## Defects that survived a green suite — worth knowing the shapes

Every task passed its full suite while containing a real defect. The recurring shapes:

- **Tests that cannot fail.** `ContactList` had no test at all — its only render hit an early return. `mapUnique`'s `one_primary` branch was **genuinely dead**: Prisma reports `meta.target` as the *column* (`["clientId"]`), never the index name, so every conflict returned the wrong message, and status-only assertions could not tell. Two later conflict branches were built as query-before-write specifically to be immune to this.
- **Two writers, no reconciliation.** `pic`/`contactNumber`/`email` were writable from both the form and the contact sync, so an admin's edit was silently reverted by the next unrelated contact write. The identical shape recurred for `whLocation` in the final task, with the earlier fix sitting nine lines above it.
- **A silent Save.** Changing the charge-line Mode twice left react-hook-form validating a stale value while the select displayed another; validation failed on a path the form never rendered, so **Save did nothing at all**. The same mechanism existed on the Warehouse form's rate fields.
- **Claims contradicted by their own evidence** — eight times. A comment saying the sync kept `whLocation` aligned when it never touched that column; "verified with `git diff`" against a diff that said otherwise; a mutation-check narrative that did not follow from the change described. The *work* was sound each time; the *account of* the work was not.
- **The whole-branch review found what fifteen task reviews structurally could not:** the same defect class had been fixed on whichever screen was under review and left standing on its siblings — silent save errors on four forms, the missing route guard, the unaudited derived-column writer. Eleven fixes in one wave.

## Production data — checked, not assumed

Queried against Neon before merge (23 forwarders, 1 vessel, 2 clients):

- ✅ **No vessel needs a generated IMO** (0 missing), **no `'Unknown'` carrier** (0 missing).
- ✅ **No client contact needs a placeholder** email or phone (0 missing).
- ✅ **No client has two primary contacts** — the partial unique indexes build; the deploy will not abort.
- ⚠ **One forwarder** gets `'Not recorded'` in an address component. Self-identifying in the UI.
- 🟡 **Two lossy conversions**, decided as deploy-then-correct. **The pre-deploy capture WAS taken** (confirmed 2026-08-31), so the correction is mechanical rather than archaeological. Detail in `2026-08-26-post-deploy-corrections.md`.

**Note on the column that looks unchanged:** `FreightForwarder.paymentTerms` still exists by name, because the migration drops the *text* column and then renames `paymentTermsEnum` into its place. Seeing the column is not evidence the migration was skipped. The decisive check is the type — `information_schema.columns.udt_name` reads `PaymentTerm` if it ran, `text` if it did not.

## Deferred — the Stage-4 pass (§9 of the design doc)

**None of these are fixed.** Each requires editing a Stage-4 file.

1. Retire FF's four snapshot columns; repoint `rfq.service.ts` at the contact table and warehouse relation.
2. Retire `zone`/`role`; repoint `resolveChargeConfig`, `ChargeMatrix`, `LegSection`, `RfqPrintView` at `category`/`isAdditional`.
3. **Remove the tag two-gate (D11)** — the only item where current behaviour differs from what the user asked for.
4. Make `variant` actually filter, including **Air Direct/Indirect** as a priced quoting variant (adds `DIRECT`/`INDIRECT` to `ChargeRateVariant`).
5. Audit columns on the remaining 28 models, and on `FxRate` once Stage 5 merges.
6. Warehousing in the charge catalogue — `ROAD_WH_HANDLING` currently has a null category and is filtered out of the admin screen, so warehouse charges cannot be managed there at all.
7. The wizard/`Point` migration, so queries select warehouses from the master. **Until this lands the Warehouse master has no consumer** — users maintain warehouses that nothing reads.

**The merge-order blocker is GONE.** This pass edits `ff-portal.service.ts`, `ChargeMatrix.tsx`, `QuoteSummary.tsx`, `RfqPrintView.tsx` and `quote-engine.ts` — contested while Stage 5 was unmerged, but both branches are now on `main`, so those five files have a single owner again. That was the main reason to wait; it no longer applies.

## Merging both branches — what actually happened

Both merged on 2026-08-31. The product works, no data was corrupted, and the interleaved migration sets applied cleanly in production.

- **The fixture break was 17 create sites across 16 api specs**, not the 47 files predicted. Fixed in `c2691c9`. The over-estimate came from counting files containing `freightForwarder.create` rather than files that would fail — several already supplied the three now-required fields.
- The small append-conflicts (`app.module.ts`, `App.tsx`, `AppLayout.tsx`, `packages/shared/src/index.ts`) and `prisma/schema.prisma` resolved as expected; the Stage-5 session's hunk-range analysis was correct.
- 🔴 **Still true and worth remembering: `deploy.yml` does not wait for `ci.yml`** (its only `needs:` is its own build job). A red suite on `main` does not block a production deploy. This did not bite here — both runs were green — but it means CI is not a gate.

## Open questions from the workbook

- **Destination charges: always-included, or executive-selected?** The seed matrix titles them "Always included Charges at FF view", but every destination line in the build is executive-selected. Seeded as `isAdditional`, following the build. **If the sheet is right, thirteen lines flip.**
- **Shipment type does not exist.** Destination charges are specified as conditional on Door-to-Door or Port-to-Door; the system has only Incoterms.
- **FSC / Peak Season / Heavy Weight** are seeded as always-included Air main-freight lines; the Additional Configurable sheet lists them as executive-configurable. The catalogue screen now makes flipping them a UI action rather than a code change.

## Known traps for the next session

- **Three partial unique indexes and one CHECK constraint exist only in raw SQL** (`ClientContact_one_primary`, `FreightForwarderContact_one_primary`, `WarehouseContact_one_primary`, `Warehouse_single_owner`). Prisma cannot express a `WHERE`-clause index, so the next **`prisma migrate dev` will propose DROPPING them** — taking out the invariant three services' 409 mapping depends on. A warning block sits at the top of `schema.prisma`.
- **`prisma migrate dev` does not work in this repo** — it hard-errors non-interactively. Migrations are hand-written and applied with `migrate deploy`. **Never edit an applied migration.**
- **Do not run `prisma format`** — it reformats all 985 lines.
- **BSD `sed` on macOS ignores `\b`.** A rename using it silently under-applied (2 of 8 references) and looked successful. Use python or perl for boundary-aware replaces.
- **The worktree's shell cwd drifts** to the main checkout, which sits on `feat/stage-5-fx-master`. Run `git branch --show-current` before every commit — this session nearly committed masters work onto Stage 5.
- **This worktree uses its own database**, `svyft_masters` on port 5433, so it cannot collide with the Stage-5 session's e2e runs. `apps/api/.env` is gitignored and does not travel with a new worktree.

## Deferred minors (non-blocking, from the final review)

- `lib/api.ts` `raise()`: an empty-string `body.message` yields an empty `ApiError.message`, so the new alerts render nothing. Fix at the boundary, not in five components.
- List-page row links stay ungated, so an Executive clicking a row silently bounces to `/queries`. Render the name as plain text when the user cannot write.
- `App.test.tsx`'s Executive cases lean on RTL v16 `asyncWrapper` timing; `findByText` on the redirect target is sturdier.
- `charge-catalogue-invariant.e2e-spec.ts` should carry a comment saying it is a **drift detector**, not the acceptance criterion — that now lives in `charge-derivation.spec.ts`.
- 50 legacy seed entries still carry `role`/`zone` literals the derivation now overrides. Documented in place; the new unit test turns them into the oracle rather than a trap.
- Browsing the unassigned-warehouse pool caps at 100 without pagination; search reaches past it.

## Deferred minors — status after the consistency pass (2026-09-01)

Two entries in the list above were **resolved** by the master-data consistency branch:

- ~~`lib/api.ts` `raise()`: an empty-string `body.message` yields an empty `ApiError.message`~~ —
  **fixed** (Task 1). `raise()` now trims and falls back to a status string, and additionally
  prefers the first Zod issue's message over the pipe's literal `"Validation failed"`.
- ~~Browsing the unassigned-warehouse pool caps at 100 without pagination~~ — still true, but the
  picker now also distinguishes a **failed** pool fetch from an empty one, which it previously
  rendered identically.

The rest of that list stands.

## Follow-up work owed by the master-data consistency pass

Recorded here because the branch's working ledger is gitignored scratch. None of these block the
merge; each was reviewed and deliberately deferred.

1. **`AuthProvider`-race test convention (own PR).** `ClientsListPage.test.tsx`,
   `VesselsListPage.test.tsx`, `WarehousesListPage.test.tsx` and
   `FreightForwardersListPage.test.tsx` each await a list row and then assert role-gated UI is
   absent. `AuthProvider` renders children immediately with `user = null` and `useCanWrite()`
   defaults false, so these can pass off the default unauthenticated state without the role ever
   being evaluated. Roughly 17 files share the shape. **`FxRatesPage.test.tsx`'s `AuthSettled`
   probe is the pattern to propagate.** This is the same class that failed CI on PR #54.
2. ~~**`raise()`'s issue-first message is app-wide.**~~ — **RESOLVED before merge (user's
   call).** The issue preference briefly lived in `raise()`, which changed every non-masters
   `ZodValidationPipe` 400 across the query wizard, RFQ workspace and Compare. It was scoped
   back: `raise()` again surfaces the body's own `message` for every caller (keeping only the
   separate blank-message trim guard), and the masters read `issues` off the thrown `ApiError`
   themselves via `features/masters/form/masterErrorMessage.ts`. Those screens are byte-for-byte
   unchanged from before this branch. **If you ever want readable validation errors elsewhere,
   call `masterErrorMessage` from that screen — do not move the preference back into `raise()`.**
3. **`usePackages.ts:50-55` (MSDS upload) bypasses `raise()`**, hand-building its own `ApiError`
   from `b?.message`, so that path shows `"Validation failed"`. Pre-existing divergence, and
   unchanged by the scoping above.
4. **The owner-warehouses Save gate can fire on a healthy draft.** TanStack Query sets
   `status: "error"` on a *background refetch* failure while retaining `data`, so a post-load
   refetch failure blocks Save with "Could not load…". Fail-closed, not data loss, but a user can
   be told to retry when nothing is wrong.
5. **Neither owner form gates on `existing.isSuccess`.** If the parent `GET /:id` fails while the
   child queries succeed, `reset()` never runs and Save is stopped only incidentally by
   required-scalar validation. Pre-existing; not reachable as data loss today.
6. **`warehouseVehicleSchema.tonnage` is `z.string()` against a `TruckTonnage` enum column**, so
   the API accepts any string and fails at Prisma — a 500 where a 400 belongs. **No longer
   user-reachable**: the vehicle dialog's control is now a select over `TRUCK_TONNAGES`. Belongs
   to the Stage-4 pass, where `TruckTonnage` is already in scope.
7. **`WarehouseContact.isWeekendIncharge` is unmodelled in `contactCoreSchema`**, so nothing can
   set it. Left alone deliberately: a warehouse-only tenth field would break the shared
   nine-field contact shape that makes `reconcileContacts` owner-agnostic across three services.
8. **`queryClient` is constructed bare** (`api.ts`), so `refetchOnWindowFocus` is on with
   `staleTime: 0`, and each form's `reset()` replaces the whole draft. A background refetch
   mid-edit therefore wipes unsaved contacts, vehicles and typed fields. Pre-existing in shape,
   materially worse now that one long form holds all children behind one Save. Guarding the
   reset on `formState.isDirty` is the usual fix.

Also unbuilt, and recorded as a dropped requirement rather than an omission: design §5.3's
"the same state renders as a marker in the list row" for records with no primary contact. No list
page was touched; the advisory banner on the form carries the signal instead.

## The exact next step

**Both branches are merged and deployed. Two things remain.**

1. **Apply the post-deploy correction** (small, and you have what it needs). From the pre-deploy capture: the two forwarders whose terms read `50% ADVANCE / 50% ON DELIVERY` and `50% ADVANCE / 50% ON BL` now show **100% Advance** and should be *50% Advance : 50% After Delivery*. All 23 lead times sit on the low end of their original ranges (`18-24d` → 18); reset to the upper bound if these are ever treated as real, since understating a lead time is the direction that causes missed commitments. Both correctable through the admin screens.

2. **Spec the Stage-4 pass** — seven items above, none started, and now unblocked. This has **not** been specced; it is the next session's first task.

**How to approach the Stage-4 pass.** Settle the three open workbook questions *first*, because two of them change quoting behaviour and would otherwise get decided mid-build: whether destination charges are always-included (thirteen lines flip if the sheet is right), what the shipment-type field should be, and whether FSC/Peak/Heavy stay always-included. Then sequence the seven items — the two "retire the old representation" items are the largest and share a shape (repoint readers, prove equivalence, drop columns), and the wizard/`Point` migration is the one users will actually notice, since **until it lands the Warehouse master has no consumer**.

Also worth checking early, cheaply: confirm production's `_prisma_migrations` lists all fifteen migrations (masters' eight plus Stage-5's seven) as applied. The green deploy strongly implies it, but interleaved ordering is exactly the case where "it ran" and "it ran completely" can differ.
