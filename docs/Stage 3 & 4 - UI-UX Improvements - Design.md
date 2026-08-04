# Stage 3 & 4 — UI/UX Improvements — Design

> A cross-stage batch of UI/UX polish + two small bug fixes on the **already-built**
> Stage 3 (Create Query wizard, Query List) and Stage 4 (RFQ / Send-to-Freight-Forwarder)
> screens. Sits next to `Stage 3 - Req & Issues - Round 1/2/3 - Design.md` and the Stage 4
> docs. **No Prisma migration, no new subsystem** — deltas on existing specs.
> Approach: **TDD**, one branch, tracked here for traceability (see *TDD vs SDD* below).

## Issue list (business/testing, verbatim intent)

**Stage 3**
1. Cargo listing table — modify **DG indicator** column to **Reference tags**, showing all selected reference-tag icons along with the DG indicator.
2. Query List — **merge Country search** into the combined query-code / customer search, and remove the separate Country search input.
3. After checking the checklist items → click **Create Query** (without first clicking Save) → query is not saved. Create Query should **save like the Save button** *and* create the query if all validations pass.
4. Client & Query screen — creating a new query and clicking **Next** the first time does not advance to Shipment; it needs a **second click**.
5. Validation message should follow the field **label**: "Ready Date" → **"Target Pickup"** in the validation text.
6. Remove the **leg/route validation on Save and Next** to maintain consistency.
7. Nav bar should not show green/tick until mandatory + business validation are satisfied — better UX. **(Deferred this batch — see Deferred.)**
8. Remove the **page-specific error message box** on the leg/route page.

**Stage 4**
1. Give **reference tags their own label** and show the icons under it, instead of crammed under **Totals** on the FF screen — use the whitespace properly.
2. Add a **filter for the FF list** based on the country + city of the legs' origin/destination. **(Reduced to country-only this batch — see Resolved decisions.)**
3. Show the **Regenerate** button as the **last column** of the FF list table — keep the row on one line.
4. **Default view = table** (not cards).

## Resolved decisions (settled with the user)

- **(S3.7 deferred)** The nav rail keeps **today's positional behavior** (visiting step *N* greens steps 0…*N*-1). No live per-step validation this batch. Tracked for a future round (design sketched in Deferred).
- **(S3.6 + S3.8 — one simple change)** On the legs page: remove **both** page banners and **stop *pre-Create* live route validation**. Route rules run **only** at Create Query (the existing gate already calls `validateRoute`). This makes the legs step behave like the other steps — no page-level error box, no always-on live checks.
- **(Unchanged — the top-of-screen validation summary stays exactly as today)** The **shell-level** `ValidationSummary` at the top of the screen is **not touched**. After Create Query runs, its findings — **including Leg & Route** findings — render at the top on **every** step and **persist across navigation**, so route/leg errors still appear at the top when you navigate to the legs page. What we remove is only the *legs-only* banners and the *pre-Create* live checks; the post-Create top summary behaviour is preserved verbatim.
- **(S4.2 — country-only, defer city)** The FF master has **no city-level coverage** — only `availableCountries` (coverage) plus a single HQ `city`/`country` (address). Country eligibility **already exists** in `findEligible`. So S4.2 this batch = **surface the applied origin/destination country scope** in the FF list UI; **defer city-level filtering** until FF city coverage exists (needs schema — see Deferred).
- **(S4.3 — auto-copy + toast)** Regenerate moves to its own last table column; on click it reissues the token, **copies the new portal link to the clipboard, and shows a toast** — no inline link UI, so the row stays one line.
- **(S3.2 — substring merge)** Folding country into the combined search makes country **substring-matched** (`contains`, case-insensitive) like the other search columns, replacing today's **exact** (`equals`) match. Deliberate — one forgiving box. (Tightenable to exact if the team prefers; called out in Testing.)
- **(S3.1 / S4.1 — shared icon set)** Reference-tag icons are rendered from **one shared presentation component** used by both the cargo table (per row) and the RFQ header (aggregate). `OUT_OF_GAUGE` currently has **no icon** — add one (proposed `Ruler`/`Scaling`, final pick at implementation). **DG stays a distinct indicator** (`TriangleAlert`, from `isDangerous`) shown *alongside* the reference tags, since DG is not itself a reference tag.
- **(S3.5 — label-only)** Rename the **user-facing message string** only; the internal field id `readyDate` and its DB column are unchanged (consistent with Round 3's "Target Pickup" label decision).

## Root cause — S3.3 (Create Query loses freshly-checked checklist)

`handleCreateQuery` ([QueryWizardPage.tsx:128](../apps/web/src/features/query-wizard/QueryWizardPage.tsx)) runs the client-side create gate **without first saving the current step**. Checklist state lives locally in `Step5Notes` and is only persisted by the step's save fn (`PATCH /checklist`). So when the user ticks the boxes and clicks **Create Query** directly, those ticks are never persisted; `collectChecklistFindings` then reads the **stale** `detail`, produces "… must be confirmed" blocking findings, and Create aborts — the work looks lost.

**Fix:** `handleCreateQuery` first `await onSave()` (persists the current step, incl. checklist) → `refresh()` → run the gate against fresh `detail` → `POST /create`. Same best-effort save the Save button performs, then the create gate.

## Root cause — S3.4 (first "Next" needs two clicks)

Two coupled causes:
1. `handleSave`'s new-query branch hardcodes `navigate('/queries/${id}?step=0')` ([QueryWizardPage.tsx:106](../apps/web/src/features/query-wizard/QueryWizardPage.tsx)) — it always lands the freshly-created query on **step 0**.
2. `goNext` increments `localStep`, but once `queryId` is defined the provider reads `step = clampedStep` from `?step` ([WizardContext.tsx:48](../apps/web/src/features/query-wizard/WizardContext.tsx)) — discarding the `localStep=1` that `goNext` just set.

Net: the first **Next** creates the query but the URL forces it back to step 0; a second Next (now `isNew=false`) PATCHes and advances. **Fix:** after create, navigate to the **target** step (the next index, `?step=1`) instead of hardcoding 0, and reconcile `goNext`/`localStep` so a single click advances. Navigation stays non-blocking.

## Design detail (by item)

### Stage 3

**S3.1 — Cargo table: DG column → Reference-tags icon column**
- *Current:* the DG cell renders plain `"Yes"/"No"` text ([Step3Cargo.tsx:179](../apps/web/src/features/query-wizard/steps/Step3Cargo.tsx)); reference tags exist ([cargo.ts:31](../packages/shared/src/cargo.ts)) but only as dialog checkboxes; icons live in Stage-4's [CargoTagIcons.tsx](../apps/web/src/features/rfq-workspace/CargoTagIcons.tsx) and are unused in the wizard.
- *Change:* rename the column header **"DG" → "Reference Tags"**; render a compact icon row per cargo row from `row.referenceTags` (+ a `TriangleAlert` DG icon when `row.isDangerous`). Each icon has a `title`/tooltip label. Extract a shared `<ReferenceTagIcons tags isDangerous />` presentation component (icon map incl. the new `OUT_OF_GAUGE` icon) — see S4.1 for reuse.
- *Files:* `steps/Step3Cargo.tsx` (header + cell); new shared component (e.g. `apps/web/src/components/ReferenceTagIcons.tsx`) extracted from `rfq-workspace/CargoTagIcons.tsx`.

**S3.2 — Query List: merge Country into the combined search**
- *Current:* the `q` param searches `queryCode` / `contactName` / `shipmentDescription` / `client.companyName` (`contains`, insensitive) server-side; Country is a **separate** input that filters exact (`equals`) on PICKUP/DELIVERY point country ([queries.service.ts:108](../apps/api/src/modules/queries/queries.service.ts), [QueriesToolbar.tsx:236](../apps/web/src/features/query-list/QueriesToolbar.tsx)).
- *Change (backend):* add a `{ points: { some: { country: { contains: q, mode: "insensitive" }, type: { in: ["PICKUP","DELIVERY"] } } } }` branch to the `q` OR-clause; delete the standalone `country` block and destructure.
- *Change (web):* remove the Country `<Input>` + its state / `handleCountry` / `emitFilters` / `clearFilters` / `hasFilters` plumbing; update the search placeholder to mention country.
- *Change (shared):* drop `country` from `queryListQuerySchema`.
- *Files:* `queries.service.ts`, `query-list/QueriesToolbar.tsx`, `packages/shared/src/query.ts`.

**S3.3 — Create Query also saves (root cause above)**
- *Files:* `query-wizard/QueryWizardPage.tsx` (`handleCreateQuery`).

**S3.4 — First "Next" advances on one click (root cause above)**
- *Files:* `query-wizard/QueryWizardPage.tsx` (`handleSave` new-query nav), `query-wizard/WizardContext.tsx` (`goNext`/step reconciliation).

**S3.5 — "Ready Date" → "Target Pickup" in messages**
- *Current:* messages hardcoded: `"Ready Date is required"` ([query.ts:187](../packages/shared/src/query.ts)) and `"Ready Date must be on or before Target Delivery"` ([query.ts:130](../packages/shared/src/query.ts), [legs.ts:37](../packages/shared/src/legs.ts)); UI label is **"Target Pickup"** ([Step1Client.tsx:622](../apps/web/src/features/query-wizard/steps/Step1Client.tsx)).
- *Change:* rename the three message strings to "Target Pickup …"; keep the internal `readyDate` id. Update the pinned message assertions.
- *Files:* `packages/shared/src/query.ts`, `packages/shared/src/legs.ts`.

**S3.6 + S3.8 — Legs page: remove banners + stop live validation**
- *Current:* two **legs-page-specific** banners in [LegsStep.tsx](../apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx) — the top red `RouteNoticesStrip` (line 21/132) and the incomplete-legs strip (147–177) — plus **pre-Create live** route validation via `useRouteFindings` (continuous `validateRoute`, and a `POST /validate?phase=create` call). These are *separate* from the shell-level top summary.
- *Change:* delete both legs-page banners; remove `useRouteFindings` live usage from the legs page (no continuous validation, no `/validate` call, no live inline box highlights). Route validation remains **only** in the Create Query gate (unchanged).
- *Unchanged (must preserve):* the **shell-level `ValidationSummary`** ([WizardShell.tsx](../apps/web/src/features/query-wizard/WizardShell.tsx) ~191–233) is **not** modified. After Create, the gate's findings — incl. Leg & Route (grouped under their tab heading) — keep rendering at the **top of every step**, persist across navigation, and therefore still show on the legs page. Do **not** couple this removal to the shell summary; only the legs-only banners + pre-Create live checks go.
- *Confirm during impl:* `useRouteFindings` has no other consumers before deleting it; the shell summary still receives Create-gate route findings (regression test).
- *Files:* `steps/legs/LegsStep.tsx`, `steps/legs/useRouteFindings.ts` (remove/retire). **Not** `WizardShell.tsx`'s summary.

### Stage 4

**S4.1 — Reference tags: own labeled field, off Totals**
- *Current:* `<CargoTagIcons>` renders directly beneath the Totals line ([QueryOverviewHeader.tsx:56](../apps/web/src/features/rfq-workspace/QueryOverviewHeader.tsx)).
- *Change:* give the icons a dedicated `<Field label="Reference Tags">` in the header, separate from Totals, using the header whitespace. Render via the **shared** `<ReferenceTagIcons>` from S3.1 (aggregate over `query.cargo`), incl. the new `OUT_OF_GAUGE` icon.
- *Files:* `rfq-workspace/QueryOverviewHeader.tsx`, shared `ReferenceTagIcons` component.

**S4.2 — Surface origin/destination country scope (country-only)**
- *Current:* `findEligible` already filters FFs to those whose `availableCountries` cover **both** endpoint countries ([freight-forwarders.service.ts:74](../apps/api/src/modules/freight-forwarders/freight-forwarders.service.ts)); `FfSelectionGrid` doesn't display that scope. Leg endpoints (city/country) are available at the `LegPanel` level ([LegPanel.tsx:32](../apps/web/src/features/rfq-workspace/LegPanel.tsx)) but not threaded into the grid.
- *Change:* show the applied scope as a label/chip near each leg's FF list, e.g. *"Forwarders covering {originCountry} → {destCountry}"*, reusing the leg's endpoint countries. Keep the existing `broaden` escape hatch + text search. **No backend/schema change.** City-level filtering deferred.
- *Files:* `rfq-workspace/LegPanel.tsx` and/or `rfq-workspace/FfSelectionGrid.tsx` (thread endpoint countries; render the scope label).

**S4.3 — Regenerate as last column, auto-copy + toast**
- *Current:* "Regenerate portal link" sits inside the Forwarder-name cell and expands the new link (input + Copy + helper text) inline, growing the row ([FfSelectionGrid.tsx:217](../apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx), [RegeneratePortalLink.tsx](../apps/web/src/features/rfq-workspace/RegeneratePortalLink.tsx)).
- *Change:* add a dedicated **last table column** ("" / "Actions") holding a compact Regenerate button for frozen FFs; on success, `navigator.clipboard.writeText(newUrl)` + a toast ("New portal link copied — previous link invalidated"). Drop the inline `PortalLinkRow`. Row stays one line.
- *Confirm during impl:* a toast utility exists (sonner / `useToast`); if not, add the app's standard one. Clipboard behind a click (user gesture) — fine.
- *Files:* `rfq-workspace/FfSelectionGrid.tsx` (table column), `rfq-workspace/RegeneratePortalLink.tsx` (behavior), toast util.

**S4.4 — Default to table view**
- *Current:* `useState<"cards"|"table">("cards")` ([FfSelectionGrid.tsx:32](../apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx)).
- *Change:* default to `"table"`.
- *Files:* `rfq-workspace/FfSelectionGrid.tsx`.

## TDD vs SDD — recommendation

**Use TDD, not a full SDD sub-build.** With S4.2 reduced to country-only, **nothing here touches the schema** or adds a subsystem — these are deltas on already-spec'd Stage 3/4. SDD (functional spec → tech design → sub-build) would be process overhead. This doc *is* the tracking artifact; it gives SDD-style traceability without the weight.

- **TDD (RED→GREEN)** for anything with testable logic: the two bugs (S3.3, S3.4), the search merge (S3.2, API e2e), the message-label fix (S3.5, shared unit).
- **Component test + browser verification** for pure-visual items (S3.1, S4.1–S4.4): one meaningful assertion where cheap ("default view is table", "N reference-tag icons render for tags X/Y", "Regenerate lives in the last column"), visual confirm for the rest.
- **Pure removal** for S3.6/S3.8: assert the banners are gone and that no live `/validate` fires on the legs page; the Create gate's route findings still surface (regression).

## Testing

- **Shared (unit):** S3.5 message strings ("Target Pickup …") + pinned assertions; `referenceTagIcon` map covers all four tags incl. `OUT_OF_GAUGE`.
- **API (e2e, on CI):** S3.2 — `?q=<country>` now matches queries by PICKUP/DELIVERY point country (fixtures already seed `country: "IN"`); assert the removed `?country=` path is gone. (Decide `contains` vs `equals` here — default `contains`.)
- **Web (integration, `renderWithProviders`):** S3.3 (checklist ticked → Create persists + succeeds); S3.4 (single Next advances new query to Shipment); S3.1 (Reference-Tags column renders icons + DG); S4.4 (table default); S4.1 (Reference Tags field separate from Totals); S4.3 (Regenerate in last column; click → clipboard + toast, no inline link); S3.6/S3.8 (legs-page banners gone; no pre-Create live validation / no `/validate` call while editing; **regression:** after Create with an invalid route, the shell top-of-screen summary still shows the Leg & Route findings **while on the legs step** and after navigating to it).
- **Per-task `tsc`:** run `tsc` after each task — vitest (esbuild) does **not** type-check, so type errors otherwise pile up silently in test files. Build `@svyft/shared` before web vitest.

## Scope / flow / branch

- Branch **`feat/stage-3-4-uiux-improvements`** off `main`, developed in an isolated git worktree (`.claude/worktrees/`). **No migration.**
- Flow: this design → **`writing-plans`** (task breakdown → `docs/plans/…`) → **subagent-driven** implementation (TDD, per-task review) → PR → prod-verify. `pnpm run ci` green before finishing.
- Orthogonal to **Stage 4 SB6** (change-order cascade, still pending before Stage 5) — this batch neither blocks nor depends on it. Sequence at the team's discretion.
- Align docs as plan tasks where a change is user-visible spec behavior (Stage 3 Functional Spec §Query-List search; Stage 4 Functional Spec §FF-list view/Totals). Record this batch in the relevant Session Handoff.

## Deferred / out of scope

- **S3.7 (nav-rail validation states).** Deferred. Sketch for a future round: lift the Create-gate rule set (`collectCreateFindings` + `validateRoute` + `collectChecklistFindings`, bucketed by `findingTabKey`) into a memoized value off `detail` to drive three rail states (complete / attention / upcoming) reflecting **saved** state, with a hover popover for the unmet rules. Note the two-channel split: format/ordering rules (email, E.164, IMO, ETA<ETB<ETD, deadline-not-past, Target Pickup ≤ Target Delivery) are enforced at save time by `querySaveSchema` and can't be persisted invalid, so the rail need only cover completeness/business/route/checklist.
- **S4.2 city-level filtering.** Needs FF **city coverage** data that doesn't exist today — a new `FreightForwarder` coverage attribute (e.g. `availableCities` or origin→destination lanes): Prisma migration, DTO/zod, master-data UI, and `findEligible` logic. Its own sub-build when prioritized.
- **No `readyDate → targetPickup` data/DB rename** — S3.5 is label/message only.

## Delivery status (implemented)

Delivered on branch `feat/stage-3-4-uiux-improvements` (worktree off `main` `343d14d`), TDD, subagent-driven with a per-task spec+quality review gate. Implementation plan: [`docs/plans/stage-3/2026-08-03-stage-3-4-uiux-improvements.md`](plans/stage-3/2026-08-03-stage-3-4-uiux-improvements.md).

| Item | Status | Commit(s) |
|------|--------|-----------|
| Shared `ReferenceTagIcons` (Task 1, incl. `OUT_OF_GAUGE`) | ✅ | `905c326` |
| S3.5 message "Ready Date" → "Target Pickup" | ✅ | `e91cfa8` |
| S3.3 Create Query saves current step first | ✅ | `00b8483` |
| S3.4 first Next advances a new query in one click | ✅ | `bb18464` |
| S3.6/S3.8 legs-page banners + pre-Create live validation removed | ✅ | `1fc120f` |
| S3.1 cargo DG column → Reference Tags icons | ✅ | `62840a0` |
| S3.2 country folded into `q` search (API + shared) | ✅ | `e91c976` |
| S3.2 Country input removed (web) | ✅ | `efc3a41` |
| S4.4 default view = table | ✅ | `28f9d3c` |
| S4.1 Reference Tags own header field | ✅ | `0a94d4b` |
| S4.2 origin/dest country-scope chip (country-only) | ✅ | `ebfe4c6` |
| S4.3 Regenerate last column + auto-copy + transient confirm | ✅ | `b1268b1`, `73e6c16`, `e93d21b` |

**Notes on delivered behaviour vs this design:**
- **S3.4** was implemented as **`localStep`-authoritative** (mint navigates to `/queries/:id` with no `?step`; Next advances via `goNext`, Save stays put) rather than the design's literal `?step=1` — the literal form would have made Save also advance. Same net UX (one-click Next, non-blocking navigation).
- **S4.3** uses a **transient in-button "Link copied ✓" confirmation + `aria-live`** (no toast library exists in the app); on a *failed* clipboard write it falls back to the existing `PortalLinkRow` so the reissued link is still retrievable. The full link also remains visible at distribution time in `DistributeLegAction`.

**Verification:** shared 239/239, api `queries-list` e2e 7/7 (both S3.2 cases), web 385/386 — the one failure is a **pre-existing, unrelated** date-boundary flake in `Step1Client.test.tsx` (unchanged vs `main`; trips only across a midnight rollover). All typechecks + web lint clean.

**Fast-follow backlog (plan-mandated review findings, deferred for a decision — see the plan's Risks & the SDD ledger):**
- Wizard Create/Save error-handling hardening (`QueryWizardPage`): the best-effort `handleSave()` catch and `await refresh()` are unguarded, and the `?? detail` cache-miss fallback is silent (S3.3).
- `WizardContext` `localStep` can leak the step across a client-side route change to a *different* query id (existing→existing = 1-frame flash; existing→new = wrong initial step, manual Back recovers) — reset `localStep` on `queryId` identity change (S3.4).
- Pre-existing `Step1Client.test.tsx` date-boundary flake — make the "today" assertion timezone/rollover-safe.
