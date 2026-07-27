# Plan 7 — Notifications / Escalations / Emails — Design (Spec)

> Design of record for Plan 7. Feeds `superpowers:writing-plans` → subagent-driven execution on `feat/plan-7-notifications` → one PR to `main`.
> Sources: Functional Spec §13 (Form Actions), §14 (Escalation & Notifications), §15 (Email Templates); Technical Design §2.2 (module map), §4.2 (Notifications & Ops models), §5.2 (API surface), §8.2 (escalation scheduler), §8.3 (notifications polling), §8.7 (email compose-&-log).

## Goal

Add the informational **notifications / escalations / emails** layer on top of the existing Query aggregate: a tiered escalation timer (in-app + logged email), client email compose-&-log (no live send, D12), and an in-app notifications feed — plus the wizard's Send Follow-up / Send Acknowledgement actions and a per-query email log.

## Scope

**In scope (one plan, one PR, backend + frontend):**
- Backend: three NestJS modules — `escalations`, `emails`, `notifications` — + one Prisma migration (three tables) + `@nestjs/schedule` (new dep) + shared enums/types in `@svyft/shared`.
- Frontend: notifications bell + unread badge + feed in `AppLayout`; the wizard's **Send Follow-up** + **Send Acknowledgement** actions; a per-query **email-log** view.

**Out of scope (Stage 4+ / deferred, unchanged):** change-order cascade, FF density, `manifestSnapshot` freeze; **live email transmission** (D12 — compose-&-log only); SSE/WebSocket (polling only, §8.3); auto-reassignment / auto-close (§14 — informational only); BullMQ/Redis (documented scale-up path, not built — §8.2).

## Decisions (resolved in brainstorm)

1. **Escalation recipient resolution:** when a tier fires, **every active user holding that tier's role** receives an in-app `Notification`; the escalation email is **composed & logged once** per firing. (Resolve via `prisma.user.findMany({ where: { role, isActive: true } })` — `User.isActive` exists.)
2. **Escalation clock:** **fixed timers from first Save** (createdAt +30m/+2h/+6h); cancel the unfired remainder on `RFQ_READY` or closure. No activity-reset (Technical Design §8.2 is the design of record; supersedes the looser "no further activity" wording in Functional Spec §14).
3. **Lifecycle hook:** **event-driven** via the already-wired `@nestjs/event-emitter` (mirrors `StatusService` → `QueryStatusProjector`), not direct service coupling.
4. **Delivery:** one plan → one PR, subagent-driven + opus whole-branch review.

## Data model — migration #6 (`notifications_escalations_emails`)

Three new tables, each with a nullable `tenantId` (tenant-readiness, §4.6). Enums are Prisma enums mirrored as `@svyft/shared` const-object unions (project convention — never a TS `enum`).

**`Notification`**
- `id` uuid PK · `tenantId?` · `recipientUserId` `@db.Uuid` (soft ref, no relation — matches `assignedUserId` convention) · `type` `NotificationType` · `queryId?` (FK → Query, `onDelete: Cascade`, nullable) · `message` text · `readAt?` DateTime · `createdAt` default now.
- Index: `(recipientUserId, readAt)` (feed + unread-count), `(recipientUserId, createdAt)`.

**`Escalation`**
- `id` uuid PK · `tenantId?` · `queryId` FK → Query (`onDelete: Cascade`) · `tier` `EscalationTier` · `recipientRole` `Role` · `dueAt` DateTime · `firedAt?` DateTime · `cancelledAt?` DateTime · `createdAt` default now.
- Index: `(firedAt, cancelledAt, dueAt)` (the poll predicate) and `(queryId)`.
- Uniqueness: `@@unique([queryId, tier])` (exactly one row per tier per query).

**`EmailLog`**
- `id` uuid PK · `tenantId?` · `queryId` FK → Query (`onDelete: Cascade`) · `template` `EmailTemplate` · `fromAddress` · `toAddress?` (may be null when the client has no email) · `subject` · `bodyRendered` text · `tokens` Json · `composedById?` `@db.Uuid` (soft ref; null for system/escalation) · `status` `EmailStatus` default `LOGGED` · `createdAt` default now.
- Index: `(queryId, createdAt)`.

**Enums (Prisma + `@svyft/shared`):**
- `NotificationType` = `ESCALATION` (single value in Stage 3; enum leaves room to grow — no other notification sources this build).
- `EscalationTier` = `T30M` · `T2H` · `T6H`.
- `EmailTemplate` = `FOLLOW_UP` · `ACKNOWLEDGEMENT` · `ESCALATION`.
- `EmailStatus` = `LOGGED` (reserved: `SENT`/`FAILED` for Stage 4 live send).
- Reuse existing `Role` (`EXECUTIVE`/`MANAGER`/`ADMINISTRATOR`) for `recipientRole`.

**Tier → role map:** `T30M`→`EXECUTIVE`, `T2H`→`MANAGER`, `T6H`→`ADMINISTRATOR` (spec §14).

## Backend

### `escalations` module
- **`EscalationsService`** (plain, testable methods; the cron is a thin wrapper):
  - `createForQuery(queryId, createdAt, tx?)` — inserts the 3 `Escalation` rows (`dueAt` = `createdAt` + 30m/2h/6h; tier→role map). Idempotent on `@@unique([queryId, tier])` (skip if already present).
  - `cancelForQuery(queryId)` — set `cancelledAt = now` on rows where `firedAt IS NULL AND cancelledAt IS NULL`.
  - `runDue(now = new Date())` — select `dueAt <= now AND firedAt IS NULL AND cancelledAt IS NULL`; for each row (in a per-row tx): resolve `recipientRole → users` (`role = tier-role AND isActive`), insert one `Notification` per user (`type=ESCALATION`, `queryId`, message e.g. `"Query {queryCode} has not progressed — {tier-human} escalation"`), call `EmailsService.compose('ESCALATION', queryId, …)` once, set `firedAt = now`. Returns a summary (count fired) for tests/logs.
  - Emits nothing; consumes events (below).
- **Lifecycle wiring (events):**
  - `queries.service.create(...)` emits `query.created` (payload `{ queryId, createdAt }`) **after the mint tx commits**. `@OnEvent("query.created")` → `EscalationsService.createForQuery(...)`.
  - `queries.service.createQuery(...)` emits `query.rfq_ready` (payload `{ queryId }`) after `RFQ_READY`. `@OnEvent("query.rfq_ready")` → `EscalationsService.cancelForQuery(...)`.
  - (Post-commit emit avoids orphan escalations on rollback. Query deletion cascades escalations via FK.)
- **Cron:** `@Cron(CronExpression.EVERY_MINUTE)` in an `EscalationsScheduler` → `EscalationsService.runDue()`. `ScheduleModule.forRoot()` added in `app.module`. Single container replica → timers fire once (§8.2 note). No public HTTP surface (internal only).

### `emails` module
- **`EmailsService.compose(template, queryId, actor?)`** → loads the query (+ client contact snapshot + checklist), renders the §15 template with tokens, writes an `EmailLog` (`status=LOGGED`, **no transmission**), returns the row.
  - Tokens: `{Query_ID}` = `queryCode`; `{Client_Name}` = `contactName` (or client name snapshot); `{Client_Email}` = `contactEmail` (→ `toAddress`, may be null); `{Missing_Fields_List}` = comma-joined labels of unchecked `QueryChecklistItem`s (follow-up only); `{Expected_Response_Timeline}` = `"24 hours"` (default, acknowledgement).
  - `fromAddress` = `logistics@yankalfa.com` (constant; a config value later).
  - Templates rendered from string builders in the module (subject + body per §15.1/§15.2 + an escalation body). Pure render helpers are unit-tested in isolation.
- **Endpoints** (RBAC: Exec+):
  - `POST /queries/:id/emails/follow-up` → `compose('FOLLOW_UP', …)`. (No hard gate server-side; the *button* enables only when ≥1 unchecked — mirrors the relaxed-save ethos. Returns the logged email.)
  - `POST /queries/:id/emails/acknowledgement` → `compose('ACKNOWLEDGEMENT', …)`.
  - `GET /queries/:id/emails` → list logged emails for the query (newest first).

### `notifications` module
- **`NotificationsService`**: `listForUser(userId, limit)`, `unreadCount(userId)`, `markRead(id, userId)` (scoped — a user can only read their own; 404 otherwise), `createMany(userIds, {...})` (used by `EscalationsService`).
- **Endpoints** (any authenticated role; always self-scoped to `CurrentUser`):
  - `GET /notifications` (recent N, newest first) · `GET /notifications/unread-count` · `PATCH /notifications/:id/read`.

### Shared (`@svyft/shared`)
- New enums (`NotificationType`, `EscalationTier`, `EmailTemplate`, `EmailStatus`) as const-object unions + `Object.values` arrays pinned by a `toEqual` test.
- DTO/response types: `NotificationDto`, `EmailLogDto`, `UnreadCountDto`. Zod schemas only where a request body needs validation (the POST email endpoints take no body; `PATCH /notifications/:id/read` takes none — so minimal Zod here).

## Frontend (`apps/web`)

- **`features/notifications/`**: `useNotifications` (TanStack Query — `["notifications"]` list, `["notifications","unread-count"]` with `refetchInterval: 45_000`), `NotificationBell` (bell icon + unread badge + dropdown feed; clicking an item `PATCH`es read then invalidates both keys; clicking one with a `queryId` navigates to that query). Mounted in `AppLayout` header right-slot (beside the user/logout block).
- **Wizard (Step 5 Notes/Checklist + action bar):**
  - **Send Follow-up** — enabled iff ≥1 checklist item is unchecked (reads the query's checklist state already loaded in the wizard). `POST …/emails/follow-up` → success toast + refresh the email log.
  - **Send Acknowledgement** — always enabled. `POST …/emails/acknowledgement` → toast + refresh.
  - **Emails list** — a compact section (`GET …/emails`) listing logged emails (template · subject · toAddress · time), so the user can see what was composed/logged. Read-only.
- HTTP via existing `postJson`/`fetchJson`/`patchJson`; findings/errors via `ApiError`; toasts via the existing notice pattern.

## Testing & gate

- **Local gate:** `pnpm --filter @svyft/shared build && pnpm run ci` green. Counts grow: shared (new enums + a pinned-array test), web (bell/feed + Send actions + email-log tests), api (three modules' e2e). Migration validates on **GitHub CI** (no local DB this session — carry the build gotcha: build shared first).
- **api e2e (self-cleaning, seed-independent, unique prefix; a query delete cascades):**
  - `escalations`: `createForQuery` inserts 3 rows with correct `dueAt`/role; `runDue(now)` with a past `dueAt` fires → inserts a `Notification` per role-holder + one `ESCALATION` `EmailLog` + sets `firedAt`; a second `runDue` does not re-fire; `cancelForQuery` sets `cancelledAt` on unfired rows and `runDue` then fires nothing; `query.rfq_ready` cancels.
  - `emails`: follow-up composes with the unchecked-items list in `bodyRendered`/`tokens`; acknowledgement composes with the 24h timeline; `GET …/emails` returns them; `status=LOGGED`, nothing sent.
  - `notifications`: list/unread-count/mark-read are self-scoped (another user's notification → 404 on read; not counted).
  - Event wiring: creating a query yields 3 escalations; `POST /queries/:id/create` cancels them.
- **web:** `NotificationBell` renders unread badge from a mocked count + opens the feed + marks read; Send Follow-up disabled when all checked / enabled with an unchecked item and POSTs; email-log renders. (Radix/polling caveats per the handoff — drive hidden selects, don't assert timers.)
- **Cron caveat:** e2e drives `EscalationsService.runDue()` directly (deterministic); the `@Cron` wrapper is not awaited in tests. Guard the cron so it's inert under test if it proves noisy (env flag) — decide during implementation.

## Definition of Done

- Three modules + migration #6 + `@nestjs/schedule` wired; shared enums/types added.
- Frontend bell/feed + Send Follow-up/Acknowledgement + email-log shipped.
- `pnpm --filter @svyft/shared build && pnpm run ci` green locally (shared + web); GitHub CI green (api e2e + migration).
- Opus whole-branch review (probes: post-commit event timing / no orphan escalations, `runDue` idempotency + role fan-out, cancel-on-RFQ_READY, compose-&-log never sends, self-scoped notifications, cron test-inertness).
- Finish via `superpowers:finishing-a-development-branch` → PR to `main`; update `docs/Stage 3 - Session Handoff.md` (Plan 7 shipped; note the escalation-clock decision + role-fan-out).

## Open items resolved / noted
- Escalation clock = fixed-from-creation (decision 2) — reconciles Functional Spec §14 vs Technical Design §8.2 in favour of the TD.
- Notification recipient = all role-holders (decision 1).
- Email-log surfaced **per-query** in the wizard (not a global admin view) — smallest useful surface; a global view can come later.
- `Expected_Response_Timeline` default = 24h (spec §15.2); `fromAddress` constant `logistics@yankalfa.com` (config-ify later).
