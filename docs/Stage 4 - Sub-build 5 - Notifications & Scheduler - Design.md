# Stage 4 · Sub-build 5 — Notifications, Emails & Scheduler — Design

> Design of record for **SB5**. Two layers: **(A)** a generic, configurable **Comms + Scheduler framework** reused by every stage, and **(B)** its **RFQ usage** — reminders, expiry, "No Response", and the RFQ/quote emails + bell notifications. **Backend only · compose-&-log · no admin UI this build.** Brainstorm complete; the decisions in §1 are locked — do not re-litigate.
>
> Companion: `Stage 4 - RFQ Send to Freight Forwarder (v2) - Functional Spec.md` (§8 system logic, §9 status, §12 emails) · `Stage 4 - Technical Design.md` (§8.2 scheduler, §8.3 emails) · `Stage 3 - Session Handoff.md` (Conventions). Implementation plan → `docs/plans/stage-4/Stage 4 - Sub-build 5 - Notifications & Scheduler - Implementation Plan.md`.

## 1. Locked decisions (from the SB5 brainstorm, 2026-07-31)

1. **Transport = compose-&-log now, live later.** Every message is rendered + stored; nothing is transmitted. A live `SmtpTransport` is a drop-in swap at the go-live gate (paired with TLS). *(B2.)*
2. **Templates are data, not code.** A DB-backed `MessageTemplate` table holds subject/body with `{{tokens}}`, seeded with defaults, editable via seed/API. The closed `EmailTemplate`/`NotificationType` enums retire in favour of open `templateKey`/`eventKey` strings.
3. **One generic timer table for all stages.** A single `ScheduledEvent` table (+ one minute-cron) replaces per-feature alarm tables. The Stage-3 `Escalation` table is **folded into it** (migrated + retired).
4. **Config = AppSetting-backed, no UI.** Deadline default (48h) + reminder offsets (36/24/12/6/2h) live in `AppSetting`, seeded, editable via seed/API. SMTP settings + an admin UI are a **later dedicated sub-build**.
5. **Migrate Stage-3 onto the framework.** The 3 existing templates (`FOLLOW_UP`/`ACKNOWLEDGEMENT`/`ESCALATION`) and the escalation timers move onto the generic base — one path, no legacy fork.
6. **Backend only this build.** Admin UI (templates + SMTP), live send, RFQ PDF, the O-S4-6 amended-leg soft-warning, and the change-order `REOPENED` notification (SB6) are out of scope.

## 2. Why a framework (context)

Stage 3 wired comms **imperatively per event**: the escalation cron hand-calls `NotificationsService.createMany(...)` *and* `EmailsService.compose(...)`, email bodies are string literals in a `renderEmail` switch gated by a closed enum, and `EmailLog.queryId` is required so nothing non-query fits. Adding an email = code + enum migration + deploy; a business user can never do it. The 9-stage roadmap needs many more emails (Stage 4 alone: 5 template families; Stages 5–9: client quotation, PO, award, tracking). SB5 turns "event → channels → template → recipients" into **data + one dispatcher**, so new emails become **rows**, and every later stage reuses the same machinery.

## 3. Architecture

```
                 ┌─────────────── triggers ───────────────┐
   business action (post-commit)            ScheduledEvent cron (EVERY_MINUTE)
   distribute / amend / submit /            claim-then-fire due rows →
   create / rfq_ready …                     emitAsync(eventKey, …)
                 └──────────────┬─────────────────────────┘
                                ▼
                    NotificationDispatcher.dispatch(eventKey, { scope, tokens, recipients })
                                │  looks up ACTIVE MessageTemplate rows for (eventKey, channel)
                 ┌──────────────┼───────────────────────────────┐
                 ▼ IN_APP                                        ▼ EMAIL
        Notification rows (bell feed, read-state)        MessageLog rows (status LOGGED)
        recipients = internal Users                      recipients = any address
                                                          → Transport (LogTransport now)
```

- **Callers stay dumb:** they compute domain tokens + recipients and call `dispatch(eventKey, …)`. They never touch templates or channels.
- **Channels fire when an active template exists for `(eventKey, channel)` AND the caller supplied recipients for that channel.** Presence of a template row *is* the channel toggle.
- **Same event-driven seam already in the codebase** (`emitAsync` post-commit + `@OnEvent`); the scheduler just feeds it on a timer.

## 4. Data model

### 4.1 New tables

**`MessageTemplate`** — the editable template catalog (seeded).

| Column | Type | Notes |
|---|---|---|
| `key` | String `@id` | readable slug, e.g. `rfq.invitation.email` |
| `eventKey` | String | the business event, e.g. `rfq.invitation` |
| `channel` | `Channel` enum | `IN_APP` \| `EMAIL` |
| `subject` | String? | nullable (IN_APP has no subject) |
| `body` | String | template with `{{tokens}}` |
| `active` | Boolean `@default(true)` | deactivating = turning a channel off for that event |
| `updatedAt` | DateTime `@updatedAt` | |
| | | `@@unique([eventKey, channel])` |

**`ScheduledEvent`** — the single generic timer (absorbs `Escalation`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `tenantId` | uuid? | |
| `entityType` / `entityId` | String / uuid | anchor: `QUERY` / `RFQ` / future `PO`, `SHIPMENT` |
| `eventKey` | String | what to fire, e.g. `rfq.reminder`, `rfq.expiry`, `query.escalation` |
| `tier` | String | series label (`T36H`…`T2H`, `T30M`…; one-shots use `DEADLINE`) |
| `dueAt` | DateTime | UTC |
| `firedAt` / `cancelledAt` | DateTime? | claim-then-fire · cancel |
| `payload` | Json? | optional fire-time context (usually re-derived from the entity) |
| `createdAt` | DateTime | |
| | | `@@unique([entityType, entityId, eventKey, tier])`; `@@index([dueAt, firedAt, cancelledAt])` |

**`Channel`** enum: `IN_APP`, `EMAIL` (extensible: `SMS`, `WEBHOOK`).

### 4.2 Generalized tables

**`MessageLog`** — generalizes `EmailLog` into a channelled delivery log (renamed).

| From `EmailLog` | To `MessageLog` |
|---|---|
| `queryId` required FK | `entityType` + `entityId` (generic anchor; `queryId` dropped) |
| `template` enum | `templateKey` String |
| — | `channel` `Channel` (`EMAIL` now; future `SMS`/`WEBHOOK`) |
| `status` (LOGGED only) | `status` `MessageStatus` = `LOGGED` (now) → `SENT`/`FAILED` (live) |
| — | `error` String? |
| *(unchanged)* | `fromAddress`, `toAddress`, `subject`, `bodyRendered`, `tokens`, `composedById`, `createdAt` |

`@@index([entityType, entityId, createdAt])`. In-app deliveries do **not** go here — they are `Notification` rows (below); `MessageLog` is the outbound-message log (email now, SMS/webhook later).

**`Notification`** — stays the in-app **feed** (it owns read/unread UI state), generalized:

| Change | Detail |
|---|---|
| `type` enum → String | now the `eventKey` (open) |
| + `entityType` / `entityId` | generic anchor; `queryId` kept nullable for deep-link back-compat |
| `message` | now **template-rendered** by the dispatcher (was built inline) |
| *(unchanged)* | `recipientUserId`, `readAt`, `createdAt`, the two recipient indexes |

### 4.3 Enum / status changes

- **Retire** closed enums: `EmailTemplate`, `NotificationType`, `EscalationTier` → replaced by `templateKey`/`eventKey`/`tier` strings. A **code catalog** (`packages/shared`) keeps the known `eventKey`s + each event's valid **token set** (for tests + the future editor); it is validated by a `toEqual` test, not enforced as a DB enum.
- **Add** `QueryStatus.NO_RESPONSE` (shared const + `QUERY_STATUSES` array + Prisma enum).

## 5. The dispatcher

`NotificationDispatcher.dispatch(eventKey, { scope:{entityType,entityId}, tokens, recipients })` where `recipients = { IN_APP?: userId[]; EMAIL?: address[] }`:

1. Load **active** `MessageTemplate` rows for `eventKey`.
2. For each channel that has **both** an active template **and** supplied recipients:
   - **IN_APP** → render `body` → `Notification` row per `recipientUserId`.
   - **EMAIL** → render `subject`+`body` → one `MessageLog` row per address (status `LOGGED`) → hand to `Transport` (`LogTransport` = no-op now).
3. Rendering = pure `{{token}}` substitution (`render(templateString, tokens)`); unknown tokens render empty + are caught by the token-catalog test.

Recipients are resolved **by the caller/listener** (it has the domain context) and passed in — the dispatcher itself is pure and stage-agnostic. This is also where the Stage-3 escalation smell is fixed: the escalation email recipient becomes explicit internal staff, not `query.contactEmail`.

## 6. The scheduler

`ScheduledEventService` + `ScheduledEventScheduler` (`@Cron(EVERY_MINUTE)`, skips `NODE_ENV=test`; mirrors `escalations.scheduler.ts`).

- **create(entity, eventKey, tiers[])** — insert one row per tier with `dueAt`; **skip tiers already in the past** (a short/overridden deadline never fires a past-due burst); idempotent via the unique key (`upsert`).
- **cancel(entity, eventKey)** — set `cancelledAt` on unfired rows.
- **runDue(now)** — `dueAt ≤ now & firedAt null & cancelledAt null` → **claim-then-fire** (`updateMany` guarded on `firedAt: null` = at-most-once under a racing cron) → `emitAsync(eventKey, { scope, tier })`. Single-replica assumption holds (documented; multi-replica needs a leader-lock, deferred).

Firing a row **emits its event**; listeners do the work. Pure-notify events (escalation, reminder) → the listener just `dispatch()`es. Action events (expiry) → the listener runs domain logic *then* dispatches.

## 7. Config

`AppSetting` key/value rows (seeded, idempotent; read via the existing `config-data.service` pattern):

| key | default | used by |
|---|---|---|
| `rfqDeadlineDefaultHours` | `"48"` | `RfqService.resolveDeadline` (replaces the hardcoded `48*60*60*1000`) |
| `rfqReminderOffsetsHours` | `"36,24,12,6,2"` | reminder seeding |

SMTP settings + per-event overrides are reserved for the later admin sub-build. "Which channels fire" needs no config table — it is the set of **active `MessageTemplate` rows** for the event.

**Template editing (SB5, no UI):** the `MessageTemplate` seed is **create-only** (`update: {}`, like the density factors — it never overwrites an edited row). Until the admin UI (§17), change a shipped template's subject/body by **editing its row directly** (Prisma Studio / a SQL `UPDATE`); the seed file is only for the initial defaults + adding brand-new templates.

## 8. Notifications / the bell — when a row is written

A `Notification` (bell) row is written **whenever the dispatcher processes an event whose `IN_APP` channel has an active template AND the caller supplied internal-user recipients** — nothing escalation-specific. `Notification.type = eventKey`, so the bell supports arbitrarily many use cases with no enum churn.

**Hard constraint:** FFs are external (token portal, no login, no bell) → FF-facing events are **EMAIL-only**; only internal-user recipients ever produce a `Notification`. One event may route different channels to different audiences (see `rfq.expiry` below).

## 9. RFQ usage (Layer B)

### 9.1 Wiring (all dispatch post-commit)
- **Distribute** (`rfq.service`): first-to-FF → `dispatch("rfq.invitation")`; amend (S3) → `dispatch("rfq.updated")`. Also `ScheduledEvent.create(RFQ, "rfq.reminder", [T36H…T2H])` + one `ScheduledEvent(RFQ, "rfq.expiry", "DEADLINE", dueAt=deadline)`.
- **Submit** (`ff-portal.service`): `ScheduledEvent.cancel(RFQ, "rfq.reminder")` + `dispatch("rfq.submission_ack")` (FF, EMAIL) + `dispatch("quote.received")` (Executive, IN_APP).

### 9.2 Reminder / expiry listeners
- `@OnEvent("rfq.reminder")` → `dispatch("rfq.reminder", { EMAIL:[ff] , tokens })`.
- `@OnEvent("rfq.expiry")` → for every still-`RFQ_SENT` quote on the RFQ: **discard `draftJson`** (permanent, S8/E3) → `StatusService.fire(quote, EXPIRE)` (the one status door; after its own tx) → leg/query rollup free → then `dispatch("rfq.expiry", { EMAIL:[ff] , IN_APP:[assignedExec], tokens })`. Quotes already `QUOTED` are untouched. Timing is UTC-offset math (O-S4-5) — no zone edge cases.

### 9.3 "No Response" status
A leg whose FFs all expired currently rolls to `FULLY_QUOTED` → the query would wrongly read `QUOTED`. Fix: the query projector computes a `noResponse` flag (**≥1 quote exists AND every quote across all the query's legs is `EXPIRED`/`INVALID`, none `QUOTED`**) and passes it into `deriveQueryStatus`, which returns `NO_RESPONSE` in the all-resolved branch instead of `QUOTED`. `deriveQueryStatus` stays pure + unit-tested.

### 9.4 Event catalog (SB5)

| eventKey | trigger | EMAIL → | IN_APP (bell) → |
|---|---|---|---|
| `query.acknowledgement` | action (existing endpoint) | client | — |
| `query.follow_up` | action (existing endpoint) | client | — |
| `query.escalation` | scheduled | tier-role staff *(corrected from client)* | tier-role staff |
| `rfq.invitation` | distribute | FF | — |
| `rfq.updated` | amend | FF | — |
| `rfq.reminder` | scheduled ×5 | FF | — |
| `rfq.expiry` | scheduled (one-shot) | FF | assigned Executive |
| `rfq.submission_ack` | submit | FF | — |
| `quote.received` | submit | *(optional)* | assigned Executive |

## 10. Migrations (additive-first → backfill → retire)

1. **Additive:** add `MessageTemplate`, `ScheduledEvent`, `Channel`/`MessageStatus` enums, `MessageLog` (as the generalized table) + the new `Notification` columns; add `QueryStatus.NO_RESPONSE`; add the `AppSetting` seeds.
2. **Backfill:** `Escalation` → `ScheduledEvent` (preserve `dueAt/firedAt/cancelledAt`, `eventKey="query.escalation"`, `tier=T30M/T2H/T6H`); `EmailLog` → `MessageLog` (`entityType="QUERY"`, `channel=EMAIL`, `templateKey=<lowercased template>`); seed all `MessageTemplate` rows (the 3 migrated + the RFQ/quote templates).
3. **Retire:** drop `Escalation` + the closed enums once code is cut over.

⚠️ **Hand-author the SQL + `prisma migrate deploy`** — `migrate dev` drifts on the `CargoItem.volumeCbm` generated column (PG 42601), the FF-address-fields lesson. Run the **prod orphan pre-flight** before deploy for any new FK. Additive-then-drop keeps a rollback window.

## 11. Backward compatibility

- **`GET /queries/:id/emails`** keeps working → now queries `MessageLog` where `entityType="QUERY" AND channel=EMAIL`. `EmailLogDto` → `MessageLogDto` (field-compatible superset; the web email-log view maps unchanged).
- **`POST …/emails/{follow-up,acknowledgement}`** unchanged externally → internally call `dispatch("query.follow_up"/"query.acknowledgement")`.
- **Escalation behaviour parity** — the migrated `query.escalation` fires the same in-app fan-out to tier-role users on the same schedule; the **email recipient is corrected** from the client (`query.contactEmail`) to the same internal tier-role staff who receive the bell (documented behaviour change, test updated). Compose-&-log means nothing was ever transmitted, so no live impact.
- **Notifications feed** (`GET /notifications`, `/unread-count`, `PATCH /:id/read`) unchanged; rows just carry more `type` values.

## 12. Testing

- **Shared:** `render()` token substitution; the eventKey/token catalog `toEqual`; `deriveQueryStatus(NO_RESPONSE)` cases.
- **API e2e** (⚠ `await moduleRef.close()` — the cron-hang lesson; every spec self-seeds reference data + self-cleans): dispatcher fan-out (in-app + email, per-channel recipients); scheduler seed-skips-past-tiers, claim-then-fire once, cancel-on-submit; expiry action (draft discard + `EXPIRED` + notices); **escalation parity after migration**; `NO_RESPONSE` rollup; `MessageLog` back-compat for the emails endpoint.
- **Lint is part of CI** — run `pnpm run lint` before commits.

## 13. Scope boundaries (deferred — NOT SB5)

Admin UI (templates + SMTP settings) · live `SmtpTransport` + SMTP config + `SENT`/`FAILED` · O-S4-6 amended-leg "<12h deadline" soft-warning · RFQ PDF (§8.4) · change-order `REOPENED` event (SB6) · multi-replica scheduler leader-lock. The framework is built so each of these is additive (a new transport, a new admin screen over existing rows, a new template + `dispatch()` call). **The Admin UI + live email are fully pre-designed in §17** so that later sub-build needs no re-brainstorm.

## 14. Implementation sequencing (detailed in the plan)

1. **Framework** — `comms` module (`MessageTemplate`, `MessageLog`, generalized `Notification`, `NotificationDispatcher`, `LogTransport`) + `ScheduledEvent` + scheduler. Seeded template loader.
2. **Migrate Stage 3** — move `FOLLOW_UP`/`ACKNOWLEDGEMENT`/`ESCALATION` + the escalation timers onto the framework; prove parity; retire `Escalation` + closed enums.
3. **RFQ usage** — distribute/amend/submit dispatch + reminder/expiry `ScheduledEvent`s + listeners + the RFQ/quote templates.
4. **Status** — `NO_RESPONSE` + projector extension.

Each phase is independently reviewable and CI-green before the next.

## 15. Open risks

- **Rename `EmailLog`→`MessageLog`** touches the emails module + its DTO/web view — contained, covered by back-compat tests (§11).
- **Escalation email recipient correction** (§11) — intentional; confirm no external consumer relied on the old (client-addressed) behaviour. Low risk (compose-&-log).
- **Token drift** — a template referencing a token the caller doesn't supply renders empty; the per-event token catalog test guards this.

## 16. Docs to update on completion

- `Stage 4 - Session Handoff.md` — move SB5 from the pending register to delivered; note the generic Comms framework as reusable by all stages; add the new tables to "What's built".
- `Stage 4 - Technical Design.md` — replace the RFQ-specific `RfqReminder`/`EmailLog` notes with the generic `ScheduledEvent`/`MessageTemplate`/`MessageLog` model.
- `Stage 3 - Session Handoff.md` — note that `Escalation`/`EmailLog`/`Notification` were generalized in SB5 (Stage-3 behaviour preserved; escalation email recipient corrected).

## 17. Deferred sub-build — Admin Configuration UI & Live Email (pre-designed)

> **None of this is in SB5.** It is captured here so the later build is fully scoped with no re-brainstorm. SB5 ships the data model + backend that all of this configures; the screens + the live transport are a dedicated later sub-build — a natural pairing with the **TLS/domain go-live gate** (the FF portal link must be HTTPS before real FFs). Everything below is **additive over SB5's tables** — no schema rework, except the SMTP secret store (§17.2).

### 17.1 Templates screen — configures `MessageTemplate`
- List all templates grouped by `eventKey` → channel (IN_APP/EMAIL); columns: event · channel · subject · active · updatedAt.
- **Add / edit / deactivate** a row: subject + body editors with a **token reference** (the `{{tokens}}` valid for that event, read from the shared `COMMS_EVENTS` catalog) and a **live preview** rendered against sample tokens.
- Adding a template for a new channel on an existing event (e.g. SMS later) = insert a row.
- **Backend (the endpoints SB5 deliberately omits):** `GET /admin/message-templates`, `GET /admin/message-templates/:key`, `PATCH /admin/message-templates/:key` (subject/body/active), `POST /admin/message-templates`. RBAC = Administrator.

### 17.2 SMTP / transport settings — enables live send
- Fields: host · port · secure/TLS · auth username · **password (write-only)** · from-address · **mode = compose-log ↔ live**.
- **"Send test email"** → composes via a chosen template + SMTP → reports success/failure.
- ⚠ **Secret handling:** the SMTP password is **never** stored in a plaintext config row or rendered back — it lives in an env var / secret store; the UI writes it through a write-only field (or leaves it to env). The settings row holds only non-secret fields + a "password set?" flag.
- **Backend:** `GET/PATCH /admin/comms-settings` (non-secret) · `POST /admin/comms-settings/test-send`. RBAC = Administrator.

### 17.3 Live transport — swaps `LogTransport`
- Implement `SmtpTransport` (e.g. `nodemailer`) behind SB5's `MessageTransport` interface; the DI provider swaps `useClass: LogTransport → SmtpTransport`, gated by `mode`.
- On send: `MessageLog.status` LOGGED → **SENT** (+ provider id) or **FAILED** (+ `error`); retry policy decided then.
- Pairs with **TLS/domain** — the same go-live gate.

### 17.4 Scheduler & notification rules — configures `AppSetting` + channels
- Edit the **deadline default** (`rfqDeadlineDefaultHours`) and **reminder offsets** (`rfqReminderOffsetsHours`).
- **Per-event channel toggles** — IN_APP/EMAIL on/off per event (today = the presence of an active `MessageTemplate`; the UI just flips `active`).
- Optional: per-event recipient-routing overrides.

### 17.5 Message-log viewer — reads `MessageLog`
- Browse/filter the delivery log (entity · event · channel · status · date); see failures and (when live) **resend**. A superset of the per-query `GET …/emails` view.

### 17.6 Notes
- All screens live under the existing `masters/admin` shell; RBAC = Administrator.
- No SB5 schema change is needed for §17.1/17.4/17.5 (pure CRUD over existing tables). §17.2/17.3 add the SMTP settings store + secret handling.
