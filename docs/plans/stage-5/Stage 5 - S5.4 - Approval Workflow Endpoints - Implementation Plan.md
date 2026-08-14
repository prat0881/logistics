# Stage 5 · S5.4 — Approval Workflow Endpoints — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax.
>
> Design of record: [`docs/Stage 5 - Compare Quotes - Design.md`](../../Stage%205%20-%20Compare%20Quotes%20-%20Design.md) §4 (RBAC/four-eyes), §9 (workflow), §11 (endpoints), §13 (A1–A9). Master plan: [`Stage 5 - Implementation Plan.md`](Stage%205%20-%20Implementation%20Plan.md). Builds directly on **S5.3** (the machine edges, `reason`, the decision tables) and **S5.2** (the comparison read model / recommendation).

**Goal:** The internal maker-checker HTTP surface: **shortlist → send-for-approval → approve/reject → generate → reopen**, firing S5.3's edges through the one `StatusService.fire` door, writing `LegAwardDecision`/`AwardDecisionEvent`, enforcing the Manager+ four-eyes gate and validations A1–A9, and rolling the query to `Quoting Client`.

**Architecture:** One `AwardService` orchestrating the decision state + the fires + the `QueryStatusProjector` rollup; one `AwardController` (mirrors the masters pattern). Ordering is enforced **at the service level** (S5.3 note: the machine edges have no guards). Two small foundations from S5.3's review land first (the four-eyes helper + the projector's resolved-set fix).

**Tech Stack:** NestJS + Prisma (`apps/api`), Zod (`packages/shared`).

## Global Constraints

_Inherits the master plan's constraints (the `pnpm run ci` gate; e2e `await app.close()` + `seedReferenceData` + namespaced rows + `sub: randomUUID()`; caller id = `user.userId`; the Prisma CLI needs `set -a; . apps/api/.env; set +a`). Plus, specific to S5.4:_

- **RBAC (design §4):** maker routes (shortlist / send-for-approval / reopen) = **Executive+** (auth-only, no `@Roles`). Checker routes (approve / reject / generate) = **`@Roles(Role.ADMINISTRATOR, Role.MANAGER)`** AND **≠ the leg's `sentByUserId`** (four-eyes) — the four-eyes is a **service-level** check throwing `403 SELF_APPROVAL` (a guard can't easily load the leg's decision).
- **Every status change goes through `StatusService.fire`** (never `tx.quote.update({status})`); pass `{ queryId, actorId, reason }` in the `FireContext`. Fire runs its own tx — call it AFTER the decision `$transaction`, or pass `ctx.tx` if you need it inside one (follow the existing rfq.service pattern).
- **Validation A1–A9 (design §13):** surface as blocking `Finding[]` (the shared `Finding` shape `{rule, severity, scope, message}`) → the controller returns `400 {message, issues}` (Zod pipe) or a domain `400/403/409`. A stale offer (no longer `QUOTED`/current) → `409`; a self-approval → `403 SELF_APPROVAL`.
- **Ordering enforced in the service** (S5.3 input): e.g. approve requires the leg's decision `PENDING_APPROVAL` + the shortlisted quote still `QUOTED`; send requires the leg `FULLY_QUOTED` or deadline passed. Do NOT rely on machine guards.
- **`QuotingClient` rollup:** `generate` writes `Query.awardSnapshot` and drives the query to `QUOTING_CLIENT` via `QueryStatusProjector` reading the snapshot as the `quotingClient` milestone; `reopen` clears it. (Task 4 details the exact wiring — read `query-status.projector.ts` first.)

## File-Structure Map

| File | Responsibility |
| :-- | :-- |
| `packages/shared/src/award.ts` (extend) | Request schemas (`shortlistSchema`, `sendForApprovalSchema`, `rejectSchema`) + the A1–A9 rule keys |
| `apps/api/src/modules/rfq/leg-quote.projector.ts` (modify) | Add `APPROVED` to `RESOLVED` (+ REQUOTED handling) — S5.3 input (b) |
| `apps/api/src/modules/award/award.service.ts` | The decision orchestration (shortlist/send/approve/reject/generate/reopen) + four-eyes + A1–A9 |
| `apps/api/src/modules/award/award.controller.ts` | The 6 routes under `queries/:id` |
| `apps/api/src/modules/award/award.module.ts` (extend the S5.3 module) | Provide/wire the service + controller |
| `apps/api/test/award-workflow.e2e-spec.ts` | The full maker-checker loop e2e |

---

## Task 1 — foundations: request schemas + four-eyes helper + projector resolved-set fix

**Interfaces — Produces:** `shortlistSchema`/`sendForApprovalSchema`/`rejectSchema` + inferred input types; `LegQuoteProjector` treating `APPROVED` as resolved.

- [ ] **Step 1: shared request schemas** — extend `packages/shared/src/award.ts`:
```ts
import { z } from "zod";
import { CHARGE_RATE_VARIANTS } from "./quote";
export const shortlistSchema = z.object({
  quoteId: z.string().uuid(),
  variant: z.enum(CHARGE_RATE_VARIANTS).nullable(),
  overrideReason: z.string().trim().min(1).max(2000).optional(), // required at send if shortlist ≠ recommendation (A2)
});
export const sendForApprovalSchema = z.object({
  proceedWithoutWaiting: z.boolean().optional(), // A9 override when the leg has an in-flight re-quote
  proceedReason: z.string().trim().min(1).max(2000).optional(),
});
export const rejectSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export type ShortlistInput = z.infer<typeof shortlistSchema>;
export type SendForApprovalInput = z.infer<typeof sendForApprovalSchema>;
export type RejectInput = z.infer<typeof rejectSchema>;
```
Re-export is automatic (`award.ts` is already re-exported). Add a `toEqual` pin test only if you add a new enum; these schemas are covered by Task 2–4 e2e.
- [ ] **Step 2: projector resolved-set** — write a failing test then fix `apps/api/src/modules/rfq/leg-quote.projector.ts`. Read the file: `RESOLVED = [QUOTED, EXPIRED, CLOSED]` (line 9) is the set that counts a quote as "done" for the leg rollup. **Add `APPROVED`** so approving a quote does NOT regress the leg from `FULLY_QUOTED`. (Leave `REQUOTED` OUT — a re-quote in flight is genuinely not resolved; but confirm the rollup's `RFQ_SENT`/`PARTIALLY_QUOTED` conditions don't mis-fire on a `REQUOTED` quote — add a focused test for a leg with one `APPROVED` + one `QUOTED` quote staying `FULLY_QUOTED`.) The test: seed a leg `FULLY_QUOTED` with 2 quotes, fire one to `APPROVED`, assert the projector leaves the leg `FULLY_QUOTED` (not regressed to `PARTIALLY_QUOTED`).
- [ ] **Step 3: run the projector test → GREEN**; `pnpm --filter @svyft/shared build`; `pnpm --filter @svyft/api build`.
- [ ] **Step 4: Commit** — `feat(stage5): award request schemas + projector treats APPROVED as resolved` (+ trailer).

---

## Task 2 — maker: shortlist + send-for-approval

**Consumes:** `shortlistSchema`/`sendForApprovalSchema`; the S5.2 comparison (for the recommendation snapshot); `LegAwardDecision`/`AwardDecisionEvent` (S5.3). **Produces:** `PUT …/legs/:legId/shortlist`, `POST …/legs/:legId/send-for-approval` (both Executive+).

**Read first:** `apps/api/src/modules/comparison/comparison.service.ts` (`getComparison` → each leg's `recommendation` + `offers` — reuse to validate the shortlist offer exists + snapshot the recommendation); `apps/api/src/modules/rfq/rfq.controller.ts` (the `@Controller("queries/:id")` + no-`@Roles` maker pattern); `apps/api/src/modules/status/status.service.ts` (`fire`).

**Service logic:**
- `shortlist(queryId, legId, input, user)`: validate the `quoteId` is a `QUOTED`/`REQUOTED` offer on the leg (A1; a `REQUOTED` earlier-price is allowed only under a later A9 override — for shortlist just require it exists on the leg). Look up the leg's live recommendation (via `getComparison`) → **upsert `LegAwardDecision`** with `shortlistedQuoteId`/`shortlistedVariant`, `recommendedQuoteId`/`recommendedVariant` (the snapshot), `overrideReason`, `status: DRAFT`. Write an `AwardDecisionEvent{type:"SHORTLIST", quoteId, variant, actorId}`.
- `sendForApproval(queryId, legId, input, user)`: guards → **A3** (leg `FULLY_QUOTED` OR its RFQ deadline passed), **A2** (if `shortlistedQuoteId` ≠ `recommendedQuoteId`/variant, `overrideReason` must be present on the decision), **A9** (if the leg has an in-flight re-quote — any of its quotes `REQUOTED` — require `input.proceedWithoutWaiting === true` + `input.proceedReason`). On pass: set `LegAwardDecision.status = PENDING_APPROVAL`, `sentByUserId = user.userId`, `sentForApprovalAt = now`. Write `AwardDecisionEvent{type:"SEND_FOR_APPROVAL", reason: proceedReason ?? overrideReason ?? null}`. (No status `fire` here — send-for-approval is a decision-state change, not a leg/quote status change.)

**Steps:** (1) failing e2e for both routes (happy path + A1 bad-quote 400 + A2 missing-override 400 + A3 not-ready 400); (2) → RED; (3) implement service + controller + wire into `AwardModule`; (4) → GREEN + lint; (5) commit `feat(stage5): shortlist + send-for-approval endpoints`.

---

## Task 3 — checker: approve + reject (Manager+, four-eyes)

**Produces:** `POST …/legs/:legId/approve`, `POST …/legs/:legId/reject` — both `@Roles(Role.ADMINISTRATOR, Role.MANAGER)` + four-eyes.

**Service logic:**
- Four-eyes helper: load the `LegAwardDecision`; if `decision.sentByUserId === user.userId` → throw a `ForbiddenException("SELF_APPROVAL")` (→ 403). Both routes call it first.
- `approve(queryId, legId, user)`: guard the decision is `PENDING_APPROVAL` (409 otherwise) + the `shortlistedQuoteId` is still `QUOTED` (A8 → 409 stale). Then, through **`StatusService.fire`**: `fire("quote", shortlistedQuoteId, "approve", { queryId, actorId, reason })` (→ `APPROVED`) and `fire("leg", legId, "approve", { queryId, actorId })` (→ `APPROVED`). Set `decision.status = APPROVED`, `decidedByUserId`, `decidedAt`. Write `AwardDecisionEvent{type:"APPROVE"}`. (The projector — Task 1 fix — keeps the leg rollup stable; the query rollup stays `QUOTED` until generate.)
- `reject(queryId, legId, input, user)`: **A5** (reason required — schema). Set `decision.status = REJECTED`, `rejectionReason`, `decidedBy/At`; then reset toward the maker: `decision.status = DRAFT` (clear `sentByUserId`) so the Executive can re-shortlist/re-send. The **quote is unchanged** (stays `QUOTED` — reject is not a quote transition). Write `AwardDecisionEvent{type:"REJECT", reason}`.

**Steps:** (1) failing e2e (Manager approves → quote+leg `APPROVED`, decision `APPROVED`; Executive on approve → 403 RolesGuard; the **same Manager who sent** → 403 SELF_APPROVAL; reject without reason → 400; reject → decision `REJECTED`→`DRAFT`, quote still `QUOTED`, Executive can re-send; approve a non-`PENDING`/stale leg → 409). Seed two distinct Manager users (`sub: randomUUID()`) so four-eyes is exercised with a real different id. (2) RED; (3) implement; (4) GREEN + lint; (5) commit `feat(stage5): approve + reject endpoints (Manager+ four-eyes)`.

---

## Task 4 — generate-client-quote + reopen-comparison

**Produces:** `POST …/generate-client-quote` (`@Roles(ADMINISTRATOR, MANAGER)`), `POST …/reopen-comparison` (Executive+).

**Read first:** `apps/api/src/modules/status/query-status.projector.ts` — `recompute(queryId, client?)` reads `Query` + leg statuses + `deriveQueryStatus(legStatuses, milestones)`. You add `quotingClient` to the milestones it assembles, sourced from `Query.awardSnapshot != null`.

**Service logic:**
- `generateClientQuote(queryId, user)`: **A6** (every leg has a `LegAwardDecision.status === APPROVED`; no leg lacks an approved winner — else 409), **A7** (every awarded winner's currency has an FX rate — reuse `FxRatesService` + `latestRateByCurrency`; else 409). Build the frozen award snapshot per leg `{ legId, winningQuoteId, variant, currency, unitsPerUsd, usdTotal, transitDays }[]` + `combinedUsd` (reuse the S5.2 comparison assembly for the winners) → write `Query.awardSnapshot`. Then drive the query status: `QueryStatusProjector.recompute(queryId)` with `quotingClient` now reading true from the snapshot → `QUOTING_CLIENT`. Write `AwardDecisionEvent{type:"GENERATE"}` (queryId-scoped; legId = a sentinel or per-leg rows).
- `reopenComparison(queryId, user)`: clear `Query.awardSnapshot` (→ null); `recompute` → back to `QUOTED`. (Leg/decision APPROVED states are left intact — reopening the client quote doesn't un-approve legs; a subsequent per-leg change/negotiation is what reverses an approval, S5.5.)
- **Projector change:** in `query-status.projector.ts` `recompute`, add `quotingClient: !!query.awardSnapshot` to the milestones object (and include `awardSnapshot` in its `Query` select). Add `quotingClient` to `QueryMilestones` was done in S5.3 (Task 1); the derive mapping too — so this is just sourcing the flag.

**Steps:** (1) failing e2e: approve all legs of a 2-leg query → `generate` → query `QUOTING_CLIENT` + `awardSnapshot` populated (per-leg winners + combinedUsd); `generate` with a not-all-approved query → 409 (A6); `generate` with a winner in a currency with no FX rate → 409 (A7); `reopen` → query back to `QUOTED`, snapshot null; a non-Manager on generate → 403. (2) RED; (3) implement + the projector change; (4) GREEN + **full `pnpm run ci`**; (5) commit `feat(stage5): generate-client-quote + reopen-comparison (QUOTING_CLIENT rollup)`.

### S5.4 acceptance
- [ ] `pnpm run ci` green → opus whole-branch review → push to PR #52.

---

## Self-review (against the design)
- **Spec coverage:** the 6 endpoints (§11) → Tasks 2–4; four-eyes + Manager+ (§4) → Task 3; A1–A9 (§13) → A1/A2/A3/A9 Task 2, A4/A5/A8 Task 3, A6/A7 Task 4; the maker-checker states (§9) → the `LegAwardDecision` transitions across Tasks 2–3; `QUOTING_CLIENT` rollup + `awardSnapshot` (§5.6/§8.3) → Task 4. Negotiation (§10.1) is **S5.5**, not here — but A9's gate is implemented now (inert until S5.5 produces `REQUOTED` quotes).
- **S5.3 inputs consumed:** ordering enforced in `award.service` not machine guards (Task 2/3); the projector resolved-set fix (Task 1) so `approve` doesn't regress the leg rollup.
- **Every status change via `fire`** with `reason`; decision-state changes (shortlist/send/reject-to-draft) are `LegAwardDecision` writes + `AwardDecisionEvent`, not status fires.
- **Open item for review:** whether `generate` should also fire a leg/quote status (the design keeps leg at `APPROVED` and drives only the query milestone — confirm no leg `AWARDED` here; `AWARDED` stays post-client-Won, Stage 6).
