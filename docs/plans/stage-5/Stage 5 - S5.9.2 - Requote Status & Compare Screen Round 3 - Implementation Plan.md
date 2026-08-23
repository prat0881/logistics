# Stage 5 · S5.9.2 — Re-quote Status & Compare-Screen Round 3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax. Parent design: [`docs/Stage 5 - Approval Flow & Compare Screen Rework - Design.md`](../../Stage%205%20-%20Approval%20Flow%20%26%20Compare%20Screen%20Rework%20-%20Design.md).

**Goal:** Make a re-quote honest in leg and query status, make rejection always possible, and close seven further product-owner review points on the Compare Quotes screen.

**Architecture:** One backend change of substance — a re-quote now walks the leg *backwards* to the status its quotes justify, and the send/approve guards learn to accept the explicit proceed-without-waiting override so the flow that depended on the old hysteresis keeps working. Everything else is frontend or copy.

**Tech Stack:** NestJS + Prisma (`apps/api`), pure TS + Zod (`packages/shared`), React 18 + TanStack Query + RHF + shadcn/Radix (`apps/web`). No schema change, no migration.

## Global Constraints

- **Vocabulary (D5, binding):** user-visible strings say **Approved / Quotation / Issue / Quoting client / Pending approval** — never "Awarded" or "Won". Nothing forwarder-facing may reveal a commercial outcome (`PENDING_APPROVAL` and `APPROVED` both render to a forwarder as "Under review").
- **Every owned status change goes through `StatusService.fire`.** No bare Prisma writes to `leg.status` / `quote.status`. Query status is a projection — never fired.
- **Fires happen only AFTER the enclosing transaction commits.** `StatusService.fire` opens its own transaction on another pool connection; firing while holding `lockLeg`'s `FOR UPDATE` on that Leg row self-deadlocks to a P2028.
- `lockLeg` is the first statement of the transaction in every award entry point, always Leg-first. Do not introduce a different lock order.
- **Comms stay wrapped in `try/catch` + `logger.error`**, dispatched last. A comms failure must never fail its caller.
- **No toast system.** Surface `ApiError` inline via the existing `errorMessage(error, fallback)`.
- **After a mutation** invalidate `["comparison", queryId]` (+ `["query", queryId]` where query status changes — **Task 1 changes query status, so it must invalidate both**).
- **Async-auth test trap:** `renderWithProviders`' `/api/auth/me` stub resolves asynchronously; an assertion made synchronously after `render()` fires while `user` is `null` and proves nothing. Await a positive control — the `AuthProbe` pattern in `ComparisonGrid.test.tsx`.
- **Radix has open delays.** Never assert a dialog's or tooltip's absence immediately after a click or hover; assert structural signals. Vacuous tests of exactly that shape have shipped twice on this branch.
- **Every absence assertion must be mutation-proven** (break → red → revert → green) and the evidence reported.
- `packages/shared` is CommonJS — rebuild (`pnpm --filter @svyft/shared build`) after editing.
- vitest and jest do NOT type-check — `pnpm run typecheck` is a separate gate.
- API e2e: `set -a; . apps/api/.env; set +a`, Postgres on **port 5433**, `--runInBand`. Known flakes (register C5): `award-generate.e2e-spec.ts`'s float test, `ff-portal-v3.e2e-spec.ts`, `charge-catalogue.e2e-spec.ts` — confirm, re-run, report; do not "fix".
- `pnpm run ci` is green at branch tip (shared 390 · web 841 · api 446 / 93 suites) and must stay green.
- Commit per task. **Verify `git branch --show-current` before every commit** — expected `feat/stage-5-fx-master`.

## Decisions

| # | Decision | Why |
| :-- | :-- | :-- |
| **Q1** | **A re-quote walks the leg backwards** to what its quotes justify — `PARTIALLY_QUOTED` if a sibling is still `QUOTED`, `RFQ_SENT` if none. Query status follows automatically. | Register **C7**: today a re-quote moves neither leg nor query, so a leg reads "Fully Quoted" while we are waiting on a forwarder again. `rollupLegTarget` already treats `REQUOTED` as unresolved; only the projector's never-walk-backwards guard prevented it. |
| **Q2** | **No query-side change.** Both `PARTIALLY_QUOTED` and `RFQ_SENT` already map to `QueryStatus.RFQ_SENT` in `deriveQueryStatus`. | Query status is a projection. The product owner asked whether a query change was needed: it is not — it follows for free. |
| **Q3** | **Send and approve accept the explicit proceed-without-waiting override from a fallen-back leg.** | Q1 removes the hysteresis the A9 flow relied on. `PARTIALLY_QUOTED → PENDING_APPROVAL` is *already* a registered edge; only the guards refuse. Without this, an exec who asks one forwarder to sharpen a price can no longer approve a different forwarder meanwhile. Re-promoting the leg to `FULLY_QUOTED` instead was considered and rejected: it restores the very mismatch Q1 removes, and leaks it back after a rejection. |
| **Q4** | **`REQUOTED` renders as "RFQ-Resent"** app-wide, and the duplicate stale badge is dropped from the grid. | Product owner's call: it should read alongside the original "RFQ Sent". "Requoted" reads past-tense for a state that is actually pending, and two badges said the same thing. |
| **Q5** | **Rejection is always possible.** When the shortlisted quote is not `PENDING_APPROVAL`, skip its transition and log — never refuse the rejection. | The current guard 409s, which makes the leg unrecoverable: approve's A8 refuses it too. Rejection is the recovery path and must not require the thing being recovered from to be healthy. Also closes the registered second wedge (post-commit quote fire throws → leg movable by neither approve nor reject). |
| **Q6** | **Manager/Admin see "Send for approval" only once a decision row exists.** | Product owner: *"Manager cannot see Send for approval without Exec requested."* `sendForApproval`'s upsert is the **only** creator of `LegAwardDecision`, so `decision != null` means exactly "an exec has sent this leg at least once". Bites on a rejected or re-quoted leg, where a manager may push it forward. |
| **Q7** | **The rejection reason moves to the top of the expanded leg**, above the table. Nothing on a collapsed row. | Product owner: the reason must be visible, but they do not want a collapsed-row indicator. It renders today *below* the table and the action bar, so it is found last. |

---
## Task 1: A re-quote walks the leg back, and the override still works

**Files:** `apps/api/src/modules/rfq/leg-quote.projector.ts`, `apps/api/src/modules/award/award.module.ts`, `apps/api/src/modules/award/negotiation.service.ts`, `apps/api/src/modules/award/award.service.ts`; tests in `apps/api/test/`.

**Interfaces produced:** new leg edges `FULLY_QUOTED → PARTIALLY_QUOTED` and `FULLY_QUOTED → RFQ_SENT`. The send/approve guards gain an override term.

**Why the projector currently refuses (read this before editing).** `recomputeLeg` fires `QUOTE_PARTIAL` only when `leg.status === RFQ_SENT` — a deliberate never-walk-backwards backstop. `rollupLegTarget` already excludes `REQUOTED` from `LEG_ROLLUP_RESOLVED`, so it *already returns* `PARTIALLY_QUOTED`/`null` for a re-quoted leg; the guard is what discards that answer.

**The interaction that makes this task risky.** The last whole-branch review found a Critical here: a leg sent via the A9 "proceed without waiting" path could never be approved, because `isFullyQuotedForDecision` asked a question the rollup could not answer for a `REQUOTED` sibling. That was fixed by also consulting the status the leg held when it was sent, read off the immutable `StatusTransition` row. **Q1 changes what that status will be** — a leg sent after a re-quote now leaves `PARTIALLY_QUOTED`, not `FULLY_QUOTED` — so the fix's second term stops covering this case and approve would 409 again. Q3 is what keeps it working. Trace `isFullyQuotedForDecision`, `sendForApproval`'s A3 guard and `approve`'s guard together before you change any of them, and say in your report how the three now interact.

**The override signal.** `sendForApproval` already receives `proceedWithoutWaiting` + `proceedReason` and records the reason on the `SEND_FOR_APPROVAL` `AwardDecisionEvent`. Decide how approve learns that the send was an explicit override — the event log is the honest source, and `legStatusWhenSentForApproval` already reads the transition log, so there is precedent for consulting history rather than adding a column. **No schema change is permitted**; if you believe one is unavoidable, STOP and report.

- [ ] **Step 1: Write the failing tests.** Cover, as e2e against the real endpoints: (a) a re-quote on a leg with a still-`QUOTED` sibling moves the leg to `PARTIALLY_QUOTED` and the query to `RFQ_SENT`; (b) a re-quote on a leg whose only quote was re-quoted moves it to `RFQ_SENT`; (c) an exec can still send such a leg with `proceedWithoutWaiting` + reason; (d) a checker can then **approve** it; (e) rejecting it returns the leg to `PARTIALLY_QUOTED`, **not** `FULLY_QUOTED`; (f) without the override, sending a fallen-back leg is still refused; (g) the re-quoted forwarder re-submitting rolls the leg forward to `FULLY_QUOTED` again.
- [ ] **Step 2: Run them; confirm each fails for the right reason.**
- [ ] **Step 3: Register the backward edges** in `award.module.ts`, `kind: "reopen"`.
- [ ] **Step 4: Let the projector walk backwards on a re-quote** — narrowly. The backstop exists so a leg is not dragged back by unrelated events; do not remove it wholesale. Say in your report exactly which inputs can now move a leg backwards and why nothing else can.
- [ ] **Step 5: Widen the send and approve guards** for the recorded override, per Q3.
- [ ] **Step 6: Run the whole api suite**, then `pnpm run typecheck`.
- [ ] **Step 7: Commit.**

---

## Task 2: Rejection is always possible

**Files:** `apps/api/src/modules/award/award.service.ts` (`reject`), `apps/api/test/award-workflow-checker.e2e-spec.ts`.

`reject()` currently throws `ConflictException("The shortlisted quote is no longer available to reject — it may already have been resolved elsewhere")` when the shortlisted quote is not `PENDING_APPROVAL`. That makes the leg unrecoverable: `approve`'s A8 refuses it for the same reason, so neither checker action can move it and it needs a change order or DB surgery.

Replace the refusal with tolerance: **skip the quote's `RETURN` fire** when it is not `PENDING_APPROVAL`, log at warn with the leg and quote ids, and carry on — write the decision to `DRAFT` with the reason and fire the leg's return as normal. Rejection is the recovery path; it must not require the thing being recovered from to be healthy.

Keep the ordering rules: the decision write and the leg fire are unchanged, fires stay after the commit, and nothing may half-commit.

- [ ] **Step 1: Write the failing tests** — reject succeeds when the shortlisted quote has drifted to `QUOTED`, to `REQUOTED`, and when the quote row is missing entirely; in each case the decision reaches `DRAFT` with the reason and the leg returns to its rollup status. Plus the normal path still fires the quote back to `QUOTED`.
- [ ] **Step 2: Run them; confirm they fail with the current 409.**
- [ ] **Step 3: Implement the tolerance.**
- [ ] **Step 4: Run the api suite; mutation-prove** that removing the skip re-breaks the drifted cases.
- [ ] **Step 5: Typecheck and commit.**

---

## Task 3: Compare-screen behaviour — notes, override, manager gate, reason placement

**Files:** `apps/web/src/features/compare/NegotiateDialog.tsx`, `SendForApprovalDialog.tsx`, `CompareLegPanel.tsx`, `MakerPanel.tsx`, plus tests.

1. **Negotiate — one shared note (#1).** Remove the `separateNotes` toggle and the per-forwarder note boxes; keep the single shared note applied to every selected forwarder. An exec wanting different wording selects one forwarder at a time. Remove the now-dead per-forwarder note state and any tests that only covered the toggle — but **keep** the multi-forwarder selection, the eligibility list with its disabled reasons, and the per-forwarder result list on partial failure.
2. **Override block simplified (#9).** In `SendForApprovalDialog`, drop the bordered warning box around the in-flight-re-quote override. Keep a plain checkbox, and render its reason field **always** (not only after ticking), marked required. The reason is already enforced on submit; make the requirement visible rather than conditional, matching how the override reason is handled in the main body of the same dialog.
3. **Manager gate on Send (#8, Q6).** Manager/Admin see "Send for approval" only when `leg.decision != null`. Executives are unaffected. Test all four combinations of role × decision-exists, and mutation-prove the absence assertions — this is role-gated, so the async-auth trap applies and a careless test will pass vacuously.
4. **Reject reason placement (#3, Q7).** Move `MakerPanel`'s rejection alert to the **top** of the expanded leg body, above the comparison table and the action bar. It stays visible (never hover), and nothing appears on a collapsed row.

- [ ] **Step 1: Write the failing tests** for all four.
- [ ] **Step 2: Run them; confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the compare suite, mutation-proving every absence assertion.**
- [ ] **Step 5: Typecheck and commit.**

---

## Task 4: Layout — table width and the generate button

**Files:** `apps/web/src/features/compare/ComparisonGridColumns.tsx`, `GenerateGate.tsx`, `CompareQuotesPage.tsx`, plus tests.

1. **Columnar table full width (#6).** The density pass set the table to `w-auto` so it sized to content, leaving space beside it. Restore full width with columns distributed evenly, and keep values centred under their headers — the alignment fix from that pass must survive. Do **not** modify `components/ui/table.tsx`; it is shared with seven other tables. The rows view is unaffected.
2. **Generate quotation (#5).** `GenerateGate` is a bordered card with a heading and a readiness line. Replace it with a right-aligned button placed after all legs. **Do not lose the information it carried**: the readiness state ("N of M legs approved") must remain discoverable — as the disabled button's accessible description or adjacent muted text — and the inline error must still surface. A bare disabled button with no reason is not acceptable.

- [ ] **Step 1: Write the failing tests** — including that the disabled reason is still reachable and the error still renders.
- [ ] **Step 2: Run them; confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the compare suite. Then verify visually** — start the dev server (`.claude/launch.json` has `web` on 5173; the api runs on 4000), log in as `exec@svyft.local` / `exec-dev-password`, open query `S56VIS-0001`, and check the columnar view fills the width with values centred under their headers. Report what you saw; if you cannot reach the screen, say so rather than claiming it looks right.
- [ ] **Step 5: Typecheck and commit.**

---

## Task 5: Gate and handoff

- [ ] **Step 1: Run the full gate.** `pnpm --filter @svyft/shared build`, then `set -a; . apps/api/.env; set +a; pnpm run ci`. Report the counts.
- [ ] **Step 2: Update `docs/Stage 5 - Session Handoff.md`** — an S5.9.2 entry recording: **Q1/Q2** (a re-quote now walks the leg back and the query follows; register **C7** is closed by this, so mark it closed); **Q3** and precisely how the send/approve guards now treat the override, since this is the third change to that guard and the previous two each shipped a defect; **Q5** and that it also closes the registered second wedge; **Q4**, **Q6**, **Q7**; and the deferred minors carried forward.
- [ ] **Step 3: Commit.**

---

## Self-review notes

- **Coverage:** #1 → T3.1 · #2 → T1 (Q1/Q2/Q4) · #2b → T1 (Q3) · #3 → T3.4 · #4 → **already working, no task** (`requestRequote` clears `shortlistedQuoteId` but not `recommendedQuoteId`, and the `⚑` is gated on `PENDING_APPROVAL`) · #5 → T4.2 · #6 → T4.1 · #7 → T2 · #8 → T3.3 · #9 → T3.2.
- **Ordering:** T1 → T2 are both `award.service.ts` and must run in order. T3 and T4 are frontend and independent of both, but T3 and T4 both touch the compare feature — run T3 first. T5 last.
- **The single highest-risk change is T1's guard widening.** That guard has now been rewritten three times, and each of the previous two shipped a defect the task-scoped review missed and the whole-branch review caught. Give it the most adversarial review of this sub-build, and specifically re-walk the A9 matrix afterwards.
- **The likeliest silent failure in T4** is satisfying "full width" by reintroducing `w-full` while losing the centring — the two tests must both survive, and the earlier round showed a hard-coded literal in the header can drift from the shared alignment source without any test noticing.
