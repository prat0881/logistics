# Stage 5 — Session Handoff

_Last updated: 2026-08-15 (overnight autonomous run: S5.4 + S5.5 delivered)_

## Current stage & branch
- **Stage 5 — Compare Quotes & Award.** Branch `feat/stage-5-fx-master` → **PR #52** (OPEN, **not merged** — you merge manually).
- PR #52 title: _"Stage 5 · S5.1 + S5.2 + S5.3 + S5.4 + S5.5"_ (35 commits). Tip: `d5a859a`.
- `pnpm run ci` **GREEN** at the tip: shared 366 · api 90 suites / 379 tests · web 604 · lint + typecheck + 3 builds clean.

## What's built (all 5 sub-builds on PR #52)
| SB | Scope | State |
| :-- | :-- | :-- |
| S5.1 | FX master (`FxRate` + `toUsd` + `fx-rates` module + `masters/fx-rates` screen) | ✅ merged into PR |
| S5.2 | Comparison engine + read model (`recommendOffer`, `GET …/comparison`) | ✅ |
| S5.3 | Status & decision foundations (enums, machine edges, `LegAwardDecision`/`AwardDecisionEvent`, `awardSnapshot`) | ✅ |
| **S5.4** | **Approval workflow endpoints** — shortlist / send-for-approval / approve / reject / generate-client-quote / reopen-comparison | ✅ delivered this session |
| **S5.5** | **Negotiation §10.1 + Change-order reversal §10.2** | ✅ delivered this session |
| S5.6 | **Compare-Quotes frontend** (the screen per the mockup + FX admin) | ⏭ NEXT — not started |

Every sub-build was built subagent-driven (TDD, per-task review + fix loops, **opus whole-branch review**). S5.4's reviews caught 5 real defects before merge; S5.5's caught the `StatusRegistry` init-order issue + the request-requote/`QUOTING_CLIENT` teardown seam. All findings fixed or adjudicated.

## Decisions made (why) — **please review**
- **S5.4 RBAC — generate = Manager+ ONLY, no four-eyes (your O4 call).** The design self-contradicted (§4/§11/§13 tables said four-eyes on generate; §16 O4 said no). You chose **O4**. Design doc §4/§11/§13/D9/§12/§15 all aligned to it. approve/reject keep four-eyes; generate is Manager+ only.
- **S5.5 D-A — single-leg re-quote resets the whole (query×FF) RFQ deadline.** `Rfq` is `@@unique([queryId, freightForwarderId])` (one RFQ covers all of an FF's legs on a query; no per-quote deadline). §10.1 says "reset that RFQ's deadline", so a re-quote on one leg extends the shared window for that FF's other open legs too. Accepted per the design's RFQ-level model.
- **S5.5 D-B — modified the delivered SB6 change-order subsystem** to cascade `APPROVED` quotes (`scope.resolver.ts` + `change-order.strategy.ts`). Required for §10.2 to fire at all (an approved leg was invisible to change-order before). Low blast radius (APPROVED post-dates SB6); full SB6 regression green.
- **S5.5 D-C — new `rfq.requote_requested` notification template** (rather than overloading `rfq.updated`, whose copy is "a leg was added").

## Open items needing YOUR input
1. **Deferred follow-up (ticket filed): "Wire REQUOTED into change-order cascade"** (background task `task_44674c1e`). A change-order field edit on a leg whose only quote is `REQUOTED` (mid-renegotiation) currently free-paths — the FF could re-quote against a stale basis. Reviewed as **safe to defer** (narrow window, no corruption, maker-checker + A8 catch it). Needs a new `REQUOTED→INVALIDATE→INVALID` edge. Chip is on the session for one-click start.
2. **Product question — earlier price lost on re-quote expiry (S5.5 Minor #4).** §10.1 promises the FF's earlier price "stays visible, badged stale." But the expiry sweep clears `draftJson` for a `REQUOTED` quote on deadline, so if the FF ignores a re-quote request, the original offer is **lost** (no fallback). Is that the intended business rule, or should the prior price be preserved?
3. **Minor #3 (display-lag, folded into the follow-up ticket):** a `REQUOTED` quote expiring on an already-`FULLY_QUOTED` leg fires no leg transition, so the query status can read `QUOTED` while that leg holds only an `EXPIRED` quote.
4. **`StatusRegistry` infra change (FYI — reviewed sound):** `contribute()` is now module-init-order-independent (`pending`-merge + an `OnApplicationBootstrap` orphan-key guard). This touches the Extensibility Core used by every domain module; it was deeply reviewed (merge proven correct for all orderings against the actual `@nestjs/core` scanner source). Flagging only because it's shared infra.

## Approaches that didn't work
- **S5.5 module-init ordering:** wiring `AwardModule → RfqModule` shifted NestJS's computed module-init "distance", flipping `RfqModule.contribute("leg")` ahead of `LegsModule.register(legMachine)`. Import-graph tweaks (e.g. `RfqModule` importing `LegsModule`) do **not** fix it (single-pass non-fixed-point DFS). Root-fixed in `StatusRegistry` instead (see item 4).
- **S5.4 generate winner-pricing:** cannot reuse `getComparison` for winners — `COMPARABLE_STATUSES = [QUOTED, REQUOTED]` excludes `APPROVED`, so approved winners vanish from the grid. Generate prices winners directly from each winning quote's immutable `draftJson`.

## The exact next step — S5.6 (Compare-Quotes frontend)
**Backend is 100% ready** (all read + write endpoints across S5.1–S5.5). This is a pure frontend sub-build.
- **Spec:** design §12; **the approved interactive mockup is the visual spec** (claude.ai artifact `10b4cbc3-c713-4773-b8c5-00ea8289cec4`).
- **Route:** `/queries/:id/compare` (wire the `StageRail` "Quotes" step; gate at `RFQ_SENT`+).
- **Reuse as-is:** `QueryOverviewHeader`, `RouteDiagram` (+ `computeRouteLayout`), `ForwarderStatusBadge`/`statusBadges`, shadcn tokens.
- **Adapt:** `RouteDiagram` clickable-leg channel; the single-open `LegPanel` accordion; `ChargeMatrix` → a **read-only** comparison grid with `(FF × variant)` columns.
- **New:** comparison grid + recommendation banner; **maker view** (Executive+: shortlist radios, override-reason, negotiate, send); **checker view** (Manager+ only: approve/reject + the Generate gate, controls four-eyes-disabled when viewer is the leg's sender; **Generate needs only Manager+, no four-eyes**); decision timeline; the **Quoting Client** end-state panel (frozen award summary + combined USD + reopen); the FX-admin screen already exists (S5.1) — extend if needed.
- **Data:** TanStack Query hooks (`useComparison`, `useAwardDecision`, mutations) over `lib/api.ts`; RHF + Zod schemas from `@svyft/shared` (`shortlistSchema`, `sendForApprovalSchema`, `rejectSchema`, `requestRequoteSchema`).
- **Recommendation:** S5.6 is a **visual deliverable** — best built with you watching it land against your mockup, so it wasn't started autonomously. Kick it off with `superpowers:brainstorming` (to confirm the frontend approach) → `writing-plans` → SDD, or ask me to draft the S5.6 plan directly.

## Reusable facts (learned across S5.4/S5.5 SDD)
- Caller id = `user.userId` (`RequestUser`); e2e actor `@db.Uuid` cols need cookie `sub: randomUUID()`.
- Every owned status change via `StatusService.fire` (awaits `emitAsync` → projectors run in-fire → **every new `@OnEvent` listener MUST try/catch+log** or it fails the caller). Query status is a projection (never `fire`d).
- Clear a `Json?` column with **`Prisma.DbNull`** (plain `null` sets JSON-null, still truthy).
- Local Postgres :5433 (`svyft-postgres-task4`); `set -a; . apps/api/.env; set +a` before prisma/jest.
- Rebuild `@svyft/shared` after editing it; run `pnpm run typecheck` per task (vitest/jest don't type-check).
