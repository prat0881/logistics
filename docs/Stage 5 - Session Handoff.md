# Stage 5 — Session Handoff

_Last updated: 2026-08-19 (S5.6 + S5.7 + **S5.8 all COMPLETE and pushed**. PR #52 = 75 commits, CI green, mergeable. **All open points are consolidated in the register below** — start there.)_

## Current stage & branch
- **Stage 5 — Compare Quotes & Award.** Branch `feat/stage-5-fx-master` → **PR #52** (OPEN, **not merged** — you merge manually).
- PR #52 title: _"Stage 5 · S5.1–S5.8 complete — Compare Quotes, Award & Client Quotation"_ — **75 commits, CI green, mergeable/clean**. Tip: `bd0101e`.
- `pnpm run ci` **GREEN** at the tip: shared 383 · web 768 · api 91 suites / 408 tests · lint + typecheck + 3 builds clean. Hosted CI green on run `32183296721`.

## What's built (8 sub-builds, all on PR #52)
| SB | Scope | State |
| :-- | :-- | :-- |
| S5.1 | FX master (`FxRate` + `toUsd` + `fx-rates` module + `masters/fx-rates` screen) | ✅ merged into PR |
| S5.2 | Comparison engine + read model (`recommendOffer`, `GET …/comparison`) | ✅ |
| S5.3 | Status & decision foundations (enums, machine edges, `LegAwardDecision`/`AwardDecisionEvent`, `awardSnapshot`) | ✅ |
| **S5.4** | **Approval workflow endpoints** — shortlist / send-for-approval / approve / reject / generate-client-quote / reopen-comparison | ✅ delivered this session |
| **S5.5** | **Negotiation §10.1 + Change-order reversal §10.2** | ✅ delivered this session |
| **S5.6** | **Compare-Quotes frontend** (the screen per the mockup + FX admin) | ✅ COMPLETE — all 6 tasks, reviewed + final-review-fixed, ci green, visually verified, **pushed to PR #52** (`7b58a8d..354236e`) |
| **S5.7** | **Compare-Quotes UI/UX enhancements** (9 items, frontend-only) | ✅ COMPLETE — 6 tasks + final review + visual acceptance (`6c5f5d1..5f5c7bf`) |
| **S5.8** | **Client quotation** — margin, editable charges, preview, issue | ✅ COMPLETE — 6 tasks + final review + fix wave (`05d137b..b54a3ef`), ci green |

Every sub-build was built subagent-driven (TDD, per-task review + fix loops, **opus whole-branch review**). S5.4's reviews caught 5 real defects before merge; S5.5's caught the `StatusRegistry` init-order issue + the request-requote/`QUOTING_CLIENT` teardown seam. All findings fixed or adjudicated.

## Decisions made (why) — **please review**
- **S5.4 RBAC — generate = Manager+ ONLY, no four-eyes (your O4 call).** The design self-contradicted (§4/§11/§13 tables said four-eyes on generate; §16 O4 said no). You chose **O4**. Design doc §4/§11/§13/D9/§12/§15 all aligned to it. approve/reject keep four-eyes; generate is Manager+ only.
- **S5.5 D-A — single-leg re-quote resets the whole (query×FF) RFQ deadline.** `Rfq` is `@@unique([queryId, freightForwarderId])` (one RFQ covers all of an FF's legs on a query; no per-quote deadline). §10.1 says "reset that RFQ's deadline", so a re-quote on one leg extends the shared window for that FF's other open legs too. Accepted per the design's RFQ-level model.
- **S5.5 D-B — modified the delivered SB6 change-order subsystem** to cascade `APPROVED` quotes (`scope.resolver.ts` + `change-order.strategy.ts`). Required for §10.2 to fire at all (an approved leg was invisible to change-order before). Low blast radius (APPROVED post-dates SB6); full SB6 regression green.
- **S5.5 D-C — new `rfq.requote_requested` notification template** (rather than overloading `rfq.updated`, whose copy is "a leg was added").

## ⚠️ Vocabulary — read before touching any user-facing string

**Nothing in Stage 5 is *awarded*.** Design decision **D5** locks this: *"'Approved' is provisional; term 'Awarded' is reserved for Stage 6+"* — approval selects a forwarder for a leg **with no forwarder notification**, and stays reversible until the client wins. At the end of Stage 5: no forwarder has been told anything, and the client has not accepted.

| Say this | Not this | Because |
| :-- | :-- | :-- |
| **Approved** (a leg, provisionally) | Awarded | No FF has been notified; still reversible |
| **Quotation** (the stage, the screen) | Award | The step produces and issues a client quotation |
| **Issue** a quotation | Send | `LogTransport.send()` is a no-op — nothing is transmitted yet |
| **Quoting client / Awaiting client decision** | Won | The client hasn't accepted |

`LegStatus.AWARDED` exists in the enum but is **deliberately unreachable** — reserved for the post-Won execution phase. Internal backend names (`awardSnapshot`, `LegAwardDecision`, `award.service.ts`, `AwardModule`) keep "award" and that is fine; the design itself uses them. **The rule applies to user-visible strings.**

*This was caught by the product owner on 2026-08-19: the S5.8 stage rail said "Award" and linked to the quotation screen. Fixed in `ac424f1` (label and key are now "Quotation"). Recording it here so a fresh session doesn't reintroduce it.*

## 📋 Open points register — consolidated 2026-08-19

Everything still open across S5.4–S5.8, in one place so nothing is lost between sessions. Nothing here blocks merging PR #52.

### A · Business decisions — these need your answer, not engineering
| # | Question | Why it's open | Raised |
| :-- | :-- | :-- | :-- |
| **A1** | **What is a quotation "valid until"?** Currently the **earliest `validUntil` across the winning quotes** — never promising the client longer than the forwarders promised us. | No such field exists on the query or the award. The final review ruled the current rule correct, but it is the one commercial assumption made on your behalf. | S5.8 Q2 |
| **A2** | **How should charges be grouped for the client-facing breakdown?** | S5.7's charge dialog shows three rolled-up subtotals because the itemised lines never leave the server. Exposing them is easy; **which grouping** is a business call. Blocks B5. | S5.7 C2 |
| **A3** | **Is Reopen meant to be actionable?** `reopenComparison` deliberately leaves every decision `APPROVED`, so after a reopen there is **no path to revise a shortlist** — reject 409s and the reopen already happened. | Either Reopen should also reset decisions to `DRAFT`, or the UI should say plainly that it only unfreezes the snapshot. The misleading copy was fixed; the flow question stands. | S5.6 |
| **A4** | **Should the earlier price survive a re-quote that expires?** §10.1 promises the FF's earlier price "stays visible, badged stale", but the expiry sweep clears `draftJson`, so if the FF ignores the request the original offer is **lost** with no fallback. | Intended business rule, or a gap? | S5.5 |
| **A5** | **Should query status surface approval progress?** Shortlist → send → approve → every leg approved all happen **inside `QUOTED`** without the status changing once. | A query at `QUOTED` may have nothing shortlisted or be one click from a client quote. Cheapest fix isn't a new status — it's a "2 of 3 legs approved" indicator, and the data is already in the read model. | Status review |

### B · Backend follow-ups — bundle these into ONE API task
All are API-shape changes on the same feature. Four of them exist because S5.7 was constrained to frontend-only; doing them as four separate trips would be wasteful.

| # | Gap | Fix |
| :-- | :-- | :-- |
| **B1** | The **negotiate block at `PENDING_APPROVAL` is UI-only** — the server still accepts such a re-quote and resets the decision to `DRAFT`. Button and endpoint contradict each other. | Add a decision-status guard (409), or accept the reset and drop the UI restriction. |
| **B2** | **`sendForApproval` has no decision-status guard** — an `APPROVED` leg can be re-sent to `PENDING_APPROVAL`. Predates S5.6 (commit `03928dc`). | Guard on `decision.status`. |
| **B3** | **`send-for-approval` carries no offer identity** — the server trusts the persisted shortlist. S5.7 shrank the window from unbounded to a few-ms concurrent-maker race, but can't close it from the frontend. | Accept `{quoteId, variant}` and verify server-side, 409 on mismatch. |
| **B4** | **Multi-forwarder negotiate is not atomic** — N sequential calls, no transaction. A mid-batch failure leaves some forwarders asked and others not, with tokens already reissued and deadlines reset for the successes. | A bulk endpoint taking `{quoteIds[], notes}` in one transaction. |
| **B5** | **Itemised charges never leave the server** for the compare screen — `computeQuoteTotals` collapses them to three sums. *(S5.8 built its own server-side read path; this is the compare-screen half.)* | A grouping-neutral passthrough of the raw lines. **Blocked on A2.** |
| **B6** | **Wire `REQUOTED` into the change-order cascade.** A field edit on a leg whose only quote is `REQUOTED` free-paths, so the FF could re-quote against a stale basis. Reviewed as safe to defer. | New `REQUOTED→INVALIDATE→INVALID` edge. Background task `task_44674c1e`. |

### C · Known gaps and tech debt
| # | Item |
| :-- | :-- |
| **C1** | **Nothing is actually emailed.** `LogTransport.send()` is a no-op until `SmtpTransport` lands at the go-live gate. Issuing composes, records and advances status; no email reaches the client. Already a planned go-live item. |
| **C2** | **The quotation email subject is caller-supplied free text.** The body is safe by construction (one shared render call site; no path to cost, margin or forwarder names). The subject is the only opening — a deliberate envelope-editable decision that survives the SMTP gate. |
| **C3** | **Pre-existing Prisma drift.** Five earlier migrations hand-wrote `DEFAULT gen_random_uuid()` in raw SQL while `schema.prisma` uses client-side `@default(uuid())`, so every future `migrate dev` proposes 10 unrelated `ALTER COLUMN "id" DROP DEFAULT` statements. **Verified unchanged by S5.8, and all 33 migrations apply cleanly to a fresh DB.** Worth one dedicated cleanup migration. |
| **C4** | **Eight enum values are unreachable** — `WON`/`LOST`/`CLOSED`/`AWAITING_CLIENT_DECISION` were declared on the query (S5.8 now reaches the last of these); `AWARDED`/`IN_TRANSIT`/`DELIVERED`/`CLOSED` on the leg; `CLOSED` on the quote. Plus `AwardDecisionStatus.REJECTED`, which nothing writes (reject writes `DRAFT` + a reason). Stage 6–9 vocabulary declared early — harmless, but it makes the status picture look twice its real size. |
| **C5** | **The api e2e suite has an intermittent cross-test flake.** `award-generate.e2e-spec.ts` ("combinedUsd is re-rounded", float summation order) and `ff-portal-v3.e2e-spec.ts` have each failed once in a full `--runInBand` run and passed on every re-run and in isolation. Shared-DB state interactions, not defects. Hosted CI could hit either. |
| **C6** | **S5.8 has no visual pass.** Builder and preview are test-covered only. Worth eyeballing before it goes near a client. S5.6 and S5.7 were both verified live. |
| **C7** | **A re-quote is invisible at query level.** Asking a forwarder to revise a price on an already-`FULLY_QUOTED` leg moves neither the leg nor the query — there is no backward edge and the projector excludes re-quotes from "settled". The compare screen shows it; no status does. Related: a `REQUOTED` quote expiring on a `FULLY_QUOTED` leg fires no transition, so the query can read `QUOTED` while that leg holds only an `EXPIRED` quote. |

### D · Reviewed and sound — informational only
- **Terminology (D5) — corrected 2026-08-19.** The S5.8 stage rail labelled the quotation step "Award", violating a locked decision. Renamed label *and* internal key to "Quotation" (`ac424f1`); `LegStatus.AWARDED` and the backend's internal `award*` names deliberately untouched. See the Vocabulary section above.
- **`StatusRegistry.contribute()` is now module-init-order-independent** (`pending`-merge + an `OnApplicationBootstrap` orphan-key guard). Touches the Extensibility Core used by every domain module; the merge was proven correct for all orderings against the actual `@nestjs/core` scanner source. Flagged only because it is shared infra.
- **The two status reference views** built during the status alignment discussion — a technical one (four axes, what can coexist beneath a query status) and a business one (the full lifecycle, one line per transition) — are Claude artifacts, not in the repo. Regenerate from the code if needed; both were derived from source, not the design docs.

## Approaches that didn't work
- **S5.5 module-init ordering:** wiring `AwardModule → RfqModule` shifted NestJS's computed module-init "distance", flipping `RfqModule.contribute("leg")` ahead of `LegsModule.register(legMachine)`. Import-graph tweaks (e.g. `RfqModule` importing `LegsModule`) do **not** fix it (single-pass non-fixed-point DFS). Root-fixed in `StatusRegistry` instead (see item 4).
- **S5.4 generate winner-pricing:** cannot reuse `getComparison` for winners — `COMPARABLE_STATUSES = [QUOTED, REQUOTED]` excludes `APPROVED`, so approved winners vanish from the grid. Generate prices winners directly from each winning quote's immutable `draftJson`.

## S5.6 (Compare-Quotes frontend) — ✅ COMPLETE (6 of 6 tasks)
Plan: `docs/plans/stage-5/Stage 5 - S5.6 - Compare Quotes Frontend - Implementation Plan.md`. SDD ledger (full per-task detail + reviews): `.superpowers/sdd/Stage 5 - S5.6 …/progress.md`. Frontend-seam research: `scratchpad/s5.6-frontend-research.md`. Approved visual spec = mockup artifact `10b4cbc3-c713-4773-b8c5-00ea8289cec4` + design §12.

**⚠ Scope correction:** S5.6 is NOT pure-frontend as §15 implied — `GET …/comparison` didn't return the award decision / timeline / itemised charges the maker-checker UI needs. **Task 1 added them** (shared `AwardDecisionDto`/`AwardDecisionEventDto`/`OfferChargeLineDto` + `ComparisonService` join; NO DB migration — tables pre-existed).

**Done — ALL 6 TASKS, all reviewed. Commits `7b58a8d..354236e` (13 commits), pushed to PR #52:**
- **T1** `c87201f` — backend read-model extension (decision + timeline + itemised charges on `GET …/comparison`).
- **T2** `99ca41f`/`d0e4d52` — route `/queries/:id/compare` + `CompareQuotesPage` shell (reuses `QueryOverviewHeader` + `RouteDiagram` w/ a new `selectedLegId`/`onSelectLeg` channel + a single-open `CompareLegPanel`) + `StageRail` "Quotes" step wiring (`isQuotesStageEnabled` at `RFQ_SENT`+).
- **T3** `0b65db4`/`6c4c621` — read-only `ComparisonGrid` (`(FF×variant)` columns) + `RecommendationBanner` + click-FF `OfferDetail` + pending/awaiting. Unpriced offers greyed, never a fake `$0`.
- **T4** `58390ae`/`b2d12b3` — **maker controls**: shortlist radios (override-reason when ≠ recommendation) + send-for-approval (A9 proceed-without-waiting) + per-FF Negotiate dialog. Hooks in `useAwardActions.ts`.
- **T5** `a85bd80`/`93987f3` — **checker view**: `CheckerPanel` (Manager+, four-eyes-disabled when `sentByUserId === user.id`) + `GenerateGate` (Manager+, NO four-eyes per O4) + `DecisionTimeline` (all modes) + `useApprove`/`useReject`/`useGenerateClientQuote`.
- **T6** `0b516c8`/`513d22e` — **Quoting-Client end state**: `QuotingClientPanel` (per-leg winners + `combinedUsd` + FX-as-of + Reopen) + `useReopenComparison` + a single `locked` boolean that **unmounts** (not merely disables) Maker/Checker/Generate.
- **Final-review fix wave** `354236e` — see below.
- **`pnpm run ci` GREEN** at `354236e`: shared 366 · web 105 files/665 · api 90 suites/382 · lint + typecheck + 3 builds.

**⚠ Second scope correction (T6):** `Query.awardSnapshot` was unreachable from the frontend (neither `ComparisonDto` nor `QueryDetail` exposed it). Resolved by adding `awardSnapshot` — and later `forwarderNames` — to **`ComparisonDto`** (feature-scoped) rather than `QueryDetail` (wide, app-wide). No migration. The persisted `QueryAwardSnapshotLeg` type was deliberately left untouched so a read-time-only field never masquerades as stored.

### Final whole-sub-build review (opus): 1 Critical + 2 Important + 3 Minor — ALL fixed in `354236e`, re-reviewed clean
The per-task reviews were task-scoped; the broad review caught what they structurally could not:
- **C1 (Critical) — the T3×T4 seam.** `SendForApprovalSection` couldn't see the current pick, while a grid-header click silently re-points the shortlist radio. So: inspect another FF's charges → press Send without pressing Shortlist → **the server sends the previously-persisted offer, returns 200, and the checker approves the wrong forwarder, with no error anywhere.** Fixed with an `unsavedPick` guard (shared `offerKey` on both sides) enforced in `onSend` **and** `disabled`.
- **I1** — after a Reopen, `MakerPanel` told users to "reject or reopen it", both impossible for an `APPROVED` decision. Copy corrected (the underlying product question is open item 1 below).
- **I2** — nothing writes `REJECTED` (`reject()` writes `DRAFT` + `rejectionReason`), so a rejected leg's card read "Shortlisted" and the reason rendered nowhere in the app. Now an inline alert + a "Rejected — revise" chip; dead branches removed.
- **M1** — post-award the grid re-ranked the *losers* and displayed "Recommended: \<losing FF\>" directly above the award panel. `locked` now suppresses the badge + banner.
- **M2** stale REQUOTED offers were unlabelled in the shortlist radio; **M3** a latently-vacuous locked-state assertion.

### Visual verification — DONE (live dev server + seeded data)
Seed script (scratchpad, **not** in the repo; idempotent, `--cleanup`): `scratchpad/seed-compare-quotes.ts` → query **S56VIS-0001** `83d5770f-959b-4ccd-b18c-d353ee9ad2d9` (2 legs ROAD+SEA, 4 FFs, INR/AED/GBP + matching FX rows, no USD). Logins `exec@svyft.local`/`exec-dev-password`, `manager@svyft.local`/`manager-dev-password`.
Confirmed live: the full grid (6 `(FF×variant)` columns, USD+native, unpriced "—" never `$0`, REQUOTED stale badge, recommendation ring, pending/awaiting) in **light and dark**; the whole maker flow including **C1's guard releasing exactly when the shortlist persists**, and A9's proceed-without-waiting + reason; **RBAC live** (Executive sees no checker panel and no Generate gate; Manager sees both); the checker panel + `GenerateGate` disabled with "0 of 2 legs approved."; and inline `role="alert"` error surfacing proven against two real server guards.
**Not verified live: `QuotingClientPanel` + Reopen** — reaching it needs every leg `FULLY_QUOTED`, which requires SB5's expiry sweep; `award.service.ts:246-253` warns that hand-firing a bare EXPIRE strands SB5's `ScheduledEvents`, so it was not fabricated. Covered by unit tests + e2e.
**Note (pre-existing, app-wide, not S5.6):** dark mode is unreachable in the running app — `darkMode:["class"]` + `.dark` tokens exist, but nothing ever adds the class; there is no theme toggle.

**Parked minors (rulings in the S5.6 ledger; the final review triaged ALL as defer):** T1 M1 (1¢ per-line vs total rounding — `OfferDetail` shows the authoritative `usdTotal`, test-pinned), T2 M2 (`RANK.QUOTING_CLIENT=4` is spec-literal — do not key a new threshold off it), T3 #4/#5/#6 (REQUOTED wording / `money.ts` DRY / aria-controls), T4 M3 (RHF override text persists across picks — harmless now C1's guard exists), T5 M3 (CheckerPanel-self-gates vs GenerateGate-parent-gates — independently re-confirmed correct), T6 (locking-test file placement). The FX-admin screen (§12) **already exists** from S5.1.

**Pushed to PR #52 on 2026-08-17** (fast-forward `fb4935b..33cc0b5`); PR title + body updated to cover S5.6; CI green. Open items 5 and 6 above remain for you.

## S5.7 (Compare-Quotes UI/UX enhancements) — ✅ COMPLETE
Nine enhancements against the delivered S5.6 screen. Built subagent-driven (6 tasks, TDD, per-task review + fix loops, **opus whole-sub-build review**), then visually accepted live. Commits `6c5f5d1..5f5c7bf` (11).
- **Design of record:** `docs/Stage 5 - Compare Quotes UI Enhancements - Design.md`
- **Implementation plan (SDD, 6 tasks):** `docs/plans/stage-5/Stage 5 - S5.7 - Compare Quotes UI Enhancements - Implementation Plan.md`
- **Mockups** (kept, git-ignored): `.superpowers/brainstorm/62958-*/content/` — grid orientations, charge groupings, page structures, dialogs.

**🔴 Hard constraint: FRONTEND ONLY** (requester's call). No api / `packages/shared` / prisma changes.

| # | Item | Decision |
| :-- | :-- | :-- |
| 1 | Tabular grid, FF's variants grouped | **Both orientations, user-switchable** (`localStorage`), explicit FF separator |
| 2 | Charge breakdown parent→child pop-up | UI-only against the 3 existing lines; component built tree-shaped for later |
| 3 | Recommended by colour | Tint + badge; **`RecommendationBanner` deleted**, reason moves to a tooltip |
| 4 | Shortlist in-grid → send-for-approval pop-up | **Merged into ONE dialog** |
| 5 | No Negotiate once sent for approval | Disabled with a visible reason |
| 6 | Leg-level multi-FF Negotiate | Shared note + optional per-FF notes; eligibility per FF |
| 7 | Less scrolling | **No structural change** — legs stay stacked, one open; diagram-click already works (T2) |
| 8 | Exec view aligned | Same screen, both roles tested explicitly |
| 9 | Conversion rate shown | `OfferDto.unitsPerUsd` — already in the payload |

**Notable:** item 4's merge **structurally eliminates** the Critical the S5.6 whole-sub-build review caught (picked offer and persisted shortlist could drift). The `unsavedPick` guard added in `354236e` becomes unreachable and is removed — **its regression tests are ported, not deleted** (plan Task 4 Step 5).

### 🔶 Consequences of the frontend-only constraint — now tracked as B1–B5 in the register
Three real gaps, accepted deliberately. Full detail in the design doc's "Consequences" section.
1. **C1 — item 5 is a UI convention, not a rule.** `AwardService.requestRequote` still accepts a re-quote on a `PENDING_APPROVAL` leg and resets the decision to `DRAFT`. The button is disabled; the endpoint is not. *Follow-up:* add a decision-status guard (409), or accept the reset and drop the UI restriction — the two currently contradict each other.
2. **C2 — item 2 shows subtotals, not a breakdown.** `buildCharges` emits only 3 flat aggregates (`Freight`, `Additional Charges` = ONE sum over all origin/destination/ad-hoc lines, `Warehousing` = ONE sum). The itemised detail exists in each quote's `draftJson` (`charges[]` w/ zone+label+amount+note, `trucking[]`, `seaRates[]`, `warehouse[]`) but `computeQuoteTotals` returns only sums. *Follow-up:* a grouping-neutral read-model passthrough of the raw lines, letting the UI group them once business confirms. Business has NOT yet confirmed the grouping — that's why this is deferred.
3. **C4 (NEW, from T4) — `send-for-approval` carries no offer identity.** The endpoint takes no body identifying the offer; the server sends whatever the leg's **persisted** shortlist is. The merged dialog re-writes the shortlist immediately before sending, so exposure shrank from unbounded (S5.6) to a few-ms gap **and** now needs a second maker on the same leg concurrently. Assessed **Low**. *Follow-up:* accept `{quoteId, variant}` and verify server-side.
4. **C3 — multi-FF negotiate is not atomic.** N forwarders = N sequential `request-requote` calls, no transaction. A mid-batch failure leaves some asked and some not, and each success has already reissued that FF's portal token and reset their RFQ deadline — not rolled back. The dialog surfaces a per-FF result list rather than hiding it. *Follow-up:* a bulk endpoint taking `{quoteIds[], notes}` in one transaction.

### Outcome
- **`pnpm run ci` GREEN** at `5f5c7bf`: lint + typecheck × 3 workspaces · shared 24 files · web 110 files / 736 tests · api 90 suites / 382 tests · 3 builds.
- **The frontend-only constraint held on EVERY commit** — `git diff --stat 6c5f5d1..5f5c7bf -- apps/api packages/shared prisma` is empty. Verified after each task, not just at the end.
- **Visually verified live** (seeded query `S56VIS-0001`), Executive **and** Manager, **both** grid orientations: route-diagram click opens the leg; FF grouping rules; tinted recommended column/row with the reason on the badge; `Rate (per USD)`; Select→merged dialog with the full four-value summary; leg-level Negotiate listing each forwarder's price + status with ineligible ones genuinely `disabled`; Negotiate blocked at `PENDING_APPROVAL`; Executive sees no checker panel or Generate gate, Manager sees both with Approve/Reject enabled; view-mode preference survived a logout/login as a different role.
- **One defect found by the visual pass alone** and fixed in `5f5c7bf`: `MakerPanel` rendered an **empty bordered card** on every plain `DRAFT` leg (Tasks 4 and 5 removed everything it held, but the container still rendered). No reviewer could catch it — the DOM node was present and nothing asserted on emptiness.

### What the reviews caught (worth knowing — the pattern repeated)
Almost every finding this run was **missing coverage, not broken code**: the implementation verified correct, but nothing would have noticed if it stopped being. Reviewers found them by deleting production code and watching the suite stay green — the rows-view stale badge, the rows-view unpriced guard, `overrideReason` reaching the wire, the send-side error alert, and the negotiate retry-narrowing. Every fix was therefore required to be **mutation-proven**, and the final review found the view-mode desync (item #1) precisely *because* its test had been shaped so it could never fail. Full detail in the SDD ledger.

**Notable:** merging shortlist + send (#4) **structurally eliminated** the Critical S5.6's final review had caught — the drift between the grid's live pick and the persisted shortlist that could award the wrong forwarder silently. Two independent reviewers traced it and confirmed it is now unreachable, not merely guarded; the `unsavedPick` guard was removed and its regression coverage **ported, not deleted**.

**⚠ Observed once, not reproduced:** `award-generate.e2e-spec.ts`'s "combinedUsd is re-rounded" test failed in a single full-suite run, then passed 5/5 on re-runs (isolated and whole-file) and in two subsequent full `ci` runs. Its `rawSum` assertion depends on float summation **order** over `snapshot.legs`. Stage-5 backend, untouched by S5.7 — flagged in case hosted CI ever hits it.

## S5.8 (Client quotation) — ✅ COMPLETE
Pulled forward from Stage 6 at the requester's direction (*"We will finish all the quotations in Stage 5"*). Design: `docs/Stage 5 - Client Quotation - Design.md`. Plan + SDD ledger: `docs/plans/stage-5/Stage 5 - S5.8 …` and `.superpowers/sdd/Stage 5 - S5.8 …/progress.md`. Mockups: `.superpowers/brainstorm/1145-*/content/`.

**What it does.** Once every leg is approved and the award frozen, a Manager opens `/queries/:id/quotation`: a margin % marks up every charge line (markup on cost — `cost × (1 + m/100)`, **not** `cost ÷ (1 − m)`), individual lines can be hand-adjusted and are pinned as overrides, and the quotation is previewed and issued. Issuing freezes a snapshot, renders the client email **server-side**, and moves the query to `AWAITING_CLIENT_DECISION` — wiring up one of the four query statuses that were previously declared but unreachable.

**The client sees the grand total only** — no charge lines, no per-leg totals, no cost, no margin, no forwarder names. Their own enquiry particulars are echoed back instead of our route/scope. That rule is enforced by server-side template rendering, not by the UI.

**Locked decisions:** markup on cost · one margin applied per line with pinned overrides · grand total only · no PDF (removed by that decision) · saved draft, versioned on each issue · USD · Manager+.

### Open items
All of S5.8's open points are folded into the **register at the top of this document** — A1 (quotation validity, the one commercial assumption made on your behalf), C1 (no SMTP delivery), C2 (subject is free text), C3 (Prisma drift), C5 (api e2e flake) and C6 (no visual pass). Nothing S5.8-specific lives only here.

### What the final review caught
Three Criticals invisible inside any single task's diff: **calc charges pricing at $0** (client quoted below our own cost, silently), **no entry point to the builder** (reachable only by typing the URL), and **reopen → re-award → permanent 409**. Plus a UI/server contradiction where a pinned price could be silently unpinned by clicking in and tabbing out — with the test suite encoding that divergence as required. Detail in the ledger.

## Reusable facts (learned across S5.4/S5.5 SDD)
- Caller id = `user.userId` (`RequestUser`); e2e actor `@db.Uuid` cols need cookie `sub: randomUUID()`.
- Every owned status change via `StatusService.fire` (awaits `emitAsync` → projectors run in-fire → **every new `@OnEvent` listener MUST try/catch+log** or it fails the caller). Query status is a projection (never `fire`d).
- Clear a `Json?` column with **`Prisma.DbNull`** (plain `null` sets JSON-null, still truthy).
- Local Postgres :5433 (`svyft-postgres-task4`); `set -a; . apps/api/.env; set +a` before prisma/jest.
- Rebuild `@svyft/shared` after editing it; run `pnpm run typecheck` per task (vitest/jest don't type-check).
