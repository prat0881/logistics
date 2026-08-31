# Stage 5 · S5.5 — Negotiation / Re-quote & Change-Order Reversal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) tracking. Design of record: [`docs/Stage 5 - Compare Quotes - Design.md`](../../Stage%205%20-%20Compare%20Quotes%20-%20Design.md) §8.1, §9-step2, **§10.1 (negotiation)**, **§10.2 (change-order reversal)**, §11, §13-A9. Builds on **S5.4** (the maker-checker endpoints + `LegAwardDecision`/`AwardDecisionEvent` + `Query.awardSnapshot` + generate/reopen) and **S5.3** (all the machine edges — they already exist, see below). Research digest with exact code seams: `scratchpad/s5.5-research.md`.

**Goal:** Close the two live-negotiation loops left open by S5.4: (1) an Executive can **request a re-quote** from a single FF (per-leg, per-quote), which reopens that FF's portal with its earlier price, resets the RFQ window, and reverts the leg's award decision to DRAFT; and (2) a **post-award change-order** (SB6 field edit) that reopens a leg automatically **reverses** any award on it — resetting the `LegAwardDecision` and dropping the query out of `QUOTING_CLIENT`.

**Architecture:** All the S5.3 status edges already exist (`award.module.ts` — quote `QUOTED|APPROVED→REQUOTED→QUOTED/EXPIRED`, `APPROVED→INVALIDATE→INVALID`; leg `APPROVED→REOPEN_AWARD→FULLY_QUOTED`, `APPROVED→REOPEN→READY_FOR_RFQ`). S5.5 is the CALLERS + two integration gaps: a new `NegotiationService`/route (§10.1) reusing the existing RFQ token-reissue + deadline-reset + notification machinery; and a new `AwardChangeOrderListener` on the already-emitted `changeorder.leg.reopened` event (§10.2), plus the SB6 change-order classification fix that makes that event fire for approved legs at all. Every status change flows through `StatusService.fire`; decision state stays on `LegAwardDecision` + `AwardDecisionEvent`; the query status stays a projection.

**Tech stack:** NestJS + Prisma/Postgres (`apps/api`), pure-TS + Zod (`packages/shared`). Node ≥20<21, pnpm 9.12.0. e2e = jest against real Postgres (:5433) `--runInBand`.

## Global Constraints

- **RBAC (design §4):** `request-requote` = **Executive+** (auth-only, no `@Roles` — it's a maker action, same tier as shortlist/send/reopen). The change-order reversal listener is system-internal (no route). FF-portal submit stays `@Public()` + token-guarded.
- **The ONE door:** every owned status change goes through `StatusService.fire(key, entityId, event, ctx)` with `ctx.reason` where a reason applies. No ad-hoc `prisma.quote/leg.update({status})`.
- **Listener safety (load-bearing):** `StatusService.fire` (`status.service.ts:101`) does `await emitAsync(...)`, and the emitter uses default options — an uncaught throw inside ANY `@OnEvent` listener propagates back into the awaiting `fire()`/`emitAsync` and would fail the CALLER (e.g. `ChangeOrderStrategy`'s own fires). **Every new `@OnEvent` handler MUST wrap its body in `try { … } catch (err) { this.logger.error(…) }`** — mirror `LegQuoteProjector.onQuoteStatusChanged` / `QueryStatusProjector.onLegStatusChanged` / `RfqNotificationsService.onLegReopened`.
- **Caller id** = `user.userId` on `RequestUser`. e2e writing `@db.Uuid` actor columns needs cookie `sub: randomUUID()`.
- **Rebuild `@svyft/shared`** after editing it (`pnpm --filter @svyft/shared build`); vitest/jest transpile but don't type-check → run `pnpm run typecheck` per task.
- **DB env** for prisma/jest shells: `set -a; . apps/api/.env; set +a` (Postgres :5433, container `svyft-postgres-task4`).

## ⚠ Decisions made autonomously (flag for user review — the design supports each)
- **D-A (RFQ-level deadline reset, §10.1):** `Rfq` is `@@unique([queryId, freightForwarderId])` — one RFQ covers ALL of an FF's legs on a query. §10.1 says "reset that RFQ's `submissionDeadline` + re-arm the reminder/expiry `ScheduledEvent`s", so a single-leg re-quote resets the shared RFQ window for **every** leg that FF still holds on the query. This follows the design's RFQ-level model (there is no per-quote deadline column). Accepted; flagged.
- **D-B (SB6 change-order now includes `APPROVED`, §10.2):** SB6's `ScopeResolver.downstreamWork` + `ChangeOrderStrategy` currently classify only `RFQ_SENT`/`QUOTED` quotes as live, so a post-RFQ edit on an **approved** leg silently takes the free path and never reverses the award. §10.2's premise ("SB6 invalidates a quote when a field edit reopens a leg") is only true once `APPROVED` is added. Task 3 makes this change to the delivered SB6 subsystem (low blast radius — `APPROVED` didn't exist when SB6 was built/tested). Flagged.
- **D-C (re-quote notification):** carry the negotiation comment on a re-quote notification. Reuse the existing `NotificationDispatcher` + seed a dedicated `rfq.requote_requested` template (rather than overloading `rfq.updated`, whose copy is "a leg was added"). Flagged.

---

## Task 1 — REQUOTED round-trip foundations (FF-portal submit + expiry sweep)

**Files:**
- Modify `apps/api/src/modules/ff-portal/ff-portal.service.ts` (`submit`, ~line 260).
- Modify `apps/api/src/modules/rfq/rfq-schedule.listener.ts` (`onExpiry`, ~line 52-68).
- Test: extend `apps/api/test/ff-portal.e2e-spec.ts` (or a focused new spec) + a scheduled-expiry spec.

**Interfaces / Produces:** the FF portal accepts a submit from a `REQUOTED` quote (→`QUOTED`); the expiry sweep transitions overdue `REQUOTED` quotes (→`EXPIRED`). Consumed by Task 2 (a re-quote puts a quote into `REQUOTED`; the FF re-submits or it expires).

**Logic:**
- `FfPortalService.submit`: change the guard `if (q.status !== "RFQ_SENT")` → `if (q.status !== "RFQ_SENT" && q.status !== QuoteStatus.REQUOTED)`. Nothing else changes — the `fire("quote", q.id, QuoteEvent.SUBMIT, …)` already resolves `REQUOTED→QUOTED` via the S5.3 edge (`findTransition` picks by `(from,event)`), and the materialize path overwrites `draftJson` with the revised price automatically. GET/`saveDraft` already work for REQUOTED (no status guard).
- `RfqScheduleListener.onExpiry`: its quote query (`where: { rfqId, status: QuoteStatus.RFQ_SENT }`) must ALSO sweep `REQUOTED` → `status: { in: [QuoteStatus.RFQ_SENT, QuoteStatus.REQUOTED] }`. Both fire `QuoteEvent.EXPIRE` (edges `RFQ_SENT→EXPIRED` and `REQUOTED→EXPIRED` both exist).

**Steps (TDD):** (1) failing e2e — seed a leg with a `REQUOTED` quote (directly, per `award-workflow-maker`'s `FfSpec.status: "REQUOTED"`), submit via the portal token → 201/`QUOTED`; and a scheduled-expiry test that a past-due `REQUOTED` quote sweeps to `EXPIRED`. (2) RED. (3) implement the two edits. (4) GREEN + regressions (`ff-portal*.e2e`, `rfq-schedule*`) + lint + typecheck. (5) commit `feat(stage5): FF-portal accepts REQUOTED submit + expiry sweeps REQUOTED`.

---

## Task 2 — `request-requote` endpoint (§10.1, the negotiation core)

**Files:**
- Create `packages/shared/src/negotiation.ts` (or add to `award.ts`): `requestRequoteSchema = z.object({ comment: z.string().trim().min(1).max(2000) })` + `RequestRequoteInput`. Re-export from `packages/shared/src/index.ts`.
- Create `apps/api/src/modules/award/negotiation.service.ts` (`NegotiationService`) + add a route to `apps/api/src/modules/award/award.controller.ts` (or a small `NegotiationController`).
- Wire deps in `award.module.ts` (import `RfqModule` — add `RfqService` to `RfqModule`'s `exports`; import `CommsModule` for `ScheduledEventService`/`NotificationDispatcher` if not already reachable).
- Seed a template: `apps/api/src/seed/message-templates.seed.ts` — add a `rfq.requote_requested` EMAIL (+ optional IN_APP) row with a `{{Comment}}`/`{{RFQ_Number}}` token (mirror the `rfq.leg.reopened` free-text `{{reason}}` precedent).
- Test: new `apps/api/test/award-requote.e2e-spec.ts`.

**Produces:** `POST /api/queries/:id/legs/:legId/quotes/:quoteId/request-requote` (Executive+), body `{ comment }`.

**Service logic (`requestRequote(queryId, legId, quoteId, input, user)`), in one flow:**
1. Validate ownership + state: the quote belongs to `(queryId, legId)` and is `QUOTED` or `APPROVED` (else 404/409). Load its `rfqId` + `freightForwarderId`.
2. `fire("quote", quoteId, QuoteEvent.REQUEST_REQUOTE, { queryId, actorId: user.userId, reason: input.comment })` → `REQUOTED`. **Retain `draftJson`** (do NOT clear it — the earlier price must stay visible; the fire's effect must not wipe it).
3. **Reset the leg's `LegAwardDecision` → DRAFT** (clear `shortlistedQuoteId`/`shortlistedVariant`/`sentByUserId`/`decidedByUserId`/`decidedAt`/`rejectionReason`). If the leg was `APPROVED`, also `fire("leg", legId, LegEvent.REOPEN_AWARD, { queryId, actorId })` → `FULLY_QUOTED` (the basis changed). Write `AwardDecisionEvent{ type:"REQUEST_REQUOTE", quoteId, reason: input.comment, actorId }`.
4. **Reissue the FF portal token** — reuse `RfqService.reissueToken(queryId, freightForwarderId, user)` (mints a fresh `accessTokenHash` + audit `RfqTokenReissue`; returns `{ accessToken }`).
5. **Reset the RFQ deadline + re-arm ScheduledEvents** (copy the `RfqService.performDistribution` reactivation pattern, `rfq.service.ts:394-517`): compute a fresh deadline (`resolveDeadline()` semantics — now + `rfqDeadlineHours`), `rfq.update({ submissionDeadline })`, `scheduledEvent.deleteMany({ entityType:"RFQ", entityId: rfqId, eventKey:{ in:["rfq.reminder","rfq.expiry"] } })`, then `scheduled.schedule("RFQ", rfqId, "rfq.reminder", …offsets)` + `.schedule("RFQ", rfqId, "rfq.expiry", [{tier:"DEADLINE", dueAt: deadline}])`. (Prefer exposing a reusable method on `RfqService` for the deadline-reset+re-arm rather than duplicating; if that's too invasive, inline it in `NegotiationService` with a comment pointing at the precedent.) **See D-A: this resets the whole (query×FF) RFQ window.**
6. **Notify the FF** — `NotificationDispatcher.dispatch("rfq.requote_requested", { scope:{entityType:"RFQ", entityId: rfqId}, tokens:{ RFQ_Number, Comment: input.comment, … }, recipients:{ EMAIL:[ff email] }, tenantId })`, with the portal link built from the reissued token (`${PORTAL_BASE_URL}/ff/rfq/${accessToken}`).
7. Return the updated quote/decision (+ maybe the reissued link for the caller).

**Steps (TDD):** (1) failing e2e — an APPROVED-leg quote → request-requote → assert quote `REQUOTED` (draftJson retained), `LegAwardDecision` `DRAFT` (shortlist cleared), leg `FULLY_QUOTED`, `accessTokenHash` rotated, `submissionDeadline` moved forward, fresh `rfq.reminder`/`rfq.expiry` ScheduledEvents, a `rfq.requote_requested` MessageLog with the comment, an `AwardDecisionEvent{REQUEST_REQUOTE}`; a QUOTED-leg quote → REQUOTED (no leg reopen needed); missing comment → 400; wrong quote/leg/query → 404. (2) RED. (3) implement schema + service + controller + wiring + template seed. (4) GREEN + regressions + FULL typecheck (touched shared). (5) commit `feat(stage5): request-requote endpoint (negotiation §10.1)`.

---

## Task 3 — SB6 change-order includes `APPROVED` (§10.2 prerequisite) ⚠ touches SB6

**Files:**
- Modify `apps/api/src/modules/changes/scope.resolver.ts` (`downstreamWork`, ~line 29).
- Modify `apps/api/src/modules/changes/change-order.strategy.ts` (the live-quotes query, ~line 70).
- Test: extend `apps/api/test/change-mediator.e2e-spec.ts` + `change-order-cascade.e2e-spec.ts`.

**Logic:** both quote queries currently use `status: { in: [QuoteStatus.RFQ_SENT, QuoteStatus.QUOTED] }`. Add `QuoteStatus.APPROVED` to both, and ensure `ChangeOrderStrategy` classifies an `APPROVED` quote into the **invalidating** set (so it fires `QuoteEvent.INVALIDATE` → `APPROVED→INVALID`, which already exists) alongside the leg `REOPEN` it already fires. Verify the "refreshing" (`draftJson`-clear) branch and the `ChangeLog`/manifest re-freeze behave sensibly for an APPROVED quote (it should be invalidated, not merely refreshed).

**Why:** without this, a post-award field edit on an approved leg takes the FREE path — no invalidation, no `changeorder.leg.reopened`, so Task 4's reversal never triggers. This is the gap that makes §10.2 real. **⚠ Behavior change to the delivered SB6 change-order subsystem — flag prominently in the task review + the whole-branch review.**

**Steps (TDD):** (1) failing test — an edit whose only affected leg has an `APPROVED` quote now (a) resolves `downstreamWork === true` and (b) forks to the change-order path, invalidating the approved quote (`INVALID`) and reopening the leg; assert via `change-mediator.e2e` (direct `mediator.apply`, no `downstreamWork` mock) + `change-order-cascade.e2e` (HTTP + `changeorder.leg.reopened` side-effect). (2) RED. (3) add `APPROVED`. (4) GREEN + ALL change-order/SB6 regressions green (this is the risk surface — run them all). (5) commit `fix(stage5): change-order cascade covers APPROVED quotes (§10.2 prereq)`.

---

## Task 4 — change-order reversal listener + `QUOTING_CLIENT` teardown (§10.2)

**Files:**
- Create `apps/api/src/modules/award/award-change-order.listener.ts` (`AwardChangeOrderListener`), register in `award.module.ts` `providers`.
- Test: new `apps/api/test/award-reversal.e2e-spec.ts`.

**Produces:** on `changeorder.leg.reopened`, the award state for each affected leg is reversed.

**Logic (`@OnEvent("changeorder.leg.reopened") async onLegReopened(event: ChangeOrderReopenedEvent)`), wrapped in try/catch+log:**
- The event's `perFf[].legIds` are the reopened legs (the leg `REOPEN`/`REOPEN_AWARD` + quote `INVALIDATE` fires have ALREADY landed by the time this fires — do NOT re-fire them). For each affected `legId`:
  - Reset its `LegAwardDecision` → `DRAFT` if one exists (clear `shortlistedQuoteId`/`Variant`/`sentByUserId`/`decidedByUserId`/`decidedAt`/`rejectionReason`); write `AwardDecisionEvent{ type:"REOPEN", queryId, legId, reason: event.reason, actorId: null }` (system action).
- **QUOTING_CLIENT teardown:** if the query's `awardSnapshot` is non-null (it was generated), clear it exactly as `reopenComparison` does — `tx.query.update({ data: { awardSnapshot: Prisma.DbNull } })` + `QueryStatusProjector.recompute(queryId, tx)` — so the query drops out of `QUOTING_CLIENT` (it will roll to the reopened leg's rollup, which is now `READY_FOR_RFQ` → the query needs re-distribution). Do the decision resets + the snapshot clear in one `$transaction`, then `recompute` inside it.
- `QueryStatusProjector` is already injected-available in the award module (StatusModule exports it; `AwardService` uses it).

**Steps (TDD):** (1) failing e2e — build a fully-approved+generated query (`QUOTING_CLIENT`, `awardSnapshot` set), trigger a change-order field edit that reopens a leg (drive the real change-order path, which Task 3 now makes fire for the approved leg), then assert: the leg's `LegAwardDecision.status === "DRAFT"` (shortlist cleared), an `AwardDecisionEvent{REOPEN}`, `Query.awardSnapshot === null`, `Query.status` dropped out of `QUOTING_CLIENT` (to the reopened-leg rollup). (2) RED. (3) implement the listener. (4) GREEN + regressions (award specs, change-order specs) + FULL `pnpm run ci`. (5) commit `feat(stage5): change-order reversal of awards (§10.2)`.

### S5.5 acceptance
- [ ] `pnpm run ci` green → opus whole-branch review (with the SB6 change flagged) → push to PR #52.

---

## Self-review (against §10)
- **§10.1 coverage:** request-requote fires `REQUEST_REQUOTE`, retains draftJson, resets decision→DRAFT (+ leg REOPEN_AWARD if approved), reissues token, resets deadline + re-arms, notifies with comment, audits → Task 2; the FF re-submit `REQUOTED→QUOTED` + REQUOTED expiry → Task 1. ✅
- **§10.2 coverage:** the reversal listener resets the decision + tears down QUOTING_CLIENT → Task 4; the SB6 classification fix that makes it fire → Task 3. ✅
- **Edges:** all consumed edges already exist (S5.3); no `*.machine.ts` edits, no new migration.
- **Carry-forwards NOT in S5.5:** the deadline-passed-partial approve completion (needs the general expiry sweep to close stragglers → FULLY_QUOTED — related to Task 1's expiry work but scoped to REQUOTED here) and the `OUTSTANDING_QUOTE_STATUSES` shared-const extraction remain minor follow-ups; note them for the whole-branch review.
- **Open flags for user:** D-A (RFQ-level deadline reset cross-leg effect), D-B (SB6 now cascades APPROVED), D-C (new re-quote notification template).
