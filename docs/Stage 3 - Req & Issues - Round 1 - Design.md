# Stage 3 — Req & Issues — Round 1 — Design

> Consolidated design for the business/testing-team "Req & Issues" round: **3 larger issues**
> + **~25 common/screen-level items**, plus a **record of what already shipped** on
> `feat/plan-6-wizard-ui-bugs` (fix rounds 1–2). This is a *design* doc — it sits next to
> `Stage 3 - Functional Spec.md` and `Stage 3 - Technical Design.md`. (`docs/plans/` stays for
> implementation plans; we're building this TDD-direct, so no plan doc unless a chunk goes
> subagent-driven.)

## Approach & sequencing
- **Design here first → build TDD-direct**, decomposed into shippable increments, each its own branch/PR, each `pnpm run ci` green. Suggested order:
  1. **Common rules + small per-screen fixes** (pagination, "All"-filters, renames, phone E.164, defaults, popups, remove Save/Next gating)
  2. **Validation Summary** (Create = the single gate) + the Notes/Checklist mandatory gate
  3. **Route Canvas** (Step 4)
  4. **Timezone + migration** — **its own branch** (carries a Prisma migration)
- Big chunks (canvas, timezone) → subagent-driven + opus whole-branch review; small fixes → TDD-direct.
- **First close out** the current `feat/plan-6-wizard-ui-bugs` (rounds 1–2, prod-tested) before layering this round on fresh branches.

---

## The 3 issues (approved)

### Issue 1 — Route Canvas (Step 4)
The route diagram **is** the Step-4 surface; the Point/Leg **list items are removed**.
- Layout: notices/summary strip → thin toolbar (`+ Add point` · `+ Add leg`) → the canvas.
- Render **every point as a box and every leg as a line**, incl. **standalone points before any leg exists** (fix the current "hide boxes until ≥1 leg" rule).
- **Click a point box → Point editor (edit); click a leg line → Leg editor (edit).** Reuses the existing edit-mode dialogs.
- **Add** via the toolbar (mint first on a brand-new query). **Delete** via a button inside the editor dialog.
- **Hover** a box/line → tooltip with details **+ full street address** (points) **+ any validation issues** (red). Preserves the at-a-glance address the U6 list gave.
- Per-leg **rollup** (pkg/CBM/kg) moves into the leg hover tooltip.
- Keep: notices strip, editors, mint flow, keyboard-focus + aria-labels.

### Issue 2 — Validation Summary (Create = the single gate)
Execs travel freely and save partial info anywhere; **Create Query is the only hard gate**.
- **On Create**, run the full validation (`collectCreateFindings` + `validateRoute("create")` + the Notes/Checklist gate). If anything fails, show a **validation summary grouped by tab**, each line **clickable → jump to that tab**, plus a **red dot + count badge on each stepper tab**. Status stays DRAFT until clean, then → RFQ_READY.
- **Finding → tab bucket** (the only mapping — ~4 buckets): query mandatory → Client & Query (incoterms → its tab), cargo (F6) → Cargo, leg/point/route → Leg & Route, checklist/notes → Notes & Checklist.
- **No per-field red persistence across navigation, no Finding→Field table.** While editing, each field shows its **own inline** business/format message (no block); **mandatory-empty shows no inline message** (surfaces only in the summary — Common #6).

### Issue 3 — Timezone (location-anchored + explicit zone label)
The airline-itinerary model.
- **Operational** times anchor to a **location's IANA timezone**, auto-derived from the point's country/city, and are always shown **local-to-location with the zone label** (e.g. "09:00 SGT") for every viewer. **System/audit** times (Query Date, created/updated) show in the **viewer's** local zone with a label.
- Anchoring: leg Ready → origin zone; leg Target → destination zone; ETA/ETB/ETD → port-of-call zone; Response Deadline → org zone; query Ready/Target → query-default zone until points exist.
- **Store true UTC + the zone id** (new `Point.timezone`); replace the floating-wall-clock helpers with zone-aware conversion (`date-fns-tz`). Temporal rules (T1/T2/T3) + Ready ≤ Target compare **real UTC instants**.
- **Migration** stamps existing rows with the org default zone.
- Its own increment (open sub-decisions below).

---

## Common Design Rules

| # | Rule | Resolution |
|---|---|---|
| 1 | No scroll-bar on any page | **No scroll at standard desktop sizes**; sectioned, compact layout. Tables paginate (not "zero scroll on all devices"). |
| 2 | Tables paginate | Default **10 rows/page** with a page-size control. Applies to Query List + Masters lists. |
| 3 | Less white space / better look-n-feel | Compact, sectioned layouts across screens. |
| 4 | All validation on Create Query | Mandatory + business rules validated at **Create only** (→ the Validation Summary, Issue 2). |
| 5 | Remove validation on Save & Next | **Save/Next never block.** Removes the round-2 Next-gate + Step-4 gate + point/leg mandatory-on-save. Format/business errors still show **inline (no block)**. |
| 6 | Drop "must contain ≥1 character" mandatory messages | Mandatory-empty → **no inline message** (red flag only, surfaced in the summary). **Business** messages stay inline. |
| 7 | Phone E.164 everywhere | **Strict E.164** (require leading `+`) on **every phone incl. `ClientContact.contactNo` (Masters)**. (This is the deferred D1 — now in scope.) Fax is not a phone — unchanged. |
| 8 | Pop-ups have Save & Cancel | Standardize all dialogs (Point/Leg/Cargo editors) to **Save** + **Cancel**. |
| 9 | Show default value if unsaved | Fields render their business default when present. |
| 10 | Dropdowns default to "Select" | Dropdowns show **"Select"** unless a business default exists (then show it) — reconciles #9/#10. |

---

## Screen-by-screen

### Query List (`/queries`)
- **Fix "All" filters** (All Status / Priorities / Modes / Assignees) — the sentinel currently doesn't clear the filter; it must show all rows for that facet.
- **Date-range popup**: let the user pick **Start and End clearly before it closes** (and `from ≤ to`, already guarded).
- **Pagination @10** (Common #2). **Date columns show zone labels** (Issue 3; system times viewer-local).

### Client & Query (Step 1)
- **Response Deadline default by Priority** = Query Date/Time + **Low 48h · Medium 24h · High 18h · Urgent 12h**. Recompute on Priority change **until the exec edits it** ("default-until-touched").
- **Response Deadline ≥ Query Date** (incl. time), compared on the **real instant** (Issue 3).
- **Sectioned layout, no desktop scroll** (Common #1/#3).
- Timezone (Issue 3): Ready/Target (query-default → first/last point zone), Response Deadline (org zone), ETA/ETB/ETD (port zone), Query Date (viewer-local, read-only).

### Shipment (Step 2) — **kept for now** (full merge deferred)
- **Remove the DG indicator field** now (query `dgIndicator` stays server-side, derived from cargo).
- **Add "N/A" to Incoterms** (Cargo #6 applied here while Incoterms lives on this step) — Incoterms **stays mandatory**; "N/A" is a valid value; default "Select".
- *(Deferred: removing this step and moving Incoterms + Shipment Description into Cargo — see Deferred/Future.)*

### Cargo (Step 3)
- **Add Row → popup** with **Save/Cancel** (Common #8).
- **MSDS on DG:** when DG is checked in the add/edit popup, allow attaching the PDF; **hold the file and send it with the cargo create** (no cargo-id-first problem). **Not blocked at Save** — the "DG needs MSDS" rule (F6) is enforced at **Create Query** (Common #5).
- **Uploaded MSDS** shows the **PDF filename + a ✕ to remove it permanently** → needs a new **delete-MSDS endpoint** (Cargo #5).
- *(Deferred: rename heading to "Shipment & Cargo" + add a Shipment Details section — tied to the merge.)*

### Leg & Route (Step 4)
- **Rename** the header/step label "Leg / Route" → **"Leg & Route"**.
- **Route Canvas** (Issue 1) — full rework.

### Notes & Checklist (Step 5)
- **Notes and all 9 checklist boxes are mandatory** — a **pure manual confirmation** gate with **no auto-validation against any field**. Enforced at **Create Query** (surfaces in the Validation Summary under this tab), not as per-screen blocking.
- **Drop** the current DG-conditional disabling of "MSDS received" (all 9 boxes are always tickable + required) and the old **"Save Draft / Send Anyway" optional-gaps prompt** (superseded by the Create gate).

---

## Per-screen coverage matrix

| Screen / surface | Issue 1 Canvas | Issue 2 Validation | Issue 3 Timezone | New items |
|---|---|---|---|---|
| Query List | — | — | Date columns + zone labels | Fix "All" filters · date-range popup · paginate @10 |
| Client & Query (S1) | — | Findings bucket here (badge) | Ready/Target · Deadline · ETA/ETB/ETD zones | Deadline default-by-priority · Deadline ≥ Query Date · sectioned layout |
| Shipment (S2) | — | Incoterms finding buckets here (badge) | — | Remove DG indicator · Incoterms "N/A" |
| Cargo (S3) | — | F6 buckets here (badge) | — | Add-row popup · MSDS hold-&-send + delete endpoint |
| Leg & Route (S4) | **Full rework** | Route findings bucket here (badge) | Leg Ready/Target zones | Rename to "Leg & Route" |
| Notes & Checklist (S5) | — | Notes/checklist bucket here (badge) | — | Notes + all boxes mandatory (manual, Create-enforced) |
| Editors (Point/Leg/Cargo) | Click-to-open + Delete-in-dialog | — | Point timezone; leg date zone labels | Save/Cancel standard |
| WizardShell | — | **Summary panel + stepper badges + Create=gate + relax Next** | Query Date zone | — |
| Masters (Clients/Vessels) | — | — | Audit times viewer-local | Contact phone strict E.164 · paginate @10 |
| Shared engine | — | Finding→tab bucket | UTC-instant temporal math | — |
| Data model (Prisma) | — | — | `Point.timezone` + migration | — |

---

## Issue 3 — resolved design (settled 2026-07-22 · built on `feat/plan-6b-req-issues-round1-timezone`)

**Open decisions — resolved:**
- **(a)** ✅ Query Ready/Target anchor to the **org default zone until any Point exists**, then **re-anchor** to the **first-point (Ready) / last-point (Target)** zone once the route is built (airline-itinerary model; consistent with T2 first/last-leg = query).
- **(b)** ✅ **Response Deadline → org operating zone**, always shown with a zone label (one canonical SLA time for every viewer).
- **(c)** ✅ **Org default zone = `Asia/Kolkata` (IST)**, stored as a seeded, **admin-editable Config setting** — a new key-value **`AppSetting { key @id, value }`** table (mirrors the `CodeSequence` keyed-table precedent), seeded `orgDefaultTimezone` via the idempotent reference-seed, exposed via `ConfigDataService` (GET + admin PATCH) with a shared Zod IANA-id validator.
- **(d)** ✅ **Manual IANA zone picker per Point** (`Point.timezone`), default = org zone, overridable — a searchable dropdown from `Intl.supportedValuesOf('timeZone')`. No geocoding/auto-derive (robust for multi-zone countries).

**Design summary:**
- **Data / migration** (the one increment carrying a Prisma migration): add nullable `Point.timezone` (IANA id), **required-at-Create** (added to `POINT_REQUIRED_FIELDS` → surfaces in the ValidationSummary under *Leg & Route*; **not** Save-blocking, per Common #4/#5). Migration adds the column, **backfills existing Point rows → `Asia/Kolkata`**, and creates + seeds `AppSetting`. Operational datetime columns **stay Prisma `DateTime` (UTC)** — no `timestamptz` switch (Prisma already reads/writes them as UTC instants and only Prisma touches them; a column-type migration adds risk for no functional gain). *Explicit non-goal.*
- **Anchor rules** (which zone a datetime displays/interprets in): leg Ready → origin-point zone · leg Target → destination-point zone · query Ready/Target → first/last-point zone (org zone before points) · Response Deadline → org zone · **ETA/ETB/ETD → the SEAPORT point's zone when present (first if several), else org zone** · system/audit times (Query Date, created/updated) → **viewer-local**. All shown with a zone label (e.g. "09:00 IST").
- **Conversion layer:** retire the floating-wall-clock `toIsoOffset`/`isoToLocalInput`; add a date-fns-v4-native TZ package (`@date-fns/tz` or `date-fns-tz`, pinned in-build) to `packages/shared` (isomorphic). New helpers `zonedInputToUtc(wallClock, zone)` / `utcToZonedInput(utcIso, zone)` / `formatInZone(utcIso, zone)`. Datetime-local inputs keep their UX but round-trip through the **anchor zone**, not the machine offset.
- **Temporal math:** all comparisons on real UTC instants — Ready≤Target, T1/T2/T3, F4 already are; **F3 ETA<ETB<ETD switches string-compare → instant-compare**.
- **UI:** PointEditor gains the required zone dropdown; every datetime display carries its anchor-zone label; Query List Query Date/Updated = viewer-local, Response By = org-zone, all labeled; the client reads the org default zone from the config GET (TanStack Query cached).
- **Testing:** shared pure-unit conversion tests across representative zones incl. a **DST boundary** (e.g. America/New_York transition; Asia/Kolkata no-DST) + UTC-instant temporal comparisons + label formatting; migration test (backfill + seed); api e2e (config GET/PATCH admin-gated; Point create/read with timezone); web integration (zone dropdown, round-trip, list labels).

## Deferred / future
- **Shipment → "Shipment & Cargo" full merge** (remove Step 2, move Incoterms + Shipment Description into Cargo, 5→4 steps). Deferred to keep step indices stable this round; the DG-indicator removal is done now.
- **G6** — map server-400 Zod `issues` to individual inputs.
- **D2** (Net ≤ Gross as a warning per §10 F5) · **D4** (restrict ROAD leg endpoints per §10.4). (D1 strict-phone is now Common #7 — in scope.)

---

## What already shipped (rounds 1–2, on `feat/plan-6-wizard-ui-bugs`)
All TDD, `pnpm run ci` green. **Some items are superseded by this round** — flagged ⟲.

**Round 1 — bugs + quick validation wins**
- Shared schema: readyDate ≤ targetDelivery (G10), leg self-loop guard (G12), list dateFrom ≤ dateTo (G11), trim + reject whitespace on required text (G8).
- Pickers/codes: vessel search ACTIVE-only (G7), IATA/ICAO/UN-LOCODE auto-uppercase (G9).
- Session: 401 → logout + redirect to `/login` (U1).
- Step-4 **Points list + edit/remove (U6)** ⟲ *replaced by the Route Canvas (Issue 1)*.
- Wizard UX: Cancel→list (U2), Save success (U3), errors-at-top (U4), Step-2 client validation (G1), "Save Draft" persists (G2), Create error surfaced (G3), priority error (G4), non-DG MSDS-nag fix (G5) ⟲ *checklist reworked in Notes & Checklist above*.
- **Next-gate on mandatory (U5) + per-step warnings (D3)** ⟲ *removed by Common #4/#5 (validate at Create only)*.

**Round 2 — Legs/Route rework**
- **Add/Edit Point & Leg hard-block incomplete saves (#4)** ⟲ *removed by Common #5 (no validation on Save)*.
- Route findings at **create-phase** + grouped by box (kept — feeds Issue 2's bucketing).
- Step-4 **reorder + top strip + per-box hover; Validate button removed** ⟲ *lists replaced by the Canvas (Issue 1); strip + hover kept*.
- **RouteDiagram hover tooltips** (kept — reused by the Canvas).
- **Step-4 Save/Next gate (#1/#3)** ⟲ *replaced by Create=single-gate (Issue 2)*.

## Testing approach
Each increment TDD, `pnpm run ci` green. Shared-engine changes (Finding→tab bucket, UTC temporal comparisons, strict E.164 regex, Incoterms enum) → pure unit tests. Screen/editor changes → `renderWithProviders` integration tests. Timezone conversion → pure unit tests across representative zones incl. a DST boundary, plus a migration test. New delete-MSDS endpoint → api e2e.
