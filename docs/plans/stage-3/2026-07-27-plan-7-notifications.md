# Plan 7 — Notifications / Escalations / Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the informational notifications / escalations / emails layer — a tiered escalation timer (in-app + logged email), client email compose-&-log (no live send), and an in-app notifications feed + the wizard's Send Follow-up / Send Acknowledgement actions + a per-query email log.

**Architecture:** Three new NestJS modules (`emails`, `notifications`, `escalations`) + one Prisma migration (Notification/Escalation/EmailLog). Escalations are **event-driven** (mirrors `StatusService`→`QueryStatusProjector`): `queries.service` emits `query.created`/`query.rfq_ready`; `EscalationsService` listens (create/cancel timers) and a `@nestjs/schedule` cron polls due rows → notifications + escalation email. Frontend: bell/feed in `AppLayout`, Send actions + email log in the wizard.

**Tech Stack:** NestJS 10 + Prisma 5 + `@nestjs/event-emitter` (installed) + `@nestjs/schedule` (**new**) · `@svyft/shared` const-enums + Zod · Vitest e2e (Supertest, GitHub CI) · Vite/React + shadcn/ui + TanStack Query · Vitest `renderWithProviders`/`mockFetch`.

**Design spec:** `docs/plans/stage-3/2026-07-27-plan-7-notifications-design.md` (read it first).

## Global Constraints

- **Compose-&-LOG only — never transmit email** (D12). `EmailLog.status = LOGGED`.
- **Escalation is informational only** (spec §14): no reassignment, no auto-close. **Fixed timers from first Save** (+30m/+2h/+6h); cancel unfired on `RFQ_READY`.
- **Escalation fan-out:** every **active** user with the tier's role gets a `Notification`; the escalation email is logged **once** per firing.
- **Local gate:** `pnpm --filter @svyft/shared build && pnpm run ci` — build shared FIRST (web vitest reads `@svyft/shared` from `dist`). Run `pnpm --filter @svyft/web typecheck` + `lint` before finishing.
- **API e2e runs on GitHub CI** (fresh migrated-but-UNSEEDED Postgres): every test **seed-independent + self-cleaning** (own rows by a unique prefix; a query delete cascades). No local DB this session → the migration + api e2e validate on CI.
- **Conventions:** const-object enums (never TS `enum`) pinned by a `toEqual` test; soft user refs = plain nullable `@db.Uuid` no relation; `PrismaExceptionFilter` maps P2025→404 (P2003 NOT mapped — guard FKs); bind Zod at param level via `ZodValidationPipe`; e2e uses a UUID jwt `sub`; cookie-parser default import in specs.
- **Branch:** `feat/plan-7-notifications` off `main`. Commit per task. Finish → PR to `main` + update `docs/Stage 3 - Session Handoff.md`.
- **Out of scope:** live send, SSE/WebSocket, BullMQ/Redis, change-order cascade, FF density, `manifestSnapshot`.

## File Structure

**`packages/shared/src/`**
- `notifications.ts` — CREATE: `NotificationType`, `EscalationTier`, `EmailTemplate`, `EmailStatus` const-enums + `NotificationDto`/`EmailLogDto`/`UnreadCountDto` types + tier→role/offset maps. `index.ts` re-exports.
- `notifications.test.ts` — CREATE: pinned `toEqual` arrays.

**`prisma/`**
- `schema.prisma` — MODIFY: 3 models + 4 enums.
- `migrations/<ts>_notifications_escalations_emails/migration.sql` — CREATE.

**`apps/api/src/`**
- `app.module.ts` — MODIFY: `ScheduleModule.forRoot()` + the 3 new modules.
- `modules/emails/` — CREATE: `emails.module.ts`, `emails.service.ts` (compose + render helpers), `emails.controller.ts`.
- `modules/notifications/` — CREATE: `notifications.module.ts`, `notifications.service.ts`, `notifications.controller.ts`.
- `modules/escalations/` — CREATE: `escalations.module.ts`, `escalations.service.ts`, `escalations.scheduler.ts`.
- `modules/queries/queries.service.ts` — MODIFY: inject `EventEmitter2`, emit `query.created` / `query.rfq_ready`.
- `modules/queries/queries.module.ts` — MODIFY: ensure `EventEmitterModule` available (already global via `forRoot`).
- `test/emails.e2e-spec.ts`, `test/notifications.e2e-spec.ts`, `test/escalations.e2e-spec.ts` — CREATE.

**`apps/web/src/`**
- `features/notifications/` — CREATE: `useNotifications.ts`, `NotificationBell.tsx` (+ `.test.tsx`).
- `components/AppLayout.tsx` — MODIFY: mount `<NotificationBell/>`.
- `features/query-wizard/` — MODIFY: `WizardShell.tsx` (Send actions in the action bar) + `steps/Step5Notes.tsx` (email log) + `useEmails.ts` hook (+ tests).

---

## Task 1: Shared enums + DTO types

**Files:**
- Create: `packages/shared/src/notifications.ts`, `packages/shared/src/notifications.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces — Produces:** `NotificationType` (`ESCALATION`), `EscalationTier` (`T30M`/`T2H`/`T6H`), `EmailTemplate` (`FOLLOW_UP`/`ACKNOWLEDGEMENT`/`ESCALATION`), `EmailStatus` (`LOGGED`); `TIER_ROLE: Record<EscalationTier, Role>`, `TIER_OFFSET_MS: Record<EscalationTier, number>`, `TIER_LABEL: Record<EscalationTier, string>`; types `NotificationDto`, `EmailLogDto`, `UnreadCountDto`.

- [ ] **Step 1: Write the failing test** — `packages/shared/src/notifications.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_TYPES, ESCALATION_TIERS, EMAIL_TEMPLATES, EMAIL_STATUSES,
  TIER_ROLE, TIER_OFFSET_MS,
} from "./notifications";
import { Role } from "./role";

describe("notifications enums", () => {
  it("pins the enum arrays", () => {
    expect(NOTIFICATION_TYPES).toEqual(["ESCALATION"]);
    expect(ESCALATION_TIERS).toEqual(["T30M", "T2H", "T6H"]);
    expect(EMAIL_TEMPLATES).toEqual(["FOLLOW_UP", "ACKNOWLEDGEMENT", "ESCALATION"]);
    expect(EMAIL_STATUSES).toEqual(["LOGGED"]);
  });
  it("maps tier → role and offset", () => {
    expect(TIER_ROLE).toEqual({ T30M: Role.EXECUTIVE, T2H: Role.MANAGER, T6H: Role.ADMINISTRATOR });
    expect(TIER_OFFSET_MS).toEqual({ T30M: 30 * 60_000, T2H: 120 * 60_000, T6H: 360 * 60_000 });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @svyft/shared test notifications` → FAIL (module not found).

- [ ] **Step 3: Implement** — `packages/shared/src/notifications.ts`:
```ts
import { Role } from "./role";

export const NotificationType = { ESCALATION: "ESCALATION" } as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];
export const NOTIFICATION_TYPES = Object.values(NotificationType) as [NotificationType, ...NotificationType[]];

export const EscalationTier = { T30M: "T30M", T2H: "T2H", T6H: "T6H" } as const;
export type EscalationTier = (typeof EscalationTier)[keyof typeof EscalationTier];
export const ESCALATION_TIERS = Object.values(EscalationTier) as [EscalationTier, ...EscalationTier[]];

export const EmailTemplate = {
  FOLLOW_UP: "FOLLOW_UP", ACKNOWLEDGEMENT: "ACKNOWLEDGEMENT", ESCALATION: "ESCALATION",
} as const;
export type EmailTemplate = (typeof EmailTemplate)[keyof typeof EmailTemplate];
export const EMAIL_TEMPLATES = Object.values(EmailTemplate) as [EmailTemplate, ...EmailTemplate[]];

export const EmailStatus = { LOGGED: "LOGGED" } as const;
export type EmailStatus = (typeof EmailStatus)[keyof typeof EmailStatus];
export const EMAIL_STATUSES = Object.values(EmailStatus) as [EmailStatus, ...EmailStatus[]];

export const TIER_ROLE: Record<EscalationTier, Role> = {
  T30M: Role.EXECUTIVE, T2H: Role.MANAGER, T6H: Role.ADMINISTRATOR,
};
export const TIER_OFFSET_MS: Record<EscalationTier, number> = {
  T30M: 30 * 60_000, T2H: 120 * 60_000, T6H: 360 * 60_000,
};
export const TIER_LABEL: Record<EscalationTier, string> = {
  T30M: "30-minute", T2H: "2-hour", T6H: "6-hour",
};

export type NotificationDto = {
  id: string; type: NotificationType; queryId: string | null;
  message: string; readAt: string | null; createdAt: string;
};
export type UnreadCountDto = { count: number };
export type EmailLogDto = {
  id: string; queryId: string; template: EmailTemplate; fromAddress: string;
  toAddress: string | null; subject: string; bodyRendered: string;
  status: EmailStatus; createdAt: string;
};
```
Then add to `packages/shared/src/index.ts`: `export * from "./notifications";`.

- [ ] **Step 4: Run to verify** — `pnpm --filter @svyft/shared test notifications && pnpm --filter @svyft/shared build` → PASS + dist rebuilt.

- [ ] **Step 5: Commit**
```bash
git add packages/shared/src/notifications.ts packages/shared/src/notifications.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): notifications/escalations/emails enums + DTO types"
```

---

## Task 2: Prisma models + migration #6 + `@nestjs/schedule`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_notifications_escalations_emails/migration.sql`
- Modify: `apps/api/package.json` (add `@nestjs/schedule`), `apps/api/src/app.module.ts`

**Interfaces — Produces:** Prisma models `Notification`, `Escalation`, `EmailLog` + enums `NotificationType`, `EscalationTier`, `EmailTemplate`, `EmailStatus`. `ScheduleModule` registered.

- [ ] **Step 1: Add models + enums to `prisma/schema.prisma`** (after the last model; mirror existing `@db.Uuid`/`tenantId` conventions):
```prisma
enum NotificationType { ESCALATION }
enum EscalationTier   { T30M T2H T6H }
enum EmailTemplate    { FOLLOW_UP ACKNOWLEDGEMENT ESCALATION }
enum EmailStatus      { LOGGED }

model Notification {
  id              String           @id @default(uuid()) @db.Uuid
  tenantId        String?          @db.Uuid
  recipientUserId String           @db.Uuid
  type            NotificationType
  queryId         String?          @db.Uuid
  query           Query?           @relation(fields: [queryId], references: [id], onDelete: Cascade)
  message         String
  readAt          DateTime?
  createdAt       DateTime         @default(now())
  @@index([recipientUserId, readAt])
  @@index([recipientUserId, createdAt])
}

model Escalation {
  id            String         @id @default(uuid()) @db.Uuid
  tenantId      String?        @db.Uuid
  queryId       String         @db.Uuid
  query         Query          @relation(fields: [queryId], references: [id], onDelete: Cascade)
  tier          EscalationTier
  recipientRole Role
  dueAt         DateTime
  firedAt       DateTime?
  cancelledAt   DateTime?
  createdAt     DateTime       @default(now())
  @@unique([queryId, tier])
  @@index([firedAt, cancelledAt, dueAt])
}

model EmailLog {
  id            String        @id @default(uuid()) @db.Uuid
  tenantId      String?       @db.Uuid
  queryId       String        @db.Uuid
  query         Query         @relation(fields: [queryId], references: [id], onDelete: Cascade)
  template      EmailTemplate
  fromAddress   String
  toAddress     String?
  subject       String
  bodyRendered  String
  tokens        Json
  composedById  String?       @db.Uuid
  status        EmailStatus   @default(LOGGED)
  createdAt     DateTime      @default(now())
  @@index([queryId, createdAt])
}
```
Add the back-relations on `model Query` (find the `Query` model, add): `notifications Notification[]` · `escalations Escalation[]` · `emailLogs EmailLog[]`.

- [ ] **Step 2: Generate the migration SQL (DB-less)** — this environment has no DB, so generate the SQL by diffing the migrations dir against the new schema:
```bash
mkdir -p prisma/migrations/$(date -u +%Y%m%d%H%M%S)_notifications_escalations_emails
pnpm --filter @svyft/api exec prisma migrate diff \
  --from-migrations ../../prisma/migrations \
  --to-schema-datamodel ../../prisma/schema.prisma \
  --script > prisma/migrations/<the-folder>/migration.sql
```
(If a local Postgres is available per README `:5433`, `prisma migrate dev --name notifications_escalations_emails --create-only` is equivalent.) Verify the SQL creates the 4 enum types + 3 tables + indexes + FKs (`ON DELETE CASCADE`). `prisma generate` to refresh the client.

- [ ] **Step 3: Install the scheduler + register modules** —
```bash
pnpm --filter @svyft/api add @nestjs/schedule
```
`apps/api/src/app.module.ts`: add `import { ScheduleModule } from "@nestjs/schedule";`, put `ScheduleModule.forRoot()` in `imports` (next to `EventEmitterModule.forRoot()`), and add `EmailsModule`, `NotificationsModule`, `EscalationsModule` (created in Tasks 3-5) to `imports`.

- [ ] **Step 4: Verify** — `pnpm --filter @svyft/api exec prisma generate && pnpm --filter @svyft/api build` → PASS. (Migration + e2e validate on CI.)

- [ ] **Step 5: Commit**
```bash
git add prisma/schema.prisma prisma/migrations apps/api/package.json pnpm-lock.yaml apps/api/src/app.module.ts
git commit -m "feat(api): migration #6 (Notification/Escalation/EmailLog) + @nestjs/schedule"
```

---

## Task 3: `emails` module — compose-&-log

**Files:**
- Create: `apps/api/src/modules/emails/emails.service.ts`, `emails.controller.ts`, `emails.module.ts`
- Create: `apps/api/test/emails.e2e-spec.ts`

**Interfaces — Produces:** `EmailsService.compose(template: EmailTemplate, queryId: string, composedById: string | null): Promise<EmailLog>` (consumed by Task 5). Endpoints `POST /queries/:id/emails/follow-up`, `POST …/acknowledgement`, `GET …/emails`. Pure render helper `renderEmail(template, ctx) → { subject, body, tokens }`.

- [ ] **Step 1: Write the failing e2e test** — `apps/api/test/emails.e2e-spec.ts` (mirror `points.e2e-spec.ts` harness: `beforeAll` boots AppModule + cookieParser + PrismaExceptionFilter + `setGlobalPrefix("api")`; `PFX = "p7-emails-"`; create a Query with a client contact + one unchecked checklist item). Key assertions:
```ts
it("composes + logs a follow-up with the missing-items list; nothing sent", async () => {
  const res = await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/emails/follow-up`)
    .set("Cookie", cookie()).expect(201);
  expect(res.body.template).toBe("FOLLOW_UP");
  expect(res.body.status).toBe("LOGGED");
  expect(res.body.subject).toContain(queryCode);
  expect(res.body.bodyRendered).toMatch(/Missing information/i);
  // the seeded unchecked item's label appears in the rendered body
  expect(res.body.bodyRendered).toContain(uncheckedLabel);
});
it("composes an acknowledgement with the 24h timeline", async () => {
  const res = await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/emails/acknowledgement`)
    .set("Cookie", cookie()).expect(201);
  expect(res.body.template).toBe("ACKNOWLEDGEMENT");
  expect(res.body.bodyRendered).toMatch(/24 hours/);
});
it("lists logged emails for the query", async () => {
  const res = await request(app.getHttpServer())
    .get(`/api/queries/${queryId}/emails`).set("Cookie", cookie()).expect(200);
  expect(res.body.length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Run to verify it fails** — (CI, or local if DB) → FAIL (routes 404).

- [ ] **Step 3: Implement `emails.service.ts`** — pure render + a `compose` that loads the query + checklist and writes an `EmailLog`:
```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { EmailTemplate, type EmailLogDto } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

const FROM = "logistics@yankalfa.com";
const RESPONSE_TIMELINE = "24 hours";

type Ctx = { queryCode: string; clientName: string; clientEmail: string | null; missing: string[] };

export function renderEmail(template: EmailTemplate, ctx: Ctx): { subject: string; body: string; tokens: Record<string, string> } {
  const tokens: Record<string, string> = {
    Query_ID: ctx.queryCode, Client_Name: ctx.clientName, Client_Email: ctx.clientEmail ?? "",
    Missing_Fields_List: ctx.missing.join(", "), Expected_Response_Timeline: RESPONSE_TIMELINE,
  };
  if (template === EmailTemplate.FOLLOW_UP) {
    return {
      subject: `Action Required: Missing Information for Your Shipment Request – ${ctx.queryCode}`,
      body: `Dear ${ctx.clientName || "Customer"},\n\nRegarding your shipment request ${ctx.queryCode}, we need the following to proceed.\nMissing information: ${ctx.missing.join(", ") || "—"}\n\nPlease reply to this email with the details.\n\nRegards,\nYankalfa Logistics`,
      tokens,
    };
  }
  if (template === EmailTemplate.ACKNOWLEDGEMENT) {
    return {
      subject: `Acknowledgement: Shipment Query Received – Query ID: ${ctx.queryCode}`,
      body: `Dear ${ctx.clientName || "Customer"},\n\nThank you — we have created a record for your shipment query (${ctx.queryCode}). We expect to respond within ${RESPONSE_TIMELINE}. Please reply on this thread with any additional documents.\n\nRegards,\nYankalfa Logistics`,
      tokens,
    };
  }
  // ESCALATION (internal record; not a client email)
  return {
    subject: `Escalation: Query ${ctx.queryCode} awaiting action`,
    body: `Query ${ctx.queryCode} has not progressed toward RFQ Ready and has been escalated for oversight.`,
    tokens,
  };
}

@Injectable()
export class EmailsService {
  constructor(private readonly prisma: PrismaService) {}

  async compose(template: EmailTemplate, queryId: string, composedById: string | null) {
    const q = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { id: true, queryCode: true, contactName: true, contactEmail: true },
    });
    if (!q) throw new NotFoundException("Query not found");
    let missing: string[] = [];
    if (template === EmailTemplate.FOLLOW_UP) {
      const items = await this.prisma.queryChecklistItem.findMany({ where: { queryId, checked: false } });
      const defs = await this.prisma.checklistDefinition.findMany();
      const label = new Map(defs.map((d) => [d.itemKey, d.label]));
      missing = items.map((i) => label.get(i.itemKey) ?? i.itemKey);
    }
    const { subject, body, tokens } = renderEmail(template, {
      queryCode: q.queryCode, clientName: q.contactName ?? "", clientEmail: q.contactEmail, missing,
    });
    return this.prisma.emailLog.create({
      data: {
        queryId, template, fromAddress: FROM, toAddress: q.contactEmail, subject,
        bodyRendered: body, tokens, composedById, status: "LOGGED",
      },
    });
  }

  async list(queryId: string): Promise<EmailLogDto[]> {
    const rows = await this.prisma.emailLog.findMany({ where: { queryId }, orderBy: { createdAt: "desc" } });
    return rows.map((r) => ({
      id: r.id, queryId: r.queryId, template: r.template, fromAddress: r.fromAddress,
      toAddress: r.toAddress, subject: r.subject, bodyRendered: r.bodyRendered,
      status: r.status, createdAt: r.createdAt.toISOString(),
    })) as EmailLogDto[];
  }
}
```

- [ ] **Step 4: Implement `emails.controller.ts` + `emails.module.ts`** — controller mirrors `PointsController` (`@Controller("queries/:id/emails")`; `@Post("follow-up")`/`@Post("acknowledgement")` call `compose(...)` with `@CurrentUser()`; `@Get()` calls `list`). Module: `providers: [EmailsService]`, `exports: [EmailsService]` (Task 5 imports it), `controllers: [EmailsController]`. Add to `app.module` imports (Task 2 Step 3).

- [ ] **Step 5: Verify + Commit** — `pnpm --filter @svyft/api build` (e2e on CI).
```bash
git add apps/api/src/modules/emails apps/api/test/emails.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): emails module (compose-&-log follow-up/acknowledgement + list)"
```

---

## Task 4: `notifications` module

**Files:**
- Create: `apps/api/src/modules/notifications/notifications.service.ts`, `notifications.controller.ts`, `notifications.module.ts`
- Create: `apps/api/test/notifications.e2e-spec.ts`

**Interfaces — Produces:** `NotificationsService.createMany(userIds: string[], data: { type; queryId?; message; tenantId? }): Promise<void>` (consumed by Task 5); `listForUser`, `unreadCount`, `markRead(id, userId)`. Endpoints `GET /notifications`, `GET /notifications/unread-count`, `PATCH /notifications/:id/read`.

- [ ] **Step 1: Write the failing e2e test** — `apps/api/test/notifications.e2e-spec.ts` (`PFX = "p7-notif-"`; seed two users U1/U2 with UUID ids; insert Notifications directly via prisma for U1). Assertions:
```ts
it("lists + counts only the caller's unread notifications", async () => {
  // 2 unread for U1, 1 for U2
  const count = await request(app.getHttpServer()).get("/api/notifications/unread-count").set("Cookie", cookie(U1)).expect(200);
  expect(count.body.count).toBe(2);
  const list = await request(app.getHttpServer()).get("/api/notifications").set("Cookie", cookie(U1)).expect(200);
  expect(list.body.every((n: { id: string }) => u1Ids.includes(n.id))).toBe(true);
});
it("marks a notification read (self-scoped) and 404s another user's", async () => {
  await request(app.getHttpServer()).patch(`/api/notifications/${u1NotifId}/read`).set("Cookie", cookie(U1)).expect(200);
  await request(app.getHttpServer()).patch(`/api/notifications/${u2NotifId}/read`).set("Cookie", cookie(U1)).expect(404);
});
```

- [ ] **Step 2: Run to verify it fails** — (CI) → FAIL.

- [ ] **Step 3: Implement `notifications.service.ts`:**
```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { NotificationType, type NotificationDto } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async createMany(
    userIds: string[],
    data: { type: NotificationType; queryId?: string; message: string; tenantId?: string | null },
  ): Promise<void> {
    if (!userIds.length) return;
    await this.prisma.notification.createMany({
      data: userIds.map((recipientUserId) => ({
        recipientUserId, type: data.type, queryId: data.queryId ?? null,
        message: data.message, tenantId: data.tenantId ?? null,
      })),
    });
  }

  async listForUser(userId: string, limit = 50): Promise<NotificationDto[]> {
    const rows = await this.prisma.notification.findMany({
      where: { recipientUserId: userId }, orderBy: { createdAt: "desc" }, take: limit,
    });
    return rows.map((r) => ({
      id: r.id, type: r.type, queryId: r.queryId, message: r.message,
      readAt: r.readAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
    }));
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { recipientUserId: userId, readAt: null } });
  }

  async markRead(id: string, userId: string): Promise<void> {
    const r = await this.prisma.notification.updateMany({
      where: { id, recipientUserId: userId }, data: { readAt: new Date() },
    });
    if (r.count === 0) throw new NotFoundException("Notification not found");
  }
}
```

- [ ] **Step 4: Implement controller + module** — `@Controller("notifications")`; `@Get()` → `listForUser(user.userId)`; `@Get("unread-count")` → `{ count: await unreadCount(user.userId) }`; `@Patch(":id/read")` → `markRead(id, user.userId)` (returns 200). Module `exports: [NotificationsService]`. Add to `app.module` imports.

- [ ] **Step 5: Verify + Commit**
```bash
git add apps/api/src/modules/notifications apps/api/test/notifications.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): notifications module (self-scoped feed + unread-count + mark-read)"
```

---

## Task 5: `escalations` module — timers + cron + firing

**Files:**
- Create: `apps/api/src/modules/escalations/escalations.service.ts`, `escalations.scheduler.ts`, `escalations.module.ts`
- Create: `apps/api/test/escalations.e2e-spec.ts`

**Interfaces — Consumes:** `EmailsService.compose` (Task 3), `NotificationsService.createMany` (Task 4), shared `ESCALATION_TIERS`/`TIER_ROLE`/`TIER_OFFSET_MS`/`TIER_LABEL`/`NotificationType`/`EmailTemplate`. **Produces:** `createForQuery(queryId, createdAt)`, `cancelForQuery(queryId)`, `runDue(now?)` + `@OnEvent` listeners (Task 6 emits the events).

- [ ] **Step 1: Write the failing e2e test** — `apps/api/test/escalations.e2e-spec.ts` (`PFX = "p7-esc-"`; seed a Manager user; create a Query). Drive the service directly (deterministic — do not wait for cron):
```ts
const svc = app.get(EscalationsService);
it("creates 3 fixed timers on createForQuery", async () => {
  await svc.createForQuery(queryId, new Date("2026-01-01T00:00:00Z"));
  const rows = await prisma.escalation.findMany({ where: { queryId }, orderBy: { dueAt: "asc" } });
  expect(rows.map((r) => r.tier)).toEqual(["T30M", "T2H", "T6H"]);
  expect(rows[0].dueAt.toISOString()).toBe("2026-01-01T00:30:00.000Z");
});
it("runDue fires due+unfired: notifications to role-holders + one escalation email + firedAt", async () => {
  await svc.runDue(new Date("2026-01-01T03:00:00Z")); // all three due
  const fired = await prisma.escalation.count({ where: { queryId, firedAt: { not: null } } });
  expect(fired).toBe(3);
  const emails = await prisma.emailLog.count({ where: { queryId, template: "ESCALATION" } });
  expect(emails).toBe(3); // one per firing
  const notifs = await prisma.notification.count({ where: { queryId } });
  expect(notifs).toBeGreaterThanOrEqual(1); // ≥1 Manager got the T2H notif
});
it("runDue is idempotent (no re-fire)", async () => {
  const before = await prisma.emailLog.count({ where: { queryId, template: "ESCALATION" } });
  await svc.runDue(new Date("2026-01-01T03:00:00Z"));
  expect(await prisma.emailLog.count({ where: { queryId, template: "ESCALATION" } })).toBe(before);
});
it("cancelForQuery stops unfired timers", async () => {
  await svc.createForQuery(q2, new Date());       // fresh query, dueAt in the future
  await svc.cancelForQuery(q2);
  await svc.runDue(new Date(Date.now() + 7 * 3600_000));
  expect(await prisma.escalation.count({ where: { queryId: q2, firedAt: { not: null } } })).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails** — (CI) → FAIL.

- [ ] **Step 3: Implement `escalations.service.ts`:**
```ts
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  ESCALATION_TIERS, TIER_ROLE, TIER_OFFSET_MS, TIER_LABEL, NotificationType, EmailTemplate,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailsService } from "../emails/emails.service";

@Injectable()
export class EscalationsService {
  private readonly logger = new Logger(EscalationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly emails: EmailsService,
  ) {}

  @OnEvent("query.created")
  async onQueryCreated(e: { queryId: string; createdAt: Date }): Promise<void> {
    try { await this.createForQuery(e.queryId, e.createdAt); }
    catch (err) { this.logger.error(`createForQuery failed for ${e.queryId}`, err as Error); }
  }

  @OnEvent("query.rfq_ready")
  async onQueryRfqReady(e: { queryId: string }): Promise<void> {
    try { await this.cancelForQuery(e.queryId); }
    catch (err) { this.logger.error(`cancelForQuery failed for ${e.queryId}`, err as Error); }
  }

  async createForQuery(queryId: string, createdAt: Date): Promise<void> {
    const q = await this.prisma.query.findUnique({ where: { id: queryId }, select: { tenantId: true } });
    for (const tier of ESCALATION_TIERS) {
      await this.prisma.escalation.upsert({
        where: { queryId_tier: { queryId, tier } },     // @@unique([queryId, tier]) → idempotent
        create: {
          queryId, tier, recipientRole: TIER_ROLE[tier],
          dueAt: new Date(createdAt.getTime() + TIER_OFFSET_MS[tier]), tenantId: q?.tenantId ?? null,
        },
        update: {},
      });
    }
  }

  async cancelForQuery(queryId: string): Promise<void> {
    await this.prisma.escalation.updateMany({
      where: { queryId, firedAt: null, cancelledAt: null }, data: { cancelledAt: new Date() },
    });
  }

  async runDue(now: Date = new Date()): Promise<{ fired: number }> {
    const due = await this.prisma.escalation.findMany({
      where: { dueAt: { lte: now }, firedAt: null, cancelledAt: null },
      include: { query: { select: { queryCode: true, tenantId: true } } },
    });
    let fired = 0;
    for (const esc of due) {
      // Claim the row first (idempotent under a racing cron): only proceed if WE set firedAt.
      const claim = await this.prisma.escalation.updateMany({
        where: { id: esc.id, firedAt: null, cancelledAt: null }, data: { firedAt: now },
      });
      if (claim.count === 0) continue;
      const users = await this.prisma.user.findMany({
        where: { role: esc.recipientRole, isActive: true }, select: { id: true },
      });
      await this.notifications.createMany(users.map((u) => u.id), {
        type: NotificationType.ESCALATION, queryId: esc.queryId, tenantId: esc.tenantId,
        message: `Query ${esc.query.queryCode} awaiting action — ${TIER_LABEL[esc.tier]} escalation`,
      });
      await this.emails.compose(EmailTemplate.ESCALATION, esc.queryId, null);
      fired++;
    }
    return { fired };
  }
}
```

- [ ] **Step 4: Implement `escalations.scheduler.ts` + module:**
```ts
// escalations.scheduler.ts
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { EscalationsService } from "./escalations.service";

@Injectable()
export class EscalationsScheduler {
  constructor(private readonly escalations: EscalationsService) {}
  @Cron(CronExpression.EVERY_MINUTE)
  async poll(): Promise<void> { await this.escalations.runDue(); }
}
```
`escalations.module.ts`: `imports: [NotificationsModule, EmailsModule]`, `providers: [EscalationsService, EscalationsScheduler]`, `exports: [EscalationsService]`. Add to `app.module` imports. (The `@OnEvent` listeners auto-register via `EventEmitterModule` — global.)

- [ ] **Step 5: Verify + Commit** — `pnpm --filter @svyft/api build` (e2e on CI).
```bash
git add apps/api/src/modules/escalations apps/api/test/escalations.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): escalations module (fixed timers, minute cron, role fan-out)"
```

---

## Task 6: Wire query lifecycle events

**Files:**
- Modify: `apps/api/src/modules/queries/queries.service.ts` (constructor + `create` + `createQuery`)
- Modify: `apps/api/test/queries.e2e-spec.ts` (add escalation-on-create + cancel-on-create-query assertions)

**Interfaces — Consumes:** `EscalationsService` `@OnEvent("query.created")`/`("query.rfq_ready")` (Task 5). **Produces:** emitted events `query.created` `{ queryId, createdAt }`, `query.rfq_ready` `{ queryId }`.

- [ ] **Step 1: Write the failing e2e test** — in `apps/api/test/queries.e2e-spec.ts` (or a new spec; reuse its harness):
```ts
import { EventEmitter2 } from "@nestjs/event-emitter";
// …
it("creating a query schedules 3 escalations; a rfq_ready event cancels them", async () => {
  const created = await request(app.getHttpServer()).post("/api/queries").set("Cookie", cookie())
    .send({ shipmentDescription: `${PFX}esc` }).expect(201);
  const id = created.body.id;
  // create() awaits emitAsync("query.created") → the 3 rows exist right after the response
  expect(await prisma.escalation.count({ where: { queryId: id, cancelledAt: null } })).toBe(3);
  // Assert the listener wiring for cancel WITHOUT needing a fully-valid route: emit rfq_ready.
  await app.get(EventEmitter2).emitAsync("query.rfq_ready", { queryId: id });
  expect(await prisma.escalation.count({ where: { queryId: id, cancelledAt: { not: null } } })).toBe(3);
});
```
(The direct `createQuery` path needs a fully valid route; this test isolates the event contract. `EscalationsService.cancelForQuery` itself is covered directly in the escalations e2e.)

- [ ] **Step 2: Run to verify it fails** — (CI) → FAIL (no escalations created).

- [ ] **Step 3: Implement** — `queries.service.ts`:
- Import + inject: `import { EventEmitter2 } from "@nestjs/event-emitter";` and add `private readonly events: EventEmitter2,` to the constructor params.
- In `create(...)`, capture the transaction result and emit **after commit**. Use `emitAsync` (awaited) so the escalation rows exist deterministically before the response returns; the listener's internal `try/catch` (Task 5) contains any failure so a listener error never fails the request:
```ts
  const created = await this.prisma.$transaction(async (tx) => { /* …existing… */ return this.getWithin(tx, query.id); });
  await this.events.emitAsync("query.created", { queryId: created.id, createdAt: new Date(created.createdAt) });
  return created;
```
- In `createQuery(...)`, after the rfqReadyAt transaction (before `return updated!`):
```ts
  await this.events.emitAsync("query.rfq_ready", { queryId: id });
```

- [ ] **Step 4: Verify + Commit** — `pnpm --filter @svyft/api build` (e2e on CI).
```bash
git add apps/api/src/modules/queries/queries.service.ts apps/api/test/queries.e2e-spec.ts
git commit -m "feat(api): emit query.created/query.rfq_ready → escalation timers"
```

---

## Task 7: Frontend — notifications bell + feed

**Files:**
- Create: `apps/web/src/features/notifications/useNotifications.ts`, `NotificationBell.tsx`, `NotificationBell.test.tsx`
- Modify: `apps/web/src/components/AppLayout.tsx`

**Interfaces — Consumes:** `GET /api/notifications`, `/unread-count`, `PATCH /:id/read`; shared `NotificationDto`.

- [ ] **Step 1: Write the failing test** — `NotificationBell.test.tsx` (mirror existing web tests; `renderWithProviders` + `mockFetch`; stub `/api/auth/me`, `/api/notifications/unread-count` → `{count:2}`, `/api/notifications` → two rows):
```tsx
it("shows the unread badge and opens the feed", async () => {
  // render <NotificationBell/>
  expect(await screen.findByText("2")).toBeInTheDocument();          // badge
  await userEvent.click(screen.getByRole("button", { name: /notifications/i }));
  expect(await screen.findByText(/awaiting action/i)).toBeInTheDocument(); // a feed item
});
it("marks an item read on click (PATCH fires)", async () => {
  // click a feed item → assert a PATCH /api/notifications/<id>/read call
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @svyft/web test NotificationBell` → FAIL.

- [ ] **Step 3: Implement `useNotifications.ts`** (TanStack Query, mirror `useOrgTimezone`):
```ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson, patchJson } from "@/lib/api";
import type { NotificationDto, UnreadCountDto } from "@svyft/shared";

export function useNotifications() {
  const qc = useQueryClient();
  const unread = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => fetchJson<UnreadCountDto>("/api/notifications/unread-count"),
    refetchInterval: 45_000,
  });
  const list = useQuery({
    queryKey: ["notifications", "list"],
    queryFn: () => fetchJson<NotificationDto[]>("/api/notifications"),
    enabled: false, // fetched on open (see NotificationBell)
  });
  const markRead = useMutation({
    mutationFn: (id: string) => patchJson(`/api/notifications/${id}/read`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notifications", "unread-count"] });
      void qc.invalidateQueries({ queryKey: ["notifications", "list"] });
    },
  });
  return { unreadCount: unread.data?.count ?? 0, list, markRead };
}
```

- [ ] **Step 4: Implement `NotificationBell.tsx`** — a shadcn `DropdownMenu` (or `Popover`) trigger: bell icon (`lucide-react` `Bell`) + a badge showing `unreadCount` when >0; on open, `list.refetch()`; render items (message + relative time); clicking an item calls `markRead.mutate(id)` and, if `queryId`, `navigate('/queries/'+queryId)`. `aria-label="Notifications"` on the trigger.

- [ ] **Step 5: Mount in `AppLayout.tsx`** — inside the right-side `<div className="flex items-center gap-3 …">`, before the user `<span>`: `<NotificationBell />`.

- [ ] **Step 6: Run to verify + typecheck + lint**
```bash
pnpm --filter @svyft/web test NotificationBell && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint
```

- [ ] **Step 7: Commit**
```bash
git add apps/web/src/features/notifications apps/web/src/components/AppLayout.tsx
git commit -m "feat(web): notifications bell + unread badge + feed in AppLayout"
```

---

## Task 8: Frontend — Send Follow-up / Acknowledgement + email log

**Files:**
- Create: `apps/web/src/features/query-wizard/useEmails.ts`
- Modify: `apps/web/src/features/query-wizard/WizardShell.tsx` (action bar) + `steps/Step5Notes.tsx` (email log)
- Modify/Create: `apps/web/src/features/query-wizard/steps/Step5Notes.test.tsx`

**Interfaces — Consumes:** `POST /api/queries/:id/emails/follow-up`, `/acknowledgement`, `GET …/emails`; the wizard `detail` (has `checklist`).

- [ ] **Step 1: Write the failing tests** — `Step5Notes.test.tsx`:
```tsx
it("Send Follow-up is disabled when every checklist item is checked", async () => {
  // detail.checklist all { checked: true } → button disabled
  expect(screen.getByRole("button", { name: /send follow-up/i })).toBeDisabled();
});
it("Send Follow-up POSTs when an item is unchecked", async () => {
  // detail.checklist has ≥1 { checked: false } → click → POST /emails/follow-up
});
it("Send Acknowledgement POSTs and the email appears in the log", async () => {
  // click → POST /emails/acknowledgement; GET /emails returns it → row rendered
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @svyft/web test Step5Notes` → FAIL.

- [ ] **Step 3: Implement `useEmails.ts`** — TanStack Query: `list` query (`["emails", queryId]` → `GET …/emails`), `sendFollowUp`/`sendAck` mutations (`postJson(...)`, invalidate `["emails", queryId]`). Mirror `useNotifications`.

- [ ] **Step 4: Implement the UI** —
  - `WizardShell.tsx`: in the final-step action bar (next to **Create Query**), add `Send Follow-up` (`disabled={checklist.every(c => c.checked)}`) → `sendFollowUp` + success toast; `Send Acknowledgement` (always enabled) → `sendAck` + toast. (Wire `queryId` + `checklist` from the wizard context/`detail`.)
  - `Step5Notes.tsx`: add a compact **Emails** section listing `useEmails(queryId).list` rows (template · subject · toAddress · time), newest first; empty state "No emails logged yet."

- [ ] **Step 5: Run the FULL web suite + typecheck + lint**
```bash
pnpm --filter @svyft/web test && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint
```
Expected: all green (a Radix Select test may flake once → re-run).

- [ ] **Step 6: Commit**
```bash
git add apps/web/src/features/query-wizard
git commit -m "feat(web): wizard Send Follow-up/Acknowledgement + per-query email log"
```

---

## Definition of Done

- [ ] All 8 tasks committed on `feat/plan-7-notifications`.
- [ ] **`pnpm --filter @svyft/shared build && pnpm run ci` green** locally for shared + web; `pnpm --filter @svyft/web typecheck` + `lint` clean.
- [ ] **GitHub CI green** — migration #6 applies + the 3 module e2e specs + the query-events spec pass (fresh migrated Postgres, no local DB this session).
- [ ] Opus **whole-branch review** — probes: events emitted **post-commit** (no orphan escalations on rollback), `runDue` **claim-then-fire** idempotency + role fan-out + single escalation email, `cancelForQuery` on RFQ_READY, compose-&-log **never sends** (`status=LOGGED`, no transport), notifications **self-scoped** (404 on another user's), the cron is a thin wrapper (e2e drives `runDue` directly), and the follow-up **enable-gate** matches the checklist.
- [ ] Finish via `superpowers:finishing-a-development-branch` → PR to `main`; update `docs/Stage 3 - Session Handoff.md` (Plan 7 shipped: 3 modules + migration #6 + cron + FE bell/feed + Send actions; escalation-clock = fixed-from-creation; role fan-out to all active role-holders).

## Self-Review notes (spec coverage)

- Data model (Notification/Escalation/EmailLog + enums + migration) → Tasks 1-2.
- Escalation scheduler (fixed timers, minute cron, due+unfired+not-cancelled, role fan-out, cancel on RFQ_READY, informational) → Tasks 5-6 (§8.2, spec §14).
- Email compose-&-log (§15 templates + tokens, follow-up missing-list, ack 24h, no send) → Task 3 (§8.7).
- Notifications feed (list/unread-count/mark-read, self-scoped, FE-polled) → Tasks 4, 7 (§8.3).
- Send Follow-up (enabled iff ≥1 unchecked) + Send Acknowledgement + email log → Task 8 (spec §13).
- Bell + unread badge + feed in AppLayout → Task 7 (§9.2).
- Event-driven lifecycle hook (decision 3), fixed clock (decision 2), role fan-out (decision 1) → Tasks 5-6.
- **Deferred:** live send (D12), SSE/WebSocket, BullMQ, auto-reassign/close, change-order cascade.
