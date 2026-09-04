# Stage-4 Pass — Design

Retiring the masters build's transitional representations and wiring the Warehouse master to a
consumer. Seven items, deferred from the master-data expansion (`§9` of
`docs/superpowers/specs/2026-08-25-master-data-expansion-design.md`) because each edits a Stage-4
file, plus one item raised on 2026-09-04.

**Status: design only. Nothing here is built.** The prerequisite in §3.4 is unresolved and blocks
item 2.

---

## 1. The governing rule

The business rule for the **Configure Charges** screen, given 2026-09-04, is the spine of this
pass. Restated against the two columns that already exist:

> 1. Based on the mode (Air, Sea, Road), **Origin, Freight and Destination charges are available by
>    default, shown as selected and non-editable.**
> 2. **Additional charges are chosen by the Executive.** When one is selected, it renders **under
>    its own category** in the FF view.
> 3. An additional charge with **no category** renders under **"Additional"**, for the Executive to
>    pick if the FF view needs it.

This maps cleanly onto `ChargeLineDefinition`'s existing pair, and that is the whole reason the
pass is tractable:

| Column | Decides | Values |
|---|---|---|
| `category` | **Where** a line renders, in both Configure Charges and the FF view | `ORIGIN` · `FREIGHT` · `DESTINATION` · `ADDITIONAL` · `null` |
| `isAdditional` | **How** it is selected | `false` → automatic and locked · `true` → Executive chooses |

The two axes are independent. A line may be `category: DESTINATION, isAdditional: true` — Executive
chooses it, and when chosen it appears under Destination, exactly as rule 2 says. Rule 3 is the
`category: null` (or `ADDITIONAL`) case.

**This is a regrouping, not a new model.** No column is added.

---

## 2. Where the code is today

`resolveChargeConfig` (`packages/shared/src/charge-config.ts:70`) still branches on the **legacy**
`role`, and `ConfigureChargesPopover.tsx:123-125` groups the screen by the same three values:

```
role: CORE        → always included
role: STANDARD    → included when the Executive selected it
role: TAG_DRIVEN  → included when selected AND a package carries the matching tag   ← the D11 two-gate
```

The equivalence to the new pair is exact and already encoded in
`packages/shared/src/masters/charge-catalogue.ts` (`deriveRole`, `deriveZone`), whose output is
pinned by `charge-derivation.spec.ts`:

| Legacy | New pair |
|---|---|
| `CORE` | `isAdditional: false` |
| `STANDARD` | `isAdditional: true`, `tagKey: null` |
| `TAG_DRIVEN` | `isAdditional: true`, `tagKey != null` |
| `zone` | `category` |

So item 2 is largely mechanical — **except that the data does not yet satisfy rule 1.**

---

## 3. What the rule produces against today's catalogue

Measured against the seeded catalogue (70 definitions), not estimated.

### 3.1 Lines rule 1 would auto-select, by mode and category

Counting **active**, `isAdditional: false` definitions:

| Mode | Origin | Freight | Destination |
|---|---|---|---|
| AIR | 5 | 6 | **0** |
| SEA | 5 | **0** ¹ | **0** |
| ROAD | 0 | 1 | **0** |

¹ Correct by design, not a defect. `SEA_MAIN_FREIGHT` is deliberately `isActive: false`: sea
freight is priced by the structured `seaRates[]` dual-rate, and leaving the flat line active would
double-count it through `computeQuoteTotals` (see the comment at `reference-seed.ts:356`). The Sea
Freight group must render the sea-rate structure, **not** a charge line — see §3.3.

### 3.2 The gap: no destination charge is ever automatic

All **26 active `DESTINATION` definitions carry `isAdditional: true`**, so under rule 1 the
Destination group renders empty for every mode. This is the one substantive data change the pass
requires.

The 26 split cleanly in two:

- **10 cargo-tag lines** — `AIR_TAG_*` / `SEA_TAG_*` (DG, Fragile, Heavy, Non-stackable, OOG).
  Inherently conditional on what the cargo is. **These must stay Executive-chosen** regardless of
  the rule; they are also the subject of item 3.
- **16 genuine destination charges** — 5 Air, 11 Sea. These are the candidates to flip.

### 3.3 Consequences for the Configure Charges screen

- Groups are keyed by `category`, not `role`.
- A group with no auto-selected lines must not render as an empty box. Sea Freight is the
  permanent case (§3.1 ¹); Road Origin and Road Destination are others.
- Locked rows need a visible reason ("included on every Air shipment"), or they read as a bug.

### 3.4 ⛔ Required input before item 2 can be built

**Which of these 16 are always-included?** The workbook's seed matrix titles them "Always included
Charges at FF view", which implies all of them; the build made all of them Executive-chosen. Only
the business can settle it, and `isAdditional` is **immutable after create** (D18), so this is a
data migration, not an admin-screen toggle.

| Mode | Variant | Key | Label |
|---|---|---|---|
| AIR | BOTH | `AIR_DEST_CUSTOM_DOCS_T1` | Custom Documents (T1) |
| AIR | BOTH | `AIR_DEST_FILE_OPENING` | File Opening Charges |
| AIR | BOTH | `AIR_DEST_IMPORT_CLEARANCE` | Import Customs Clearance |
| AIR | BOTH | `AIR_DEST_STORAGE` | Storage 1 Free Day Charges |
| AIR | BOTH | `AIR_DEST_THC` | Destination THC / Airport Handling |
| SEA | BOTH | `SEA_DEST_BAF` | BAF (Bunker Adjustment Factor) |
| SEA | BOTH | `SEA_DEST_CAF` | CAF (Currency Adjustment Factor) |
| SEA | BOTH | `SEA_DEST_CFS` | CFS Charges |
| SEA | BOTH | `SEA_DEST_DDF` | DDF (Document Fee / Admin / Cargo Release) |
| SEA | BOTH | `SEA_DEST_DO_RELEASE` | DO Release |
| SEA | BOTH | `SEA_DEST_IMPORT_CLEARANCE` | Import Customs Clearance |
| SEA | BOTH | `SEA_DEST_STORAGE` | Storage 1 Free Day Charges |
| SEA | BOTH | `SEA_DEST_THC` | Destination THC / Handling Charges |
| SEA | BOTH | `SEA_DEST_WHARFAGE` | Wharfage Charges |
| SEA | **FCL** | `SEA_DEST_CONTAINER_CLEANING` | Container Cleaning |
| SEA | **FCL** | `SEA_DEST_DEVANNING` | Devanning Charges |

**Recommendation: flip all 16, but land item 4 first.** Three of them are variant-conditional, and
making them automatic while `variant` is still ignored (item 4) would price them onto quotes they
do not belong to:

- `SEA_DEST_CONTAINER_CLEANING`, `SEA_DEST_DEVANNING` — marked `FCL`.
- `SEA_DEST_CFS` — marked `BOTH`, but CFS is an LCL concept. **Likely a data error; worth
  confirming before it becomes automatic.**

Two others are arguably conditional on events rather than on the shipment: `AIR_DEST_STORAGE` and
`SEA_DEST_STORAGE` ("Storage 1 Free Day Charges") only apply if storage is actually consumed.
Flagged, not decided.

---

## 4. The items

### Item 1 — Retire the Freight Forwarder's four snapshot columns

`pic`, `contactNumber`, `email`, `whLocation` are maintained by derivation purely so
`rfq.service.ts:308` can snapshot them. Repoint that read at the `FreightForwarderContact` table
and the `Warehouse` relation, then drop `syncPrimaryContactColumns`, `setWarehousesTx`'s
`whLocation` dual-write, and the columns.

Order matters: repoint the reader, prove equivalence on existing RFQs, *then* drop. Note that
`whLocation` already left both FF schemas on 2026-09-04 — it is derived-only today, which makes it
the easiest of the four to retire.

**Do not drop the frozen values on existing `Rfq` rows.** Those are historical snapshots and must
keep reading as they were sent.

### Item 2 — Retire `zone` / `role`; repoint at `category` / `isAdditional`

The rule in §1, implemented. Touches `resolveChargeConfig`, `ConfigureChargesPopover`,
`ChargeMatrix`, `LegSection`, `RfqPrintView`. **Blocked on §3.4.**

`resolveChargeConfig` freezes its result onto `ChargeLine` rows at distribute, so existing quotes
are unaffected by definition — but the equivalence must be proved, not assumed.
`charge-catalogue-snapshot.e2e-spec.ts` (an Air leg with nothing selected resolves to exactly
eleven definitions) is the existing acceptance criterion; extend it to Sea and Road before
changing the resolver, so the before/after comparison has a baseline.

### Item 3 — Remove the tag two-gate (D11)

Today a DG/Fragile/Heavy/OOG/Non-stackable line requires **both** an Executive selection **and** a
matching package tag. The user asked for this to be removed during the masters build; it was
deferred because it edits `resolveChargeConfig`. **This is the only item where current behaviour
knowingly differs from what was asked for.**

After removal these become ordinary Executive-chosen lines — which is consistent with §3.2's
decision to leave the 10 tag lines Executive-chosen.

### Item 4 — Make `variant` actually filter

`variant` is stored and ignored. Make it filter, and add `DIRECT` / `INDIRECT` to
`ChargeRateVariant` (today `DEDICATED · GROUPAGE · FCL · LCL`) so Air Direct/Indirect becomes a
priced quoting variant.

**Sequence this before item 2's data flip** — see §3.4.

### Item 5 — Audit columns on the remaining models

Three corrections to the handoff's version of this item, all verified against
`prisma/schema.prisma`:

- It is **37 models remaining, not 28**. 9 of 46 carry `createdById`/`updatedById` today.
- **`FxRate` already has them** — it does not need adding "once Stage 5 merges"; Stage 5 shipped
  them.
- The nine are `Client`, `ClientContact`, `FreightForwarder`, `FreightForwarderContact`, `Vessel`,
  `Warehouse`, `WarehouseContact`, `ChargeLineDefinition`, `FxRate`. **`WarehouseVehicle` is
  missing** despite being a master child alongside `WarehouseContact` — the cheapest place to start.

Write only through `apps/api/src/common/audit.ts`. Columns are plain `TEXT`, never `@db.Uuid` — a
UUID-shape guard was tried during the masters build and silently nulled malformed actor ids, giving
an audit trail the one failure mode it must not have.

### Item 6 — Warehousing in the charge catalogue

`ROAD_WH_HANDLING` has a `null` category, so it is filtered out of the admin screen and warehouse
charges cannot be managed there at all. Give it a category. If that category is `ADDITIONAL`, rule
3 already describes how it renders; if warehousing deserves its own group, `ChargeCategory` gains a
value and §1's table grows a row.

Interacts with item 7: warehouse charges are more useful once queries select warehouses from the
master.

### Item 7 — Wizard / `Point` migration

Let queries select warehouses from the Warehouse master instead of free-text `Point` rows.

**Until this lands the Warehouse master has no consumer** — users maintain warehouses nothing
reads. It is the item users will actually notice, and the only one that makes the masters build
visible in the core workflow. It is also the largest.

`WarehouseStagingLine.warehousePointId` references `Point`, not `Warehouse`; that indirection is
the migration.

### Item 8 (new, 2026-09-04) — Server-side warehouse-type guard

The Warehouses picker on the Client and Freight Forwarder forms now filters its pool by type
(`FF` / `CLIENT`), but `setWarehousesTx` still accepts any warehouse id regardless of type, so the
mismatch the 2026-09-04 cleanup removed can be recreated through the API.

Deliberately excluded from that fix batch: the guard rejects payloads the API accepts today and
breaks existing e2e fixtures, which assign default-typed warehouses. It belongs here, where
warehouse ownership is already in scope.

---

## 5. Decisions taken

| # | Decision | Why |
|---|---|---|
| S1 | `category` decides placement, `isAdditional` decides selection | The user's rule, and it needs no new column |
| S2 | The 10 `*_TAG_*` destination lines stay Executive-chosen | Conditional on cargo, not on the lane |
| S3 | **Shipment type (Door-to-Door / Port-to-Door) is out of this pass** | User's call. The workbook scopes destination charges by it, but the system has only Incoterms and no field exists. Recorded as still-open, below |
| S4 | Item 4 sequences before item 2's data flip | Making variant-conditional lines automatic while `variant` is ignored would price them onto the wrong quotes |
| S5 | Sea Freight renders the `seaRates[]` structure, not a charge line | `SEA_MAIN_FREIGHT` is intentionally inactive to avoid double-counting |
| S6 | Frozen values on existing `Rfq` / `ChargeLine` rows are never rewritten | They are historical records |

---

## 6. Sequencing

```
  Item 4 (variant filters)  ──┐
  §3.4 business input       ──┴──▶  Item 2 (retire zone/role) ──▶  Item 3 (tag two-gate)
  Item 1 (FF snapshots)     ── independent
  Item 5 (audit columns)    ── independent, start with WarehouseVehicle
  Item 8 (type guard)       ── independent, small
  Item 6 (warehousing)      ──▶  Item 7 (wizard/Point)   ── largest, most visible
```

Items 1, 5 and 8 are independent and can start immediately. Item 2 cannot start until §3.4 is
answered.

---

## 7. Still open

- **§3.4 — which of the 16 destination lines are always-included.** Blocks item 2.
- **`SEA_DEST_CFS` is marked `BOTH`** but CFS is an LCL concept. Probable data error; confirm
  before item 4 makes variant meaningful.
- **Shipment type does not exist** (S3). Deferred, not resolved. If destination charges later need
  Door-to-Door / Port-to-Door scoping, that field is the prerequisite.
- **Storage lines** (`AIR_DEST_STORAGE`, `SEA_DEST_STORAGE`) are event-conditional; whether
  "always included" is right for them is unconfirmed.
- **`deploy.yml` does not wait for `ci.yml`.** A red suite on `main` does not block a production
  deploy. Unchanged by this pass, and worth fixing independently — this pass changes pricing
  behaviour, which is the worst thing to deploy unverified.
