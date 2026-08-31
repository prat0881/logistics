# Stage 5 · S5.9.3 — Quotation Screen & Stage Rail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close five product-owner review points on the client-quotation screen and restructure the stage rail to four stages.

**Architecture:** Three independent slices — the preview dialog (copy affordance + an editable body, which changes the issue contract), leg ordering (a backend ordering fix reusing the existing route-order helper), and the stage rail (merging two steps and adding a disabled future one).

## Global Constraints

- **Vocabulary (D5) still binds and is NOT relaxed by this sub-build.** User-visible strings say **Approved / Quotation / Issue / Quoting client / Pending approval** — never "Awarded" or "Won" **for anything that has happened**. The new "Award" rail step is the sole exception and is legitimate precisely because it is a *future, disabled* stage: it names Stage 6, not any current state. Nothing reachable today may be labelled awarded.
- **Nothing forwarder-facing may reveal a commercial outcome** — `PENDING_APPROVAL` and `APPROVED` both render to a forwarder as "Under review".
- Every owned status change goes through `StatusService.fire`; query status is a projection, never fired.
- **No toast system.** Surface `ApiError` inline via `errorMessage(error, fallback)`.
- **Async-auth test trap:** `renderWithProviders`' `/api/auth/me` stub resolves asynchronously; an assertion made synchronously after `render()` fires while `user` is `null` and proves nothing. Await a real positive control that proves settlement *as the intended role*.
- **Radix has open delays.** Never assert a dialog's or tooltip's absence right after a click or hover; assert structural signals. Vacuous tests of that exact shape have shipped three times on this branch.
- **Every absence assertion mutation-proven** (break → red → revert → green), evidence reported.
- `packages/shared` is CommonJS — rebuild after editing.
- vitest and jest do NOT type-check — `pnpm run typecheck` is a separate gate.
- API e2e: `set -a; . apps/api/.env; set +a`, Postgres on **5433**, `--runInBand`. Known flakes (register C5): `award-generate`, `ff-portal-v3`, `charge-catalogue`, `emails` e2e specs — confirm, re-run, report; never "fix".
- `pnpm run ci` green at branch tip (shared 390 · web 861 · api 464 / 94 suites) and must stay green.
- Commit per task. **Verify `git branch --show-current`** — expected `feat/stage-5-fx-master`.

## Decisions

| # | Decision | Why |
| :-- | :-- | :-- |
| **P1** | **The client email body becomes editable**, prefilled from the server-rendered template, and is sent with the issue request. | Product owner's explicit ruling, made with the trade-off stated. |
| **P2** | **The leak protection becomes procedural, not structural.** | P1's direct consequence: the body was server-rendered so the UI *could not* place cost, margin or forwarder names in a client-facing document. Record it plainly — the issued snapshot still stores exactly what was sent, so it stays auditable after the fact. |
| **P3** | **"Copy text" → "Copy to clipboard", with real feedback.** | It reads as broken because `handleCopy` swallows every error *and* gives no success signal — a working copy and a failed one are indistinguishable. |
| **P4** | **Legs render in route order**, not the order Postgres happened to return them. | `leg.findMany({ where: { queryId } })` has no `orderBy`, so an arbitrary order is frozen into the award snapshot and rendered. `orderLegsByRoute` already exists in the FF portal. |
| **P5** | **The rail becomes four stages: Create → RFQ → Quotation → Award.** "Quotation" absorbs Compare Quotes *and* the client quotation; "Award" is present but disabled until Stage 6. | Product owner's ruling: *"We need only 4 stages, so under Quotation will cover compare Quotes and sending quotation to the client as till now client has not accepted and we have not awarded to FF yet."* D5 is preserved — Award names a future stage, never a current state. |
| **P6** | **"Reset overrides" gains a one-line description.** | The product owner had to ask what it did. If they did not know, no user will. |

---

## Task 1: The preview dialog — copy affordance and an editable body

**Files:** `packages/shared/src/quotation.ts` (issue schema), `apps/api/src/modules/quotation/quotation.service.ts` + controller, `apps/web/src/features/quotation/QuotationPreviewDialog.tsx`, plus tests.

**P3 — the copy button.** Rename to **"Copy to clipboard"**. `handleCopy` currently catches everything and does nothing on success, so the control looks dead either way. Give it a visible confirmation on success and an inline error when the clipboard is unavailable (it can be, in a non-secure context or when permission is denied). Do not add a toast system — follow the dialog's existing inline-message convention.

**P1 — the editable body.** The dialog already prefills and edits the *subject*; do the same for the body. Prefill from `quotation.previewBody`, let the manager edit, and send it with the issue request.

This changes the issue contract: `quotationIssueSchema` currently has **no** body field, and the server renders the body itself. Extend the schema, thread the value through the service, and persist what was actually sent into the issued snapshot — the snapshot is the audit record and must reflect the text the client received, not the template's.

**What must not be lost.** The body being server-rendered was the *structural* guarantee that a client-facing document could not contain cost, margin or forwarder names. After P1 that guarantee is procedural. So:
- **Keep the server-side render as the default.** The manager edits a prefilled draft; they never compose from blank.
- **The grand-total figure must remain server-authoritative** — whatever else changes, the amount the client is quoted comes from the priced quotation, not from typed text. Say in your report how you ensured that.
- Validate the body the same way the subject is validated (non-empty, a sane max length), and reject an issue with an empty body.

- [ ] **Step 1: Write the failing tests** — the button reads "Copy to clipboard"; a successful copy shows confirmation; a rejected clipboard shows an inline error; the body renders prefilled and editable; an edited body reaches the wire and lands in the issued snapshot; an empty body is refused. Cover both the api (e2e) and the web layers.
- [ ] **Step 2: Run them; confirm each fails for the right reason.**
- [ ] **Step 3: Extend the shared schema and the service**, rebuild `@svyft/shared`.
- [ ] **Step 4: Update the dialog.**
- [ ] **Step 5: Run both suites; mutation-prove every absence assertion.**
- [ ] **Step 6: `pnpm run typecheck`, then commit.**

---

## Task 2: Legs render in route order

**Files:** `apps/api/src/modules/award/award.service.ts` (snapshot construction), possibly `packages/shared`, `apps/web/src/features/quotation/QuotationPage.tsx`, plus tests.

The award snapshot's legs come from `leg.findMany({ where: { queryId } })` with **no `orderBy`**, so the order is whatever Postgres returns — effectively insertion order, which correlates with when legs were created, not with the route. That order is frozen into `Query.awardSnapshot` and rendered by the quotation.

`orderLegsByRoute` in `apps/web/src/features/ff-portal/legOrder.ts` already solves exactly this problem for the forwarder portal. **Read it first** and decide whether to lift it into `packages/shared` for reuse or to order server-side by the same rule — either is acceptable, but do not write a second, subtly different ordering rule. Say which you chose and why.

Order must be **stable and deterministic**: a query re-opened and re-generated must produce the same sequence. If two legs cannot be ordered by route (a disconnected or ambiguous route), fall back to a deterministic tiebreak — leg code — rather than leaving it to the database.

- [ ] **Step 1: Write the failing test** — a query whose legs were created out of route order produces a snapshot, and the quotation renders them pickup→delivery. Include a disconnected-route case asserting the deterministic fallback.
- [ ] **Step 2: Run it; confirm it fails.**
- [ ] **Step 3: Implement**, reusing the existing rule rather than duplicating it.
- [ ] **Step 4: Run the api and web suites; mutation-prove the ordering.**
- [ ] **Step 5: Typecheck and commit.**

---

## Task 3: Four stages, and the overrides description

**Files:** `apps/web/src/features/rfq-workspace/StageRail.tsx`, its callers (`CompareQuotesPage`, `QuotationPage`, and any other page passing `active`), `apps/web/src/features/quotation/QuotationPage.tsx`, plus tests. Then the gate and handoff.

**P5 — the rail.** Today: `Create → RFQ → Quotes → Quotation`. Target: **`Create → RFQ → Quotation → Award`**.
- **"Quotation" absorbs both** the Compare Quotes screen and the client-quotation screen. It becomes enabled at the earlier of the two current gates (`isQuotesStageEnabled`, i.e. `RFQ_SENT`+). It links to Compare Quotes, and to the client-quotation screen once that is reachable (`isQuotationStageEnabled`). Both pages now report themselves as this one step.
- **"Award" is a fourth step, always disabled** in Stage 5 — no link, rendered as a future stage. Stage 6 enables it.
- `STEP_KEYS` and every caller's `active` value change together. Check for callers beyond the two obvious pages.
- **D5 is not relaxed.** "Award" is legitimate here only because it names a stage that has not happened. Nothing reachable today may be labelled awarded — do not rename any status, badge or button.

**P6 — the overrides description.** Add a one-line description beside "Reset overrides" saying what it does: it clears every hand-typed line price on the quotation, returning them all to the margin formula. The product owner had to ask; the label alone is not enough.

- [ ] **Step 1: Write the failing tests** — the rail renders four steps in order; Quotation is active on both the compare and quotation screens; Award renders disabled with no link at every Stage-5 status; the overrides description is present.
- [ ] **Step 2: Run them; confirm they fail.**
- [ ] **Step 3: Implement**, updating every caller.
- [ ] **Step 4: Run the web suite; mutation-prove the absence assertions** (Award has no link; no Stage-5 status enables it).
- [ ] **Step 5: Run the full gate.** `pnpm --filter @svyft/shared build`, then `set -a; . apps/api/.env; set +a; pnpm run ci`. Report counts; re-run and report any C5 flake rather than "fixing" it.
- [ ] **Step 6: Update `docs/Stage 5 - Session Handoff.md`** — an S5.9.3 entry recording P1 **and P2's consequence prominently** (the leak protection is now procedural, and why — this reverses a documented guarantee and a future session must not "restore" it as a bug), P4, P5 with the D5 reasoning spelled out (Award names a future stage; the 2026-08-19 correction still stands for everything else), P3 and P6.
- [ ] **Step 7: Commit.**

---

## Self-review notes

- **Coverage:** #1 → T1 (P3) · #2 → T1 (P1/P2) · #3 → **answered, no code**, but P6 in T3 addresses why it needed asking · #4 → T2 (P4) · #5 → T3 (P5).
- **Ordering:** T1 and T2 both touch the quotation path but different files; T1 first. T3 is independent and holds the gate, so it runs last.
- **The highest-risk change is T1's P1** — it removes a structural guarantee at the product owner's explicit instruction. The risk is not the edit box; it is that the grand total or the audit snapshot quietly stops reflecting what was sent. Review that hardest.
- **The likeliest silent failure in T3** is a caller left passing a retired `active` key — it would not fail to compile if the prop is typed loosely, and the rail would simply highlight nothing.
