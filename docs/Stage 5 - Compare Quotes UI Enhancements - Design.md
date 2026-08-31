# Stage 5 · Compare Quotes — UI/UX Enhancements — Design

_Design of record for the nine enhancements requested on 2026-08-17, against the S5.6 Compare Quotes screen delivered on `feat/stage-5-fx-master` (commits `7b58a8d..354236e`, PR #52)._

Parent design: [Stage 5 - Compare Quotes - Design.md](Stage%205%20-%20Compare%20Quotes%20-%20Design.md) (§9 button states, §11 endpoints, §12 frontend, §4/§13 RBAC, §16 O4).
Implementation plan: [docs/plans/stage-5/Stage 5 - S5.7 - Compare Quotes UI Enhancements - Implementation Plan.md](plans/stage-5/Stage%205%20-%20S5.7%20-%20Compare%20Quotes%20UI%20Enhancements%20-%20Implementation%20Plan.md).

## Goal

Reduce the Compare Quotes screen from a long vertical stack of sections into a compact, grid-first comparison, and make the recommended offer, the conversion rate, and the charge breakdown legible at a glance. The maker's two-step "shortlist, then send for approval" collapses into one dialog.

## 🔴 Hard constraint: frontend only

**No backend, `packages/shared`, Prisma, or API changes.** Locked by the requester on 2026-08-17. Every item below is delivered against the read model exactly as `GET /api/queries/:id/comparison` returns it today.

This constraint has three consequences that are **not** oversights. They are accepted gaps with follow-ups; see [Consequences of the frontend-only constraint](#consequences-of-the-frontend-only-constraint).

## Scope — the nine items

| # | Item | Decision | Surface |
| :-- | :-- | :-- | :-- |
| 1 | Tabular grid, one forwarder's variants under one group | **Both orientations, user-switchable** | `ComparisonGrid` |
| 2 | Charge breakdown as parent→child in a pop-up | **UI-only against the 3 existing lines** | new `ChargeBreakdownDialog` |
| 3 | Recommended shown by colour, not a banner | Tint the recommended column/row; **delete `RecommendationBanner`** | `ComparisonGrid` |
| 4 | Shortlist after Status in each column; opens send-for-approval | **Merge shortlist + send into one dialog** | new `ShortlistDialog`, `MakerPanel` shrinks |
| 5 | No Negotiate once sent for approval | Disable with a visible reason | `CompareLegPanel` |
| 6 | Leg-level Negotiate with multi-forwarder select + notes | Shared note, optional per-forwarder notes | `NegotiateDialog` rewritten |
| 7 | Less scrolling | **No structural change** — legs stay stacked, one open at a time | verification only |
| 8 | Executive view aligned | One screen, both roles; test both explicitly | all of the above |
| 9 | Conversion rate in the comparison | `OfferDto.unitsPerUsd` — already in the payload | `ComparisonGrid`, dialogs |

## Item detail

### 1 — Two grid orientations, switchable

The grid gains a `viewMode: "columns" | "rows"` control, rendered as a small segmented toggle on the leg's action line. The executive picks per their forwarder count; the choice persists in `localStorage` under a single key (`svyft.compare.viewMode`), browser-scoped, defaulting to `"columns"`.

- **Columns** (today's orientation, corrected): offers as columns, metrics as rows. The forwarder grouping — currently invisible, which is what prompted this item — becomes explicit with a heavy right rule closing each forwarder's variant group and the forwarder name spanning its variants. Deliberately left out in S5.6 Task 3 (judgment call #1); now required.
- **Rows**: one row per `(forwarder × variant)`, fixed columns (`Total USD · Total native · Rate · Transit · Valid · Status · Shortlist · Breakdown`). Forwarder rows are grouped and banded. Scales past ~4 forwarders without horizontal scrolling.

Both orientations render the same cells and must reach feature parity: recommended tint, unpriced greying, stale badge, shortlist affordance, breakdown affordance, conversion rate. **A shared row-model function** derives the display cells once; each orientation is a presentation of that model, so the two views cannot drift.

`offerKey(quoteId, variant)` remains the column/row identity in both. Unpriced offers stay non-interactive in both — no shortlist button, no breakdown link, never a fake `$0` (S5.6 T3 Important #1; must not regress).

### 2 — Charge breakdown dialog

`OfferDetail`'s inline block becomes a modal `ChargeBreakdownDialog`, one offer at a time (explicitly **not** two forwarders side by side).

Contents: header (forwarder · variant · leg), the offer's charge lines as collapsible groups, the grand total, and the conversion rate with the FX as-of stamp.

**The honest limitation:** `buildCharges` (`comparison.service.ts`) emits at most three flat lines — `Freight` (the variant's rate; absent for Air), `Additional Charges` (**one** sum over every origin/destination/ad-hoc charge), `Warehousing` (**one** sum over all warehouse rows). There are no child lines in the payload, so the groups render as subtotal rows with nothing beneath them today.

The component is therefore built **tree-shaped from the start**: it takes a `ChargeNode[]` (`{ label, nativeAmount, usdAmount, children?: ChargeNode[] }`), maps the flat `OfferChargeLineDto[]` into single-level nodes, and renders expand/collapse only for nodes that have children. When the backend later supplies itemised lines, only the mapping function changes — not the component, not the dialog, not the tests for the rendering.

The total shown is the offer's authoritative `usdTotal`, never a sum of the line `usdAmount`s (per-line rounding can differ by a cent on foreign-currency legs — S5.6 T1 Minor #1, pinned by an existing test).

### 3 — Recommendation by colour

`RecommendationBanner.tsx` is **deleted**. The recommended offer is conveyed by:
- a tinted column (or row) spanning every metric, and
- a `★ Recommended` badge on its Status cell.

The recommendation's *reason* (e.g. "High priority → fastest transit (3 days)"), which the banner carried, moves to a tooltip on the badge so the information isn't lost.

`locked` still suppresses the tint entirely (S5.6 final-review M1: after award the winner is `APPROVED` and excluded from `offers`, so the live recommendation re-ranks the losers — the tint must not reappear in the frozen state).

### 4 — Shortlist in the grid, one dialog

The `SHORTLIST AN OFFER` radio group and the `SEND FOR APPROVAL` box are both **removed** from `MakerPanel`. In their place, each priced offer's column/row carries a **Select** button directly beneath its Status cell.

Clicking it opens `ShortlistDialog`:
- offer summary (USD, native, rate, transit),
- override reason — shown and **required** when the pick ≠ the recommendation,
- the A9 *proceed without waiting* checkbox + reason when the leg has an in-flight re-quote,
- two exits: **Save shortlist** and **Save & send for approval**.

`MakerPanel` retains only the locked-state messaging (the `PENDING_APPROVAL` / `APPROVED` copy corrected in the final-review fix wave) and the rejection-reason alert.

**This closes a bug class by construction.** The Critical found in S5.6's whole-sub-build review existed because the grid's selection and the persisted shortlist lived in different components and could drift, letting "Send for approval" submit an offer the maker never shortlisted. With one dialog acting on one offer, there is no second piece of state to diverge from. The `unsavedPick` guard added in `354236e` becomes unnecessary and is removed with the sections it guarded — **its regression tests must be replaced, not merely deleted** (see the plan's Task 4).

### 5 — Negotiate blocked once sent for approval

The leg's Negotiate button is `disabled` when `decision.status === "PENDING_APPROVAL"`, with a visible reason ("Sent for approval — a checker must reject this leg before you can renegotiate"). Rendered-and-disabled, not hidden, matching the four-eyes treatment already used on Approve/Reject.

### 6 — Leg-level multi-forwarder Negotiate

The per-forwarder Negotiate buttons are removed. A single **Negotiate…** button sits at the right of the `N offers received` line. It opens the rewritten `NegotiateDialog`:

- **Select all** plus a checkbox per forwarder, showing each one's current price and status.
- **Eligibility is per forwarder, not per offer** — one `Quote` covers all of a forwarder's variants, and `request-requote` is keyed by `quoteId`. Eligible = a `QUOTED` or `APPROVED` quote on this leg. Ineligible forwarders are **shown, disabled, with the reason** (`Re-quote requested` → already awaiting; `RFQ sent` → never quoted), rather than hidden.
- A **shared note** applied to all selected, plus a *Write a separate note for each forwarder* toggle that swaps in one box per selected forwarder.
- Submit label states the count: `Send to N forwarders`.

**Partial success is a real state.** `request-requote` is per-quote, so N selections are N sequential calls. The dialog reports a per-forwarder result list (sent / failed with its message) rather than one combined error, stays open on any failure so the user can retry only the failures, and invalidates `["comparison", queryId]` **once** after the batch settles.

### 7 — Layout unchanged

Legs remain stacked cards with one open at a time. The scroll reduction comes entirely from items 3, 4 and 6 removing the banner and the two action sections. Clicking a leg in the route diagram already opens and scrolls to that leg (S5.6 Task 2's `selectedLegId`/`onSelectLeg` → `jumpToLeg`); this is **verified, not rebuilt**.

### 8 — Both roles

One screen serves both. The Executive sees the maker half; Manager/Administrator additionally see the checker controls and `GenerateGate`. (**Superseded in S5.9.1:** `CheckerPanel` — the component this line originally named — was deleted; Approve/Reject now live in `CompareLegPanel`'s one shared action bar, gated on `canCheck`, each behind `ApproveDialog`/`RejectDialog`. `GenerateGate` is unchanged.) Every item above lands for both roles. Because item 4 removes the sections the Executive uses most, **both roles are tested explicitly** — an Executive-viewer test and a Manager-viewer test per changed component, awaiting a positive auth control before asserting (see Testing).

### 9 — Conversion rate

`OfferDto.unitsPerUsd` is already in the payload. Add a **Rate (per USD)** metric row (columns view) / column (rows view), muted, `null` rendering as an em-dash. Also shown in the charge dialog's footer alongside `ComparisonDto.fxAsOf`.

## Consequences of the frontend-only constraint

Recorded deliberately, for future reconsideration.

### C1 — Item 5 is a convention, not a rule
`AwardService.requestRequote` accepts a re-quote on a leg in `PENDING_APPROVAL` and resets that leg's decision to `DRAFT`. Disabling the button prevents it through the UI only; the endpoint remains reachable by any authenticated Executive+ caller. **Follow-up:** add a decision-status guard to `requestRequote` (409 when `PENDING_APPROVAL`), or accept the reset as intended and drop the UI restriction. The two currently contradict each other.

### C2 — Item 2 shows subtotals, not a breakdown
The dialog cannot show what "Additional Charges" is composed of, because the read model never carries it. The full detail exists in each quote's `draftJson` (`charges[]` with `zone`/`label`/`amount`/`note`, `trucking[]`, `seaRates[]`, `warehouse[]`) but `computeQuoteTotals` returns only sums. **Follow-up:** a grouping-neutral read-model change — pass the raw itemised lines through, letting the UI group them however business later confirms. Deliberately deferred pending that confirmation; the dialog is built tree-shaped so the later change is UI-mapping-only.

### C3 — Multi-forwarder negotiate is not atomic
N forwarders means N sequential `request-requote` calls with no transaction. A mid-batch failure leaves some forwarders asked and others not — each successful call has already reissued that forwarder's portal token and reset their RFQ deadline, and those effects are not rolled back. The per-forwarder result list makes this visible rather than hiding it. **Follow-up:** a bulk `request-requote` endpoint taking `{ quoteIds[], notes }` in one transaction.

### C4 — `send-for-approval` carries no offer identity
Surfaced during Task 4. `POST /api/queries/:id/legs/:legId/send-for-approval` takes no body identifying the offer; the server sends whatever the leg's **persisted** shortlist happens to be. The merged dialog re-writes the shortlist immediately before sending, so the exposure shrank from unbounded (S5.6: any previously-persisted offer, at any time) to the few-millisecond gap between two sequential requests — and it now additionally requires a **second maker working the same leg concurrently**. Assessed **Low** by the final review. It cannot be closed from the frontend. **Follow-up:** have the endpoint accept `{ quoteId, variant }` and verify it against the persisted decision server-side, 409-ing on mismatch.

### Bundling note
C1–C4 are all API-shape changes on the same feature. If they are addressed, do it as **one** backend task rather than four trips — and ideally alongside the business decision on charge grouping that C2 waits on.

## Testing

- **Vitest + @testing-library**, colocated, matching the existing `features/compare` suite (56 tests today).
- **Both roles per changed component** (item 8). `renderWithProviders`' `/api/auth/me` stub resolves asynchronously — any assertion made synchronously after `render()` fires while `user` is `null` and proves nothing. Await a positive control first, using the `AuthProbe` pattern — since S5.9.1 deleted `CheckerPanel.test.tsx` (its Generate-gate half became `GenerateGate.test.tsx`), copy it from `CompareQuotesPage.test.tsx`, `ComparisonGrid.test.tsx` or `MakerPanel.test.tsx`, which all carry it. **Three vacuous tests were shipped and fixed during S5.6 from exactly this cause.**
- **Any absence assertion must be mutation-proven**: break the production condition, confirm red, revert, confirm green.
- **Parity tests for the two grid orientations** — the same fixture asserted through both `viewMode`s, so a feature added to one and forgotten in the other fails.
- **Regressions that must not break** (each pinned by an existing test): unpriced offers never render `$0` and are non-interactive; `OfferDetail`'s total is `usdTotal`, not the sum of lines; `locked` unmounts maker/checker controls and suppresses the recommendation; four-eyes disables Approve/Reject for the sender; Generate is Manager+ with no four-eyes.
- Full `pnpm run ci` on the final task; `pnpm run typecheck` per task (vitest does not type-check).

## Out of scope

- Any backend, `packages/shared`, or database change (the follow-ups in C1–C3).
- The Stage-3/Stage-4 RFQ workspace screens (item 8 was confirmed to mean the Executive's view of *this* screen).
- Sorting the rows view, and side-by-side charge comparison — both were considered and dropped as unrequested.
- The S5.6 parked minors, which stay parked: T1 M1 (1¢ rounding), T2 M2 (`RANK.QUOTING_CLIENT`), T3 #5/#6, T4 M3, T5 M3, T6 test placement.

## Decisions log (2026-08-17)

| Question | Decision |
| :-- | :-- |
| Item 7 vs items 2/4/6 — pop-ups or not? | Pop-ups **are** the mechanism to reduce scrolling |
| Grid orientation — columns or rows? | **Both**, user-switchable |
| Charge grouping — by journey stage or cost nature? | Deferred to business; build tree-shaped, map flat for now |
| Charge dialog — two forwarders side by side? | **No**, one at a time |
| Charge groups — expanded or collapsed? | Group-wise expand/collapse |
| Backend changes? | **None** |
| Item 7 — restructure the page? | **No**; keep stacked legs, one open. Diagram click already works |
| Item 8 — which screen? | The Executive's view of this same compare screen |
