# Task 2 Report: Prisma migration #6 (Notification/Escalation/EmailLog) + @nestjs/schedule

## Status: DONE

---

## Schema Changes

Added to `prisma/schema.prisma`:

### 4 New Enums (multi-line format required by Prisma):
- `NotificationType` — values: `ESCALATION`
- `EscalationTier` — values: `T30M`, `T2H`, `T6H`
- `EmailTemplate` — values: `FOLLOW_UP`, `ACKNOWLEDGEMENT`, `ESCALATION`
- `EmailStatus` — values: `LOGGED`

### 3 New Models (verbatim from brief):
- `Notification` — with `@@index([recipientUserId, readAt])` and `@@index([recipientUserId, createdAt])`, nullable `queryId` FK → Query ON DELETE CASCADE
- `Escalation` — with `@@unique([queryId, tier])` and `@@index([firedAt, cancelledAt, dueAt])`, required `queryId` FK → Query ON DELETE CASCADE
- `EmailLog` — with `@@index([queryId, createdAt])`, required `queryId` FK → Query ON DELETE CASCADE

### Back-relations added to `model Query`:
```prisma
notifications Notification[]
escalations   Escalation[]
emailLogs     EmailLog[]
```

---

## Migration SQL

**File:** `prisma/migrations/20260727081020_notifications_escalations_emails/migration.sql`

**Commands used:**
```bash
# Snapshot pre-change schema
cp prisma/schema.prisma /tmp/schema-before.prisma
# (edited schema, added enums + models + back-relations)
DATABASE_URL=... DIRECT_URL=... pnpm exec prisma validate --schema=prisma/schema.prisma
# → "The schema at prisma/schema.prisma is valid"

TS=20260727081020
mkdir -p prisma/migrations/${TS}_notifications_escalations_emails
DATABASE_URL=... DIRECT_URL=... pnpm exec prisma migrate diff \
  --from-schema-datamodel /tmp/schema-before.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/${TS}_notifications_escalations_emails/migration.sql

DATABASE_URL=... DIRECT_URL=... pnpm exec prisma generate --schema=prisma/schema.prisma
# → "Generated Prisma Client (v5.22.0) in 85ms"
```

**Key SQL content verified:**
- 4 `CREATE TYPE ... AS ENUM` statements (NotificationType, EscalationTier, EmailTemplate, EmailStatus)
- 3 `CREATE TABLE` statements (Notification, Escalation, EmailLog) — all UUID PKs, correct column types
- All indexes: `Notification_recipientUserId_readAt_idx`, `Notification_recipientUserId_createdAt_idx`, `Escalation_firedAt_cancelledAt_dueAt_idx`, `Escalation_queryId_tier_key` (UNIQUE), `EmailLog_queryId_createdAt_idx`
- 3 `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... ON DELETE CASCADE ON UPDATE CASCADE` pointing to `Query(id)`
- Migration is purely additive — no destructive operations

---

## @nestjs/schedule Installation

```bash
pnpm --filter @svyft/api add @nestjs/schedule
# → "+4" packages added, resolved 1032 packages
```

Updated files: `apps/api/package.json`, `pnpm-lock.yaml`

---

## app.module.ts Changes

Added:
- `import { ScheduleModule } from "@nestjs/schedule";`
- `ScheduleModule.forRoot()` in the `imports` array (next to `EventEmitterModule.forRoot()`)

Per the task instruction, did NOT add `EmailsModule`, `NotificationsModule`, or `EscalationsModule` — those do not exist yet (Tasks 3-5 create them).

---

## Build Result

```
pnpm --filter @svyft/api build
→ nest build
EXIT: 0  (success)
```

Confirms ScheduleModule wiring is correct and generated Prisma client types compile cleanly.

---

## Files Changed

1. `prisma/schema.prisma` — 4 enums + 3 models + 3 back-relations on Query
2. `prisma/migrations/20260727081020_notifications_escalations_emails/migration.sql` — new file
3. `apps/api/package.json` — @nestjs/schedule added
4. `pnpm-lock.yaml` — lockfile updated
5. `apps/api/src/app.module.ts` — ScheduleModule import + forRoot()

---

## Self-Review

- [x] Schema valid (`prisma validate` passes)
- [x] Migration SQL is additive — 4 CREATE TYPE, 3 CREATE TABLE, 5 indexes (incl. `@@unique([queryId, tier])`), 3 CASCADE FKs
- [x] `@nestjs/schedule` installed in `@svyft/api`
- [x] `ScheduleModule.forRoot()` added to app.module.ts
- [x] `EmailsModule`, `NotificationsModule`, `EscalationsModule` NOT added (they don't exist yet)
- [x] Query back-relations (`notifications`, `escalations`, `emailLogs`) present
- [x] API builds successfully (exit 0)

---

## Concerns

None. The single-line enum syntax in the brief (`enum Foo { A B C }`) is not valid Prisma PSL — multi-line was required and used. This is a brief formatting issue only; the values themselves are correct.
