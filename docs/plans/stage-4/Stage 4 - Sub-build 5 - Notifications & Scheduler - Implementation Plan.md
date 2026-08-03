# Stage 4 · Sub-build 5 — Notifications, Emails & Scheduler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic, configurable Comms + Scheduler framework (DB-backed templates, a dispatcher, one timer table, compose-&-log), migrate Stage-3 emails/escalations onto it, and use it for RFQ reminders/expiry/emails + the "No Response" status.

**Architecture:** Callers `dispatch(eventKey, { scope, tokens, recipients })` post-commit; the dispatcher renders active `MessageTemplate` rows per channel and writes `Notification` (in-app) + `MessageLog` (email, via a pluggable `LogTransport`). A single `ScheduledEvent` table + one minute-cron drains due timers by `emitAsync(eventKey)`; `@OnEvent` listeners do the work. Status changes only ever go through `StatusService.fire`.

**Tech Stack:** NestJS 10 + Prisma 5 (Postgres) · `@nestjs/schedule` (cron) · `@nestjs/event-emitter` · `@svyft/shared` (isomorphic const-enums + pure helpers) · Jest e2e (`apps/api/test/*.e2e-spec.ts`).

**Design of record:** `docs/Stage 4 - Sub-build 5 - Notifications & Scheduler - Design.md` (read §1 locked decisions, §4 data model, §5 dispatcher, §6 scheduler, §9 RFQ usage, §17 the deferred Admin UI).

## Global Constraints

- **Shared enums are `const`-object + union + `Object.values(...) as [X, ...X[]]`, pinned by a `toEqual` test. NEVER a TS `enum`.**
- **Build shared after every shared edit:** `pnpm --filter @svyft/shared build` (api/web resolve the built `dist`).
- **API has NO unit runner** — all api tests are `apps/api/test/*.e2e-spec.ts` (jest-e2e). A pure unit test may live there without booting `AppModule`.
- **Every full-AppModule e2e MUST `await app.close()` in `afterAll`** — the `@nestjs/schedule` cron keeps the process alive otherwise (the "11-hour hang"). Every e2e is self-contained: create + delete its own fixtures by a unique prefix; call `seedReferenceData(prisma)` in `beforeAll` if it needs reference data (CI runs `migrate deploy` with **no seed**).
- **Migrations are HAND-AUTHORED SQL + `prisma migrate deploy`** — `prisma migrate dev` drifts on the `CargoItem.volumeCbm` generated column (PG 42601). Local DB is Postgres on **`:5433`**. **If Prisma ever proposes a RESET/DROP, STOP** — it's a shared dev DB.
  - **Canonical local commands** (env lives in `apps/api/.env`, schema at root; the root prisma CLI does NOT auto-load `apps/api/.env`, and `--filter @svyft/api` points at a non-existent `apps/api/prisma/`):
    - Apply: `set -a; . apps/api/.env; set +a; pnpm exec prisma migrate deploy --schema prisma/schema.prisma`
    - Generate: `pnpm exec prisma generate --schema prisma/schema.prisma`
    - Status: `set -a; . apps/api/.env; set +a; pnpm exec prisma migrate status --schema prisma/schema.prisma`
- **Run api e2e via `pnpm --filter @svyft/api test <pattern>`** (jest loads `apps/api/.env` through NestJS `ConfigModule`). Shared: `pnpm --filter @svyft/shared test`; web: `pnpm --filter @svyft/web typecheck`.
- **Additive-first migrations:** add new tables/columns + backfill in one migration; drop legacy tables/columns only after code is cut over (a later task).
- **Lint is part of CI** (`pnpm run lint`) — run it before every commit. No destructure-to-omit (`const { x, ...rest }`); use `{ ...obj, x: undefined }`.
- **Status only via `StatusService.fire(entity, id, event, ctx)`**, called AFTER any `$transaction` (fire owns its own tx). Never hand-write a status column.
- **All SB5 dispatches use `scope = { entityType: "QUERY", entityId: <queryId> }`** so the in-app bell deep-links to the query and `GET /queries/:id/emails` keeps returning every message for a query. `ScheduledEvent` rows anchor to the RFQ (`entityType: "RFQ", entityId: <rfqId>`) so cancel-on-submit is keyed per RFQ.
- **Compose-&-log:** nothing is transmitted. `LogTransport.send()` is a no-op. `MessageStatus` stays `LOGGED`.

---

# Phase 1 — The generic framework

### Task 1: Shared comms vocabulary

**Files:**
- Create: `packages/shared/src/comms.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./comms";`)
- Test: `packages/shared/src/comms.test.ts`

**Interfaces:**
- Produces: `Channel` (`"IN_APP"|"EMAIL"`) + `CHANNELS`; `MessageStatus` (`"LOGGED"|"SENT"|"FAILED"`) + `MESSAGE_STATUSES`; `RFQ_DEADLINE_HOURS_KEY`, `RFQ_REMINDER_OFFSETS_KEY`, `DEFAULT_RFQ_DEADLINE_HOURS = 48`, `DEFAULT_RFQ_REMINDER_OFFSETS = [36,24,12,6,2]`; `COMMS_EVENTS` (record eventKey→token names), `CommsEventKey`, `COMMS_EVENT_KEYS`; `renderTemplate(tpl: string, tokens: Record<string,string>): string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/comms.test.ts
import { describe, it, expect } from "vitest";
import {
  Channel, CHANNELS, MessageStatus, MESSAGE_STATUSES,
  COMMS_EVENTS, COMMS_EVENT_KEYS, renderTemplate,
  DEFAULT_RFQ_DEADLINE_HOURS, DEFAULT_RFQ_REMINDER_OFFSETS,
} from "./comms";

describe("comms vocabulary", () => {
  it("pins the channel + status arrays", () => {
    expect(CHANNELS).toEqual(["IN_APP", "EMAIL"]);
    expect(MESSAGE_STATUSES).toEqual(["LOGGED", "SENT", "FAILED"]);
    expect(Channel.EMAIL).toBe("EMAIL");
    expect(MessageStatus.LOGGED).toBe("LOGGED");
  });

  it("pins the known event keys", () => {
    expect(COMMS_EVENT_KEYS).toEqual([
      "query.follow_up", "query.acknowledgement", "query.escalation",
      "rfq.invitation", "rfq.updated", "rfq.reminder", "rfq.expiry",
      "rfq.submission_ack", "quote.received",
    ]);
    expect(COMMS_EVENTS["rfq.reminder"]).toContain("Deadline");
  });

  it("renders {{tokens}} and blanks unknowns", () => {
    expect(renderTemplate("RFQ {{RFQ_Number}} due {{Deadline}}", { RFQ_Number: "Q-1", Deadline: "Fri" }))
      .toBe("RFQ Q-1 due Fri");
    expect(renderTemplate("Hi {{Missing}}", {})).toBe("Hi ");
  });

  it("exposes scheduler defaults", () => {
    expect(DEFAULT_RFQ_DEADLINE_HOURS).toBe(48);
    expect(DEFAULT_RFQ_REMINDER_OFFSETS).toEqual([36, 24, 12, 6, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/shared test -- comms`
Expected: FAIL — cannot resolve `./comms`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/comms.ts

// Delivery channels a message event may fan out to (Design §3).
export const Channel = { IN_APP: "IN_APP", EMAIL: "EMAIL" } as const;
export type Channel = (typeof Channel)[keyof typeof Channel];
export const CHANNELS = Object.values(Channel) as [Channel, ...Channel[]];

// Delivery status of an outbound message. LOGGED now; SENT/FAILED when live (Design §17.3).
export const MessageStatus = { LOGGED: "LOGGED", SENT: "SENT", FAILED: "FAILED" } as const;
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];
export const MESSAGE_STATUSES = Object.values(MessageStatus) as [MessageStatus, ...MessageStatus[]];

// AppSetting keys for scheduler scalars (Design §7). Editable via seed/DB.
export const RFQ_DEADLINE_HOURS_KEY = "rfqDeadlineDefaultHours";
export const RFQ_REMINDER_OFFSETS_KEY = "rfqReminderOffsetsHours";
export const DEFAULT_RFQ_DEADLINE_HOURS = 48;
export const DEFAULT_RFQ_REMINDER_OFFSETS = [36, 24, 12, 6, 2];

// Known comms events + the tokens each template may reference. Test-pinned; the future
// admin editor (Design §17.1) reads this to show "available tokens".
export const COMMS_EVENTS = {
  "query.follow_up": ["Query_ID", "Client_Name", "Missing_Fields_List", "Expected_Response_Timeline"],
  "query.acknowledgement": ["Query_ID", "Client_Name", "Expected_Response_Timeline"],
  "query.escalation": ["Query_ID", "Tier_Label"],
  "rfq.invitation": ["RFQ_Number", "Leg_Names", "Deadline", "Access_Link"],
  "rfq.updated": ["RFQ_Number", "Leg_Names"],
  "rfq.reminder": ["RFQ_Number", "Deadline"],
  "rfq.expiry": ["RFQ_Number", "FF_Name", "Leg_Name"],
  "rfq.submission_ack": ["RFQ_Number"],
  "quote.received": ["RFQ_Number", "FF_Name", "Leg_Name"],
} as const;
export type CommsEventKey = keyof typeof COMMS_EVENTS;
export const COMMS_EVENT_KEYS = Object.keys(COMMS_EVENTS) as CommsEventKey[];

// Pure token substitution: {{Token}} → tokens[Token] ?? "".
export function renderTemplate(tpl: string, tokens: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => tokens[k] ?? "");
}
```

Add to `packages/shared/src/index.ts` (after `export * from "./notifications";`):

```ts
export * from "./comms";
```

- [ ] **Step 4: Run tests + build shared**

Run: `pnpm --filter @svyft/shared test -- comms && pnpm --filter @svyft/shared build`
Expected: PASS; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/comms.ts packages/shared/src/comms.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): comms vocabulary — channels, message status, event/token catalog, renderTemplate"
```

---

### Task 2: Schema — `MessageTemplate` / `MessageLog` / `ScheduledEvent`, generalize `Notification`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_comms_framework/migration.sql`
- Create: `apps/api/src/seed/message-templates.seed.ts`
- Modify: `apps/api/src/seed/reference-seed.ts` (seed AppSetting defaults + call the template seed)
- Modify: `apps/api/src/modules/notifications/notifications.service.ts` (generalize `createMany`)
- Test: `apps/api/test/comms-schema.e2e-spec.ts`

**Interfaces:**
- Produces: Prisma models `MessageTemplate`, `MessageLog`, `ScheduledEvent`; enums `Channel`, `MessageStatus`; `Notification.type: String` + `entityType`/`entityId`; `QueryStatus` unchanged here (NO_RESPONSE lands in Task 12). `NotificationsService.createMany(userIds, { type: string; queryId?; entityType?; entityId?; message; tenantId? })`. `seedMessageTemplates(prisma)`.

- [ ] **Step 1: Edit `prisma/schema.prisma`** — add enums + models, generalize `Notification`.

Add near the other enums:

```prisma
enum Channel {
  IN_APP
  EMAIL
}

enum MessageStatus {
  LOGGED
  SENT
  FAILED
}
```

Add three models:

```prisma
model MessageTemplate {
  key       String   @id
  eventKey  String
  channel   Channel
  subject   String?
  body      String
  active    Boolean  @default(true)
  updatedAt DateTime @updatedAt

  @@unique([eventKey, channel])
}

model MessageLog {
  id           String        @id @default(uuid()) @db.Uuid
  tenantId     String?       @db.Uuid
  entityType   String
  entityId     String        @db.Uuid
  eventKey     String
  channel      Channel
  templateKey  String
  fromAddress  String
  toAddress    String?
  subject      String?
  bodyRendered String
  tokens       Json
  composedById String?       @db.Uuid
  status       MessageStatus @default(LOGGED)
  error        String?
  createdAt    DateTime      @default(now())

  @@index([entityType, entityId, createdAt])
}

model ScheduledEvent {
  id          String    @id @default(uuid()) @db.Uuid
  tenantId    String?   @db.Uuid
  entityType  String
  entityId    String    @db.Uuid
  eventKey    String
  tier        String
  dueAt       DateTime
  firedAt     DateTime?
  cancelledAt DateTime?
  payload     Json?
  createdAt   DateTime  @default(now())

  @@unique([entityType, entityId, eventKey, tier])
  @@index([dueAt, firedAt, cancelledAt])
}
```

Change the existing `Notification` model's `type` field and add the anchor (leave `queryId`/`query` relation intact):

```prisma
model Notification {
  id              String    @id @default(uuid()) @db.Uuid
  tenantId        String?   @db.Uuid
  recipientUserId String    @db.Uuid
  type            String
  entityType      String?
  entityId        String?   @db.Uuid
  queryId         String?   @db.Uuid
  query           Query?    @relation(fields: [queryId], references: [id], onDelete: Cascade)
  message         String
  readAt          DateTime?
  createdAt       DateTime  @default(now())

  @@index([recipientUserId, readAt])
  @@index([recipientUserId, createdAt])
}
```

- [ ] **Step 2: Hand-author the migration SQL**

Create `prisma/migrations/<timestamp>_comms_framework/migration.sql` (use a timestamp after the latest existing migration, format `YYYYMMDDHHMMSS_comms_framework`):

```sql
-- enums
CREATE TYPE "Channel" AS ENUM ('IN_APP', 'EMAIL');
CREATE TYPE "MessageStatus" AS ENUM ('LOGGED', 'SENT', 'FAILED');

-- MessageTemplate
CREATE TABLE "MessageTemplate" (
  "key" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "channel" "Channel" NOT NULL,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("key")
);
CREATE UNIQUE INDEX "MessageTemplate_eventKey_channel_key" ON "MessageTemplate"("eventKey", "channel");

-- MessageLog
CREATE TABLE "MessageLog" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "entityType" TEXT NOT NULL,
  "entityId" UUID NOT NULL,
  "eventKey" TEXT NOT NULL,
  "channel" "Channel" NOT NULL,
  "templateKey" TEXT NOT NULL,
  "fromAddress" TEXT NOT NULL,
  "toAddress" TEXT,
  "subject" TEXT,
  "bodyRendered" TEXT NOT NULL,
  "tokens" JSONB NOT NULL,
  "composedById" UUID,
  "status" "MessageStatus" NOT NULL DEFAULT 'LOGGED',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MessageLog_entityType_entityId_createdAt_idx" ON "MessageLog"("entityType", "entityId", "createdAt");

-- ScheduledEvent
CREATE TABLE "ScheduledEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "entityType" TEXT NOT NULL,
  "entityId" UUID NOT NULL,
  "eventKey" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "firedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduledEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ScheduledEvent_entityType_entityId_eventKey_tier_key" ON "ScheduledEvent"("entityType", "entityId", "eventKey", "tier");
CREATE INDEX "ScheduledEvent_dueAt_firedAt_cancelledAt_idx" ON "ScheduledEvent"("dueAt", "firedAt", "cancelledAt");

-- generalize Notification.type (enum → text) + add the generic anchor
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE TEXT USING "type"::text;
ALTER TABLE "Notification" ADD COLUMN "entityType" TEXT;
ALTER TABLE "Notification" ADD COLUMN "entityId" UUID;
```

> Note: the `NotificationType` DB enum is now unused but left in place; it is dropped in Task 7 with the other legacy enums.

- [ ] **Step 3: Apply the migration locally + regenerate the client**

Run:
```bash
set -a; . apps/api/.env; set +a; pnpm exec prisma migrate deploy --schema prisma/schema.prisma
pnpm exec prisma generate --schema prisma/schema.prisma
```
Expected: migration applied to `:5433`; client regenerated. (If `migrate deploy` reports drift, do NOT reset — verify the SQL matches `schema.prisma` and retry.)

- [ ] **Step 4: Write the template seed**

```ts
// apps/api/src/seed/message-templates.seed.ts
import { PrismaClient } from "@prisma/client";

// Seed rows are create-only (Design §7): defaults on first deploy, never overwriting an edit.
// Stage-3 templates (migrated). RFQ/quote templates are appended in Task 8.
export const MESSAGE_TEMPLATES: {
  key: string; eventKey: string; channel: "IN_APP" | "EMAIL"; subject: string | null; body: string;
}[] = [
  {
    key: "query.follow_up.email", eventKey: "query.follow_up", channel: "EMAIL",
    subject: "Action Required: Missing Information for Your Shipment Request – {{Query_ID}}",
    body: "Dear {{Client_Name}},\n\nRegarding your shipment request {{Query_ID}}, we need the following to proceed.\nMissing information: {{Missing_Fields_List}}\n\nPlease reply to this email with the details.\n\nRegards,\nYankalfa Logistics",
  },
  {
    key: "query.acknowledgement.email", eventKey: "query.acknowledgement", channel: "EMAIL",
    subject: "Acknowledgement: Shipment Query Received – Query ID: {{Query_ID}}",
    body: "Dear {{Client_Name}},\n\nThank you — we have created a record for your shipment query ({{Query_ID}}). We expect to respond within {{Expected_Response_Timeline}}. Please reply on this thread with any additional documents.\n\nRegards,\nYankalfa Logistics",
  },
  {
    key: "query.escalation.email", eventKey: "query.escalation", channel: "EMAIL",
    subject: "Escalation: Query {{Query_ID}} awaiting action",
    body: "Query {{Query_ID}} has not progressed toward RFQ Ready and has been escalated for oversight ({{Tier_Label}}).",
  },
  {
    key: "query.escalation.inapp", eventKey: "query.escalation", channel: "IN_APP",
    subject: null,
    body: "Query {{Query_ID}} awaiting action — {{Tier_Label}} escalation",
  },
];

export async function seedMessageTemplates(prisma: PrismaClient): Promise<void> {
  for (const t of MESSAGE_TEMPLATES) {
    await prisma.messageTemplate.upsert({ where: { key: t.key }, create: t, update: {} });
  }
}
```

- [ ] **Step 5: Wire the seed into `reference-seed.ts`**

In `apps/api/src/seed/reference-seed.ts`, add imports at the top:

```ts
import { RFQ_DEADLINE_HOURS_KEY, RFQ_REMINDER_OFFSETS_KEY, DEFAULT_RFQ_DEADLINE_HOURS, DEFAULT_RFQ_REMINDER_OFFSETS } from "@svyft/shared";
import { seedMessageTemplates } from "./message-templates.seed";
```

At the end of `seedReferenceData`, after the org-timezone `appSetting.upsert`, add:

```ts
  await prisma.appSetting.upsert({
    where: { key: RFQ_DEADLINE_HOURS_KEY },
    create: { key: RFQ_DEADLINE_HOURS_KEY, value: String(DEFAULT_RFQ_DEADLINE_HOURS) },
    update: {},
  });
  await prisma.appSetting.upsert({
    where: { key: RFQ_REMINDER_OFFSETS_KEY },
    create: { key: RFQ_REMINDER_OFFSETS_KEY, value: DEFAULT_RFQ_REMINDER_OFFSETS.join(",") },
    update: {},
  });
  await seedMessageTemplates(prisma);
```

- [ ] **Step 6: Generalize `NotificationsService.createMany`**

Replace the method body in `apps/api/src/modules/notifications/notifications.service.ts` — change the `type` param to `string` and thread the anchor:

```ts
  async createMany(
    userIds: string[],
    data: { type: string; queryId?: string | null; entityType?: string | null; entityId?: string | null; message: string; tenantId?: string | null },
  ): Promise<void> {
    if (!userIds.length) return;
    await this.prisma.notification.createMany({
      data: userIds.map((recipientUserId) => ({
        recipientUserId,
        type: data.type,
        queryId: data.queryId ?? null,
        entityType: data.entityType ?? null,
        entityId: data.entityId ?? null,
        message: data.message,
        tenantId: data.tenantId ?? null,
      })),
    });
  }
```

Also change the import line `import { NotificationType, type NotificationDto } from "@svyft/shared";` to `import type { NotificationDto } from "@svyft/shared";` (the enum is no longer referenced here). In `packages/shared/src/notifications.ts`, change `NotificationDto.type` from `NotificationType` to `string`, then rebuild shared. *(The `NotificationType` const stays until Task 7.)*

- [ ] **Step 7: Write the schema/seed e2e**

```ts
// apps/api/test/comms-schema.e2e-spec.ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";
import { NotificationsService } from "../src/modules/notifications/notifications.service";
import { randomUUID } from "crypto";

describe("Comms schema + seed (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifications: NotificationsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    notifications = app.get(NotificationsService);
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it("seeds the Stage-3 templates + scheduler AppSettings", async () => {
    const tpl = await prisma.messageTemplate.findUnique({ where: { key: "query.escalation.inapp" } });
    expect(tpl?.eventKey).toBe("query.escalation");
    expect(tpl?.channel).toBe("IN_APP");
    const deadline = await prisma.appSetting.findUnique({ where: { key: "rfqDeadlineDefaultHours" } });
    expect(deadline?.value).toBe("48");
  });

  it("NotificationsService writes a string type + entity anchor", async () => {
    const uid = randomUUID();
    await notifications.createMany([uid], {
      type: "quote.received", entityType: "QUERY", entityId: randomUUID(),
      message: "hi", queryId: null,
    });
    const row = await prisma.notification.findFirst({ where: { recipientUserId: uid } });
    expect(row?.type).toBe("quote.received");
    expect(row?.entityType).toBe("QUERY");
    await prisma.notification.deleteMany({ where: { recipientUserId: uid } });
  });
});
```

- [ ] **Step 8: Run, lint, commit**

Run: `pnpm --filter @svyft/shared build && pnpm --filter @svyft/api test -- comms-schema && pnpm run lint`
Expected: PASS.

```bash
git add prisma/schema.prisma prisma/migrations apps/api/src/seed packages/shared/src/notifications.ts apps/api/src/modules/notifications/notifications.service.ts apps/api/test/comms-schema.e2e-spec.ts
git commit -m "feat(comms): MessageTemplate/MessageLog/ScheduledEvent schema + seed; generalize Notification"
```

---

### Task 3: `MessageTemplateService`

**Files:**
- Create: `apps/api/src/modules/comms/message-template.service.ts`
- Test: `apps/api/test/message-template.e2e-spec.ts`

**Interfaces:**
- Consumes: Prisma `messageTemplate`.
- Produces: `MessageTemplateService.lookup(eventKey: string, channel: Channel): Promise<{ key: string; subject: string | null; body: string } | null>` — returns the **active** row for `(eventKey, channel)` or `null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/message-template.e2e-spec.ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { MessageTemplateService } from "../src/modules/comms/message-template.service";

describe("MessageTemplateService (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let svc: MessageTemplateService;
  const KEY = "test.evt.email";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    svc = app.get(MessageTemplateService);
    await prisma.messageTemplate.deleteMany({ where: { eventKey: "test.evt" } });
    await prisma.messageTemplate.create({
      data: { key: KEY, eventKey: "test.evt", channel: "EMAIL", subject: "S {{X}}", body: "B {{X}}", active: true },
    });
  });

  afterAll(async () => {
    await prisma.messageTemplate.deleteMany({ where: { eventKey: "test.evt" } });
    await app.close();
  });

  it("returns the active row for (eventKey, channel)", async () => {
    const row = await svc.lookup("test.evt", "EMAIL");
    expect(row).toEqual({ key: KEY, subject: "S {{X}}", body: "B {{X}}" });
  });

  it("returns null for an inactive template", async () => {
    await prisma.messageTemplate.update({ where: { key: KEY }, data: { active: false } });
    expect(await svc.lookup("test.evt", "EMAIL")).toBeNull();
    await prisma.messageTemplate.update({ where: { key: KEY }, data: { active: true } });
  });

  it("returns null when no template exists for the channel", async () => {
    expect(await svc.lookup("test.evt", "IN_APP")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/api test -- message-template`
Expected: FAIL — cannot resolve `MessageTemplateService`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/comms/message-template.service.ts
import { Injectable } from "@nestjs/common";
import type { Channel } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class MessageTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  async lookup(
    eventKey: string,
    channel: Channel,
  ): Promise<{ key: string; subject: string | null; body: string } | null> {
    const row = await this.prisma.messageTemplate.findFirst({
      where: { eventKey, channel, active: true },
      select: { key: true, subject: true, body: true },
    });
    return row;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/api test -- message-template`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/comms/message-template.service.ts apps/api/test/message-template.e2e-spec.ts
git commit -m "feat(comms): MessageTemplateService.lookup active template by (eventKey, channel)"
```

---

### Task 4: `LogTransport` + `NotificationDispatcher`

**Files:**
- Create: `apps/api/src/modules/comms/transport.ts` (interface + `MESSAGE_TRANSPORT` token + `LogTransport`)
- Create: `apps/api/src/modules/comms/notification-dispatcher.service.ts`
- Test: `apps/api/test/notification-dispatcher.e2e-spec.ts`

**Interfaces:**
- Consumes: `MessageTemplateService.lookup`; Prisma `notification`, `messageLog`.
- Produces: `MESSAGE_TRANSPORT` (DI token); `MessageTransport { send(messageLogId: string): Promise<void> }`; `LogTransport`; `NotificationDispatcher.dispatch(eventKey: string, input: DispatchInput): Promise<void>` where `DispatchInput = { scope: { entityType: string; entityId: string }; tokens: Record<string,string>; recipients: { IN_APP?: string[]; EMAIL?: string[] }; composedById?: string | null; tenantId?: string | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/notification-dispatcher.e2e-spec.ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { NotificationDispatcher } from "../src/modules/comms/notification-dispatcher.service";
import { randomUUID } from "crypto";

describe("NotificationDispatcher (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: NotificationDispatcher;
  const userId = randomUUID();
  const entityId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    dispatcher = app.get(NotificationDispatcher);
    await prisma.messageTemplate.deleteMany({ where: { eventKey: "test.dispatch" } });
    await prisma.messageTemplate.createMany({
      data: [
        { key: "test.dispatch.email", eventKey: "test.dispatch", channel: "EMAIL", subject: "Hi {{Name}}", body: "Body {{Name}}", active: true },
        { key: "test.dispatch.inapp", eventKey: "test.dispatch", channel: "IN_APP", subject: null, body: "InApp {{Name}}", active: true },
      ],
    });
  });

  afterAll(async () => {
    await prisma.messageTemplate.deleteMany({ where: { eventKey: "test.dispatch" } });
    await prisma.messageLog.deleteMany({ where: { entityId } });
    await prisma.notification.deleteMany({ where: { recipientUserId: userId } });
    await app.close();
  });

  it("writes a Notification (IN_APP) and a MessageLog (EMAIL), both rendered", async () => {
    await dispatcher.dispatch("test.dispatch", {
      scope: { entityType: "QUERY", entityId },
      tokens: { Name: "Acme" },
      recipients: { IN_APP: [userId], EMAIL: ["ff@x.com"] },
    });
    const notif = await prisma.notification.findFirst({ where: { recipientUserId: userId, entityId } });
    expect(notif?.message).toBe("InApp Acme");
    expect(notif?.type).toBe("test.dispatch");
    const log = await prisma.messageLog.findFirst({ where: { entityId, channel: "EMAIL" } });
    expect(log?.subject).toBe("Hi Acme");
    expect(log?.bodyRendered).toBe("Body Acme");
    expect(log?.toAddress).toBe("ff@x.com");
    expect(log?.status).toBe("LOGGED");
  });

  it("skips a channel with no active template", async () => {
    const otherEntity = randomUUID();
    await dispatcher.dispatch("test.dispatch", {
      scope: { entityType: "QUERY", entityId: otherEntity },
      tokens: { Name: "Z" },
      recipients: { EMAIL: ["a@b.com"] }, // no IN_APP recipients → no notification
    });
    expect(await prisma.notification.count({ where: { entityId: otherEntity } })).toBe(0);
    expect(await prisma.messageLog.count({ where: { entityId: otherEntity } })).toBe(1);
    await prisma.messageLog.deleteMany({ where: { entityId: otherEntity } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/api test -- notification-dispatcher`
Expected: FAIL — cannot resolve `NotificationDispatcher`.

- [ ] **Step 3: Write the transport**

```ts
// apps/api/src/modules/comms/transport.ts
import { Injectable } from "@nestjs/common";

export const MESSAGE_TRANSPORT = Symbol("MESSAGE_TRANSPORT");

export interface MessageTransport {
  send(messageLogId: string): Promise<void>;
}

// Compose-&-log: the message row IS the deliverable; nothing is transmitted (Design §1, §17.3).
@Injectable()
export class LogTransport implements MessageTransport {
  async send(_messageLogId: string): Promise<void> {
    // no-op until SmtpTransport lands at the go-live gate.
  }
}
```

- [ ] **Step 4: Write the dispatcher**

```ts
// apps/api/src/modules/comms/notification-dispatcher.service.ts
import { Inject, Injectable } from "@nestjs/common";
import { Channel, renderTemplate } from "@svyft/shared";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MessageTemplateService } from "./message-template.service";
import { MESSAGE_TRANSPORT, type MessageTransport } from "./transport";

const FROM = "logistics@yankalfa.com";

export type DispatchInput = {
  scope: { entityType: string; entityId: string };
  tokens: Record<string, string>;
  recipients: { IN_APP?: string[]; EMAIL?: string[] };
  composedById?: string | null;
  tenantId?: string | null;
};

@Injectable()
export class NotificationDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: MessageTemplateService,
    @Inject(MESSAGE_TRANSPORT) private readonly transport: MessageTransport,
  ) {}

  async dispatch(eventKey: string, input: DispatchInput): Promise<void> {
    const { scope, tokens } = input;

    const inApp = input.recipients.IN_APP ?? [];
    if (inApp.length) {
      const tpl = await this.templates.lookup(eventKey, Channel.IN_APP);
      if (tpl) {
        const message = renderTemplate(tpl.body, tokens);
        await this.prisma.notification.createMany({
          data: inApp.map((recipientUserId) => ({
            recipientUserId,
            type: eventKey,
            entityType: scope.entityType,
            entityId: scope.entityId,
            queryId: scope.entityType === "QUERY" ? scope.entityId : null,
            message,
            tenantId: input.tenantId ?? null,
          })),
        });
      }
    }

    const emails = input.recipients.EMAIL ?? [];
    if (emails.length) {
      const tpl = await this.templates.lookup(eventKey, Channel.EMAIL);
      if (tpl) {
        const subject = renderTemplate(tpl.subject ?? "", tokens);
        const body = renderTemplate(tpl.body, tokens);
        for (const to of emails) {
          const log = await this.prisma.messageLog.create({
            data: {
              entityType: scope.entityType,
              entityId: scope.entityId,
              eventKey,
              channel: Channel.EMAIL,
              templateKey: tpl.key,
              fromAddress: FROM,
              toAddress: to,
              subject,
              bodyRendered: body,
              tokens: tokens as unknown as Prisma.InputJsonValue,
              composedById: input.composedById ?? null,
              tenantId: input.tenantId ?? null,
            },
          });
          await this.transport.send(log.id);
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @svyft/api test -- notification-dispatcher`
Expected: PASS. (The `CommsModule` providing these is added in Task 5; to run this task's test before Task 5, temporarily add the providers — but prefer implementing Task 5's module wiring now so `app.get(NotificationDispatcher)` resolves.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/comms/transport.ts apps/api/src/modules/comms/notification-dispatcher.service.ts apps/api/test/notification-dispatcher.e2e-spec.ts
git commit -m "feat(comms): NotificationDispatcher + LogTransport (compose-&-log per-channel fan-out)"
```

---

### Task 5: `ScheduledEventService` + cron + `CommsModule`

**Files:**
- Create: `apps/api/src/modules/comms/scheduled-event.service.ts`
- Create: `apps/api/src/modules/comms/scheduled-event.scheduler.ts`
- Create: `apps/api/src/modules/comms/comms.module.ts`
- Modify: `apps/api/src/app.module.ts` (import `CommsModule`)
- Test: `apps/api/test/scheduled-event.e2e-spec.ts`

**Interfaces:**
- Consumes: Prisma `scheduledEvent`; `EventEmitter2`.
- Produces: `ScheduledEventService.schedule(entityType, entityId, eventKey, entries: { tier: string; dueAt: Date }[], opts?: { tenantId?: string | null; now?: Date }): Promise<void>` (skips entries with `dueAt <= now`; idempotent per unique key); `.cancel(entityType, entityId, eventKey): Promise<void>`; `.runDue(now?: Date): Promise<{ fired: number }>` (claim-then-fire → `emitAsync(eventKey, { entityType, entityId, tier, scheduledEventId })`). `CommsModule` exports `MessageTemplateService`, `NotificationDispatcher`, `ScheduledEventService`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/scheduled-event.e2e-spec.ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Injectable } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ScheduledEventService } from "../src/modules/comms/scheduled-event.service";
import { randomUUID } from "crypto";

@Injectable()
class Sink {
  hits: { entityId: string; tier: string }[] = [];
  @OnEvent("test.timer")
  onFire(p: { entityId: string; tier: string }): void {
    this.hits.push({ entityId: p.entityId, tier: p.tier });
  }
}

describe("ScheduledEventService (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let svc: ScheduledEventService;
  let sink: Sink;
  const entityId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], providers: [Sink] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    svc = app.get(ScheduledEventService);
    sink = app.get(Sink);
  });

  afterAll(async () => {
    await prisma.scheduledEvent.deleteMany({ where: { entityId } });
    await app.close();
  });

  it("schedule() skips past-due tiers", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await svc.schedule("RFQ", entityId, "test.timer", [
      { tier: "PAST", dueAt: new Date("2025-12-31T23:00:00Z") },
      { tier: "FUTURE", dueAt: new Date("2026-01-02T00:00:00Z") },
    ], { now });
    const rows = await prisma.scheduledEvent.findMany({ where: { entityId }, orderBy: { tier: "asc" } });
    expect(rows.map((r) => r.tier)).toEqual(["FUTURE"]);
  });

  it("runDue() fires due+unfired once and is idempotent", async () => {
    await svc.runDue(new Date("2026-01-03T00:00:00Z"));
    expect(sink.hits.filter((h) => h.entityId === entityId)).toEqual([{ entityId, tier: "FUTURE" }]);
    await svc.runDue(new Date("2026-01-03T00:00:00Z")); // no re-fire
    expect(sink.hits.filter((h) => h.entityId === entityId).length).toBe(1);
    const fired = await prisma.scheduledEvent.count({ where: { entityId, firedAt: { not: null } } });
    expect(fired).toBe(1);
  });

  it("cancel() stops unfired timers", async () => {
    const e2 = randomUUID();
    await svc.schedule("RFQ", e2, "test.timer", [{ tier: "T1", dueAt: new Date("2999-01-01T00:00:00Z") }]);
    await svc.cancel("RFQ", e2, "test.timer");
    await svc.runDue(new Date("2999-02-01T00:00:00Z"));
    expect(await prisma.scheduledEvent.count({ where: { entityId: e2, firedAt: { not: null } } })).toBe(0);
    await prisma.scheduledEvent.deleteMany({ where: { entityId: e2 } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/api test -- scheduled-event`
Expected: FAIL — cannot resolve `ScheduledEventService`.

- [ ] **Step 3: Write the service**

```ts
// apps/api/src/modules/comms/scheduled-event.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class ScheduledEventService {
  private readonly logger = new Logger(ScheduledEventService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async schedule(
    entityType: string,
    entityId: string,
    eventKey: string,
    entries: { tier: string; dueAt: Date }[],
    opts: { tenantId?: string | null; now?: Date } = {},
  ): Promise<void> {
    const now = opts.now ?? new Date();
    for (const e of entries) {
      if (e.dueAt.getTime() <= now.getTime()) continue; // skip past-due tiers
      await this.prisma.scheduledEvent.upsert({
        where: { entityType_entityId_eventKey_tier: { entityType, entityId, eventKey, tier: e.tier } },
        create: { entityType, entityId, eventKey, tier: e.tier, dueAt: e.dueAt, tenantId: opts.tenantId ?? null },
        update: {},
      });
    }
  }

  async cancel(entityType: string, entityId: string, eventKey: string): Promise<void> {
    await this.prisma.scheduledEvent.updateMany({
      where: { entityType, entityId, eventKey, firedAt: null, cancelledAt: null },
      data: { cancelledAt: new Date() },
    });
  }

  async runDue(now: Date = new Date()): Promise<{ fired: number }> {
    const due = await this.prisma.scheduledEvent.findMany({
      where: { dueAt: { lte: now }, firedAt: null, cancelledAt: null },
    });
    let fired = 0;
    for (const ev of due) {
      // Claim first (idempotent under a racing cron): only proceed if WE set firedAt.
      const claim = await this.prisma.scheduledEvent.updateMany({
        where: { id: ev.id, firedAt: null, cancelledAt: null },
        data: { firedAt: now },
      });
      if (claim.count === 0) continue;
      try {
        await this.events.emitAsync(ev.eventKey, {
          entityType: ev.entityType,
          entityId: ev.entityId,
          tier: ev.tier,
          scheduledEventId: ev.id,
        });
      } catch (err) {
        this.logger.error(`runDue emit failed for scheduled-event ${ev.id}`, err as Error);
        continue;
      }
      fired++;
    }
    return { fired };
  }
}
```

- [ ] **Step 4: Write the cron + module**

```ts
// apps/api/src/modules/comms/scheduled-event.scheduler.ts
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ScheduledEventService } from "./scheduled-event.service";

@Injectable()
export class ScheduledEventScheduler {
  constructor(private readonly scheduled: ScheduledEventService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async poll(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    await this.scheduled.runDue();
  }
}
```

```ts
// apps/api/src/modules/comms/comms.module.ts
import { Module } from "@nestjs/common";
import { MessageTemplateService } from "./message-template.service";
import { NotificationDispatcher } from "./notification-dispatcher.service";
import { ScheduledEventService } from "./scheduled-event.service";
import { ScheduledEventScheduler } from "./scheduled-event.scheduler";
import { MESSAGE_TRANSPORT, LogTransport } from "./transport";

@Module({
  providers: [
    MessageTemplateService,
    NotificationDispatcher,
    ScheduledEventService,
    ScheduledEventScheduler,
    { provide: MESSAGE_TRANSPORT, useClass: LogTransport },
  ],
  exports: [MessageTemplateService, NotificationDispatcher, ScheduledEventService],
})
export class CommsModule {}
```

Register in `apps/api/src/app.module.ts` — add the import and put `CommsModule` in the `imports` array:

```ts
import { CommsModule } from "./modules/comms/comms.module";
// ...in @Module({ imports: [ ... , CommsModule ] })
```

- [ ] **Step 5: Run test + lint**

Run: `pnpm --filter @svyft/api test -- scheduled-event && pnpm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/comms/ apps/api/src/app.module.ts apps/api/test/scheduled-event.e2e-spec.ts
git commit -m "feat(comms): ScheduledEventService + minute-cron + CommsModule"
```

---

# Phase 2 — Migrate Stage 3 onto the framework

### Task 6: Migrate the emails module to the dispatcher + `MessageLog`

**Files:**
- Modify: `apps/api/src/modules/emails/emails.service.ts`
- Modify: `apps/api/src/modules/emails/emails.module.ts` (import `CommsModule`)
- Modify: `apps/api/src/modules/emails/emails.controller.ts` (return type only if needed)
- Modify: `packages/shared/src/notifications.ts` (`EmailLogDto` → read from `MessageLog`; keep field shape)
- Create: `prisma/migrations/<timestamp>_backfill_messagelog/migration.sql` (copy `EmailLog` → `MessageLog`, then `DROP TABLE "EmailLog"`)
- Modify: `prisma/schema.prisma` (remove `EmailLog` model + `Query.emailLogs` relation)
- Modify: `apps/api/test/emails.e2e-spec.ts`

**Interfaces:**
- Consumes: `NotificationDispatcher.dispatch`.
- Produces: `EmailsService.compose(eventKey: "query.follow_up" | "query.acknowledgement", queryId, composedById): Promise<void>`; `EmailsService.list(queryId): Promise<EmailLogDto[]>` (reads `MessageLog` where `entityType="QUERY"`, `channel="EMAIL"`).

- [ ] **Step 1: Update the emails e2e (failing) to assert MessageLog + eventKeys**

Rewrite the assertions in `apps/api/test/emails.e2e-spec.ts` so follow-up/acknowledgement produce `MessageLog` rows (not `emailLog`). Example core test (adapt the existing fixture setup):

```ts
it("follow-up composes a MessageLog row via the dispatcher", async () => {
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/emails/follow-up`)
    .set("Cookie", authCookie)
    .expect(201);
  const rows = await prisma.messageLog.findMany({ where: { entityType: "QUERY", entityId: queryId, channel: "EMAIL" } });
  expect(rows.some((r) => r.eventKey === "query.follow_up")).toBe(true);
});

it("GET emails lists MessageLog rows for the query", async () => {
  const res = await request(app.getHttpServer())
    .get(`/api/queries/${queryId}/emails`).set("Cookie", authCookie).expect(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body[0]).toHaveProperty("bodyRendered");
});
```

Run: `pnpm --filter @svyft/api test -- emails` → Expected: FAIL (still reads `emailLog` / old switch).

- [ ] **Step 2: Rewrite `EmailsService`**

```ts
// apps/api/src/modules/emails/emails.service.ts
import { Injectable, NotFoundException } from "@nestjs/common";
import type { EmailLogDto } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";

const RESPONSE_TIMELINE = "24 hours";

@Injectable()
export class EmailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async compose(
    eventKey: "query.follow_up" | "query.acknowledgement",
    queryId: string,
    composedById: string | null,
  ): Promise<void> {
    const q = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { id: true, queryCode: true, contactName: true, contactEmail: true, tenantId: true },
    });
    if (!q) throw new NotFoundException("Query not found");

    let missing: string[] = [];
    if (eventKey === "query.follow_up") {
      const items = await this.prisma.queryChecklistItem.findMany({ where: { queryId, checked: false } });
      const defs = await this.prisma.checklistDefinition.findMany({
        where: { itemKey: { in: items.map((i) => i.itemKey) } },
      });
      const label = new Map(defs.map((d) => [d.itemKey, d.label]));
      missing = items.map((i) => label.get(i.itemKey) ?? i.itemKey);
    }

    await this.dispatcher.dispatch(eventKey, {
      scope: { entityType: "QUERY", entityId: queryId },
      tokens: {
        Query_ID: q.queryCode,
        Client_Name: q.contactName ?? "",
        Missing_Fields_List: missing.join(", ") || "—",
        Expected_Response_Timeline: RESPONSE_TIMELINE,
      },
      recipients: { EMAIL: q.contactEmail ? [q.contactEmail] : [] },
      composedById,
      tenantId: q.tenantId,
    });
  }

  async list(queryId: string): Promise<EmailLogDto[]> {
    const rows = await this.prisma.messageLog.findMany({
      where: { entityType: "QUERY", entityId: queryId, channel: "EMAIL" },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => ({
      id: r.id,
      queryId,
      template: r.templateKey,
      fromAddress: r.fromAddress,
      toAddress: r.toAddress,
      subject: r.subject ?? "",
      bodyRendered: r.bodyRendered,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
```

Update `emails.controller.ts` — the two POST handlers call `compose("query.follow_up", …)` / `compose("query.acknowledgement", …)` and return `void` (still `@HttpCode(201)`):

```ts
  @Post("follow-up")
  @HttpCode(201)
  followUp(@Param("id") id: string, @CurrentUser() user: RequestUser) {
    return this.emails.compose("query.follow_up", id, user.userId);
  }

  @Post("acknowledgement")
  @HttpCode(201)
  acknowledgement(@Param("id") id: string, @CurrentUser() user: RequestUser) {
    return this.emails.compose("query.acknowledgement", id, user.userId);
  }
```

Update `emails.module.ts` to import `CommsModule`:

```ts
import { CommsModule } from "../comms/comms.module";
// @Module({ imports: [CommsModule], controllers: [EmailsController], providers: [EmailsService], exports: [EmailsService] })
```

In `packages/shared/src/notifications.ts`, change **both** `EmailLogDto.template` (→ `string`, it now carries a `templateKey`) **and** `EmailLogDto.status` (→ `string`). Rebuild shared, then run `pnpm --filter @svyft/web typecheck` and fix any web reference to those fields (the Plan-7 email-log view just renders the strings — no logic change expected).

- [ ] **Step 3: Write the backfill + drop migration**

`prisma/migrations/<timestamp>_backfill_messagelog/migration.sql`:

```sql
-- copy every EmailLog row into MessageLog (entityType QUERY, channel EMAIL)
INSERT INTO "MessageLog" ("id", "tenantId", "entityType", "entityId", "eventKey", "channel", "templateKey", "fromAddress", "toAddress", "subject", "bodyRendered", "tokens", "composedById", "status", "createdAt")
SELECT
  "id", "tenantId", 'QUERY', "queryId",
  CASE "template"
    WHEN 'FOLLOW_UP' THEN 'query.follow_up'
    WHEN 'ACKNOWLEDGEMENT' THEN 'query.acknowledgement'
    WHEN 'ESCALATION' THEN 'query.escalation'
  END,
  'EMAIL'::"Channel",
  CASE "template"
    WHEN 'FOLLOW_UP' THEN 'query.follow_up.email'
    WHEN 'ACKNOWLEDGEMENT' THEN 'query.acknowledgement.email'
    WHEN 'ESCALATION' THEN 'query.escalation.email'
  END,
  "fromAddress", "toAddress", "subject", "bodyRendered", "tokens", "composedById", 'LOGGED'::"MessageStatus", "createdAt"
FROM "EmailLog";

DROP TABLE "EmailLog";
```

Remove the `EmailLog` model from `schema.prisma` and delete the `emailLogs EmailLog[]` relation field from `model Query`. Then:

```bash
set -a; . apps/api/.env; set +a; pnpm exec prisma migrate deploy --schema prisma/schema.prisma
pnpm exec prisma generate --schema prisma/schema.prisma
pnpm --filter @svyft/shared build
```

- [ ] **Step 4: Run tests + lint**

Run: `pnpm --filter @svyft/api test -- emails && pnpm --filter @svyft/web typecheck && pnpm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma apps/api/src/modules/emails packages/shared/src/notifications.ts apps/api/test/emails.e2e-spec.ts
git commit -m "refactor(emails): route follow-up/acknowledgement through the dispatcher; backfill+drop EmailLog"
```

---

### Task 7: Migrate escalations to `ScheduledEvent` + retire legacy enums

**Files:**
- Modify: `apps/api/src/modules/escalations/escalations.service.ts`
- Modify: `apps/api/src/modules/escalations/escalations.module.ts` (import `CommsModule`)
- Delete: `apps/api/src/modules/escalations/escalations.scheduler.ts` (the generic cron replaces it)
- Modify: `packages/shared/src/notifications.ts` (drop `EmailTemplate`, `NotificationType`, `EmailStatus`, `EscalationTier` + their arrays/maps; keep `EMAIL`-agnostic DTOs)
- Create: `prisma/migrations/<timestamp>_retire_legacy_comms/migration.sql` (backfill `Escalation`→`ScheduledEvent`, drop `Escalation` + the 4 enums)
- Modify: `prisma/schema.prisma` (remove `Escalation` model + `Query.escalations` relation + the 4 legacy enums; `EmailLog` already gone)
- Modify: `apps/api/test/escalations.e2e-spec.ts`

**Interfaces:**
- Consumes: `ScheduledEventService.schedule/cancel`; `NotificationDispatcher.dispatch`; Prisma `user`.
- Produces: `EscalationsService.createForQuery(queryId, createdAt)` (schedules `query.escalation` tiers via `ScheduledEventService`); `.cancelForQuery(queryId)`; `@OnEvent("query.escalation") onEscalationDue(payload)` → resolve tier→role users → `dispatch("query.escalation", …)`. Tier→role/offset/label maps move **into this service** (no longer shared).

- [ ] **Step 1: Update the escalations e2e (failing)**

Rewrite `apps/api/test/escalations.e2e-spec.ts` to drive the new flow: `createForQuery` writes `ScheduledEvent` rows (`eventKey="query.escalation"`, tiers `T30M/T2H/T6H`), and firing them (via `ScheduledEventService.runDue`) produces the in-app notifications + `MessageLog` rows. Core:

```ts
import { ScheduledEventService } from "../src/modules/comms/scheduled-event.service";
// ...
it("createForQuery schedules 3 escalation timers", async () => {
  await esc.createForQuery(queryId, new Date("2026-01-01T00:00:00Z"));
  const rows = await prisma.scheduledEvent.findMany({
    where: { entityType: "QUERY", entityId: queryId, eventKey: "query.escalation" }, orderBy: { dueAt: "asc" },
  });
  expect(rows.map((r) => r.tier)).toEqual(["T30M", "T2H", "T6H"]);
});

it("runDue fires escalation timers → in-app notifications + escalation emails", async () => {
  await scheduled.runDue(new Date("2026-01-01T07:00:00Z"));
  const notifs = await prisma.notification.count({ where: { queryId, type: "query.escalation" } });
  expect(notifs).toBeGreaterThanOrEqual(1);
  const emails = await prisma.messageLog.count({ where: { entityId: queryId, eventKey: "query.escalation" } });
  expect(emails).toBeGreaterThanOrEqual(1);
});
```

*(Inject both `EscalationsService` and `ScheduledEventService`; `beforeAll` must `seedReferenceData(prisma)` so the escalation templates exist.)*

Run: `pnpm --filter @svyft/api test -- escalations` → Expected: FAIL.

- [ ] **Step 2: Rewrite `EscalationsService`**

```ts
// apps/api/src/modules/escalations/escalations.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { Role } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ScheduledEventService } from "../comms/scheduled-event.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";

const TIERS = ["T30M", "T2H", "T6H"] as const;
type Tier = (typeof TIERS)[number];
const TIER_OFFSET_MS: Record<Tier, number> = { T30M: 30 * 60_000, T2H: 120 * 60_000, T6H: 360 * 60_000 };
const TIER_ROLE: Record<Tier, Role> = { T30M: "EXECUTIVE", T2H: "MANAGER", T6H: "ADMINISTRATOR" };
const TIER_LABEL: Record<Tier, string> = { T30M: "30-minute", T2H: "2-hour", T6H: "6-hour" };

@Injectable()
export class EscalationsService {
  private readonly logger = new Logger(EscalationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly scheduled: ScheduledEventService,
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
    await this.scheduled.schedule(
      "QUERY", queryId, "query.escalation",
      TIERS.map((tier) => ({ tier, dueAt: new Date(createdAt.getTime() + TIER_OFFSET_MS[tier]) })),
      { tenantId: q?.tenantId ?? null, now: createdAt },
    );
  }

  async cancelForQuery(queryId: string): Promise<void> {
    await this.scheduled.cancel("QUERY", queryId, "query.escalation");
  }

  @OnEvent("query.escalation")
  async onEscalationDue(payload: { entityId: string; tier: string }): Promise<void> {
    try {
      const tier = payload.tier as Tier;
      const query = await this.prisma.query.findUnique({
        where: { id: payload.entityId },
        select: { queryCode: true, tenantId: true },
      });
      if (!query) return;
      const users = await this.prisma.user.findMany({
        where: { role: TIER_ROLE[tier], isActive: true },
        select: { id: true, email: true },
      });
      const tokens = { Query_ID: query.queryCode, Tier_Label: TIER_LABEL[tier] };
      // in-app to tier-role staff (kept) + email to the SAME staff (recipient corrected — Design §11)
      await this.notifications.createMany(users.map((u) => u.id), {
        type: "query.escalation", queryId: payload.entityId, entityType: "QUERY", entityId: payload.entityId,
        message: `Query ${query.queryCode} awaiting action — ${TIER_LABEL[tier]} escalation`,
        tenantId: query.tenantId,
      });
      await this.dispatcher.dispatch("query.escalation", {
        scope: { entityType: "QUERY", entityId: payload.entityId },
        tokens,
        recipients: { EMAIL: users.map((u) => u.email).filter((e): e is string => !!e) },
        tenantId: query.tenantId,
      });
    } catch (err) {
      this.logger.error(`onEscalationDue failed for ${payload.entityId}`, err as Error);
    }
  }
}
```

> Note: the in-app write goes through `NotificationsService.createMany` (unchanged path); the email goes through the dispatcher. Both are driven by the same event. Delete `escalations.scheduler.ts` — the generic `ScheduledEventScheduler` now drains these rows.

Update `escalations.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { CommsModule } from "../comms/comms.module";
import { EscalationsService } from "./escalations.service";

@Module({
  imports: [NotificationsModule, CommsModule],
  providers: [EscalationsService],
  exports: [EscalationsService],
})
export class EscalationsModule {}
```

- [ ] **Step 3: Drop legacy shared enums**

In `packages/shared/src/notifications.ts`, delete `NotificationType`, `NOTIFICATION_TYPES`, `EscalationTier`, `ESCALATION_TIERS`, `EmailTemplate`, `EMAIL_TEMPLATES`, `EmailStatus`, `EMAIL_STATUSES`, `TIER_ROLE`, `TIER_OFFSET_MS`, `TIER_LABEL`. Keep `NotificationDto` (`type: string`), `UnreadCountDto`, `EmailLogDto` (`template: string`, `status: string`). Update `packages/shared/src/notifications.test.ts` (remove the enum `toEqual`s). Rebuild shared. Then run `pnpm --filter @svyft/web typecheck` — if the web app imports any dropped symbol (`EmailTemplate` / `NotificationType` / `EscalationTier`), replace it (the bell feed + email-log render `type`/`template` as plain strings; the Send buttons POST by path and never needed the enum). Fix every reference before committing.

- [ ] **Step 4: Backfill + drop migration**

`prisma/migrations/<timestamp>_retire_legacy_comms/migration.sql`:

```sql
-- Escalation → ScheduledEvent
INSERT INTO "ScheduledEvent" ("id", "tenantId", "entityType", "entityId", "eventKey", "tier", "dueAt", "firedAt", "cancelledAt", "createdAt")
SELECT "id", "tenantId", 'QUERY', "queryId", 'query.escalation', "tier"::text, "dueAt", "firedAt", "cancelledAt", "createdAt"
FROM "Escalation";

DROP TABLE "Escalation";
DROP TYPE "EscalationTier";
DROP TYPE "EmailTemplate";
DROP TYPE "EmailStatus";
DROP TYPE "NotificationType";
```

Remove from `schema.prisma`: `model Escalation`, the `escalations Escalation[]` relation on `model Query`, and the 4 enums. Then:

```bash
set -a; . apps/api/.env; set +a; pnpm exec prisma migrate deploy --schema prisma/schema.prisma
pnpm exec prisma generate --schema prisma/schema.prisma
pnpm --filter @svyft/shared build
```

- [ ] **Step 5: Run tests + lint**

Run: `pnpm --filter @svyft/api test -- escalations && pnpm --filter @svyft/shared test && pnpm --filter @svyft/web typecheck && pnpm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma apps/api/src/modules/escalations packages/shared/src/notifications.ts packages/shared/src/notifications.test.ts apps/api/test/escalations.e2e-spec.ts
git commit -m "refactor(escalations): drive via ScheduledEvent + dispatcher; retire legacy Escalation table + comms enums"
```

---

# Phase 3 — RFQ usage

### Task 8: `CommsSettingsService` + RFQ templates + config-driven deadline

**Files:**
- Create: `apps/api/src/modules/comms/comms-settings.service.ts` (+ export from `CommsModule`)
- Modify: `apps/api/src/seed/message-templates.seed.ts` (append RFQ/quote templates)
- Modify: `apps/api/src/modules/rfq/rfq.service.ts` (`resolveDeadline` reads the setting)
- Modify: `apps/api/src/modules/rfq/rfq.module.ts` (import `CommsModule`)
- Test: `apps/api/test/comms-settings.e2e-spec.ts`

**Interfaces:**
- Produces: `CommsSettingsService.rfqDeadlineHours(): Promise<number>` (AppSetting `rfqDeadlineDefaultHours` or 48); `.rfqReminderOffsets(): Promise<number[]>` (AppSetting `rfqReminderOffsetsHours` parsed, or `[36,24,12,6,2]`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/comms-settings.e2e-spec.ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";
import { CommsSettingsService } from "../src/modules/comms/comms-settings.service";

describe("CommsSettingsService (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let svc: CommsSettingsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    svc = app.get(CommsSettingsService);
    await seedReferenceData(prisma);
  });

  afterAll(async () => { await app.close(); });

  it("reads the seeded defaults", async () => {
    expect(await svc.rfqDeadlineHours()).toBe(48);
    expect(await svc.rfqReminderOffsets()).toEqual([36, 24, 12, 6, 2]);
  });

  it("reads an overridden value", async () => {
    await prisma.appSetting.update({ where: { key: "rfqDeadlineDefaultHours" }, data: { value: "24" } });
    expect(await svc.rfqDeadlineHours()).toBe(24);
    await prisma.appSetting.update({ where: { key: "rfqDeadlineDefaultHours" }, data: { value: "48" } });
  });
});
```

Run: `pnpm --filter @svyft/api test -- comms-settings` → FAIL.

- [ ] **Step 2: Write `CommsSettingsService`**

```ts
// apps/api/src/modules/comms/comms-settings.service.ts
import { Injectable } from "@nestjs/common";
import { RFQ_DEADLINE_HOURS_KEY, RFQ_REMINDER_OFFSETS_KEY, DEFAULT_RFQ_DEADLINE_HOURS, DEFAULT_RFQ_REMINDER_OFFSETS } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class CommsSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async rfqDeadlineHours(): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: RFQ_DEADLINE_HOURS_KEY } });
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RFQ_DEADLINE_HOURS;
  }

  async rfqReminderOffsets(): Promise<number[]> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: RFQ_REMINDER_OFFSETS_KEY } });
    if (!row) return [...DEFAULT_RFQ_REMINDER_OFFSETS];
    const parsed = row.value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    return parsed.length ? parsed : [...DEFAULT_RFQ_REMINDER_OFFSETS];
  }
}
```

Add `CommsSettingsService` to `CommsModule` `providers` **and** `exports`.

- [ ] **Step 3: Append the RFQ/quote templates** to `MESSAGE_TEMPLATES` in `message-templates.seed.ts`:

```ts
  {
    key: "rfq.invitation.email", eventKey: "rfq.invitation", channel: "EMAIL",
    subject: "Request for Quotation — RFQ {{RFQ_Number}}",
    body: "You have been invited to quote RFQ {{RFQ_Number}} ({{Leg_Names}}).\nSubmission deadline: {{Deadline}}.\nOpen your secure portal: {{Access_Link}}",
  },
  {
    key: "rfq.updated.email", eventKey: "rfq.updated", channel: "EMAIL",
    subject: "RFQ {{RFQ_Number}} updated — a leg was added",
    body: "RFQ {{RFQ_Number}} has been updated with additional legs ({{Leg_Names}}). Please review it via your existing secure portal link.",
  },
  {
    key: "rfq.reminder.email", eventKey: "rfq.reminder", channel: "EMAIL",
    subject: "Reminder: RFQ {{RFQ_Number}} closes {{Deadline}}",
    body: "This is a reminder that RFQ {{RFQ_Number}} closes at {{Deadline}}. Please submit your quote before the deadline via your secure portal link.",
  },
  {
    key: "rfq.expiry.email", eventKey: "rfq.expiry", channel: "EMAIL",
    subject: "RFQ {{RFQ_Number}} — submission window closed",
    body: "Your RFQ {{RFQ_Number}} submission window has expired. No further quotes can be accepted for this RFQ.",
  },
  {
    key: "rfq.expiry.inapp", eventKey: "rfq.expiry", channel: "IN_APP",
    subject: null,
    body: "{{FF_Name}} did not submit {{Leg_Name}} — RFQ {{RFQ_Number}} has expired.",
  },
  {
    key: "rfq.submission_ack.email", eventKey: "rfq.submission_ack", channel: "EMAIL",
    subject: "Quote received — RFQ {{RFQ_Number}}",
    body: "Thank you — your quote for RFQ {{RFQ_Number}} has been received.",
  },
  {
    key: "quote.received.inapp", eventKey: "quote.received", channel: "IN_APP",
    subject: null,
    body: "{{FF_Name}} submitted a quote for {{Leg_Name}} (RFQ {{RFQ_Number}}).",
  },
```

- [ ] **Step 4: Wire `resolveDeadline` to the setting**

In `rfq.service.ts`: add `CommsSettingsService` to the constructor, remove `DEFAULT_DEADLINE_MS`, and make `resolveDeadline` async:

```ts
  private async resolveDeadline(override?: string): Promise<Date> {
    if (override) {
      const d = new Date(override);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        throw new BadRequestException("submissionDeadline must be a valid future datetime");
      }
      return d;
    }
    const hours = await this.commsSettings.rfqDeadlineHours();
    return new Date(Date.now() + hours * 60 * 60 * 1000);
  }
```

Update the two call sites to `await this.resolveDeadline(...)` (in `distributeAll` and `distributeLeg`). Import + inject `CommsSettingsService` from `../comms/comms-settings.service`. Add `CommsModule` to `rfq.module.ts` `imports`.

- [ ] **Step 5: Run tests + lint + build**

Run: `pnpm --filter @svyft/shared build && pnpm --filter @svyft/api test -- comms-settings && pnpm --filter @svyft/api test -- rfq && pnpm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/comms/comms-settings.service.ts apps/api/src/modules/comms/comms.module.ts apps/api/src/seed/message-templates.seed.ts apps/api/src/modules/rfq/rfq.service.ts apps/api/src/modules/rfq/rfq.module.ts apps/api/test/comms-settings.e2e-spec.ts
git commit -m "feat(rfq): CommsSettingsService + seeded RFQ templates + config-driven deadline"
```

---

### Task 9: Distribute wiring — seed reminders/expiry + dispatch invitation/updated

**Files:**
- Modify: `apps/api/src/modules/rfq/rfq.service.ts` (`performDistribution` post-commit hook)
- Test: `apps/api/test/rfq-distribute-comms.e2e-spec.ts`

**Interfaces:**
- Consumes: `ScheduledEventService.schedule`, `NotificationDispatcher.dispatch`, `CommsSettingsService.rfqReminderOffsets`.
- Produces: after a successful distribution, per minted/amended RFQ — `ScheduledEvent` rows (`rfq.reminder` tiers + one `rfq.expiry`) anchored to the RFQ, and a dispatched `rfq.invitation` (minted) / `rfq.updated` (amend) email.

- [ ] **Step 1: Write the failing e2e** (self-contained: seed reference data, create a Query + Leg + LegCargo + a Point pair + an ACTIVE FreightForwarder + a SELECT Quote, then distribute).

```ts
// apps/api/test/rfq-distribute-comms.e2e-spec.ts — core assertions (build fixtures like rfq.e2e-spec.ts)
it("distribute seeds reminder+expiry timers and logs an invitation email", async () => {
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/distribute`)
    .set("Cookie", authCookie).send({}).expect(201);

  const rfq = await prisma.rfq.findFirst({ where: { queryId, freightForwarderId: ffId } });
  const reminders = await prisma.scheduledEvent.findMany({
    where: { entityType: "RFQ", entityId: rfq!.id, eventKey: "rfq.reminder" },
  });
  expect(reminders.length).toBeGreaterThanOrEqual(1); // future tiers only
  const expiry = await prisma.scheduledEvent.findFirst({
    where: { entityType: "RFQ", entityId: rfq!.id, eventKey: "rfq.expiry", tier: "DEADLINE" },
  });
  expect(expiry).not.toBeNull();
  const invite = await prisma.messageLog.findFirst({
    where: { entityType: "QUERY", entityId: queryId, eventKey: "rfq.invitation" },
  });
  expect(invite?.toAddress).toBe(ffEmail);
});
```

Run: `pnpm --filter @svyft/api test -- rfq-distribute-comms` → FAIL.

- [ ] **Step 2: Add the post-commit hook to `performDistribution`**

At the end of `performDistribution`, after the status fires (after the `for (const legId of legFires)` loop, before `return`), add:

```ts
    // ── comms fan-out (post-commit; compose-&-log) ──
    const offsets = await this.commsSettings.rfqReminderOffsets();
    const base = process.env.PORTAL_BASE_URL ?? "";
    for (const entry of entries) {
      const ff = await this.prisma.freightForwarder.findUnique({
        where: { id: entry.freightForwarderId },
        select: { email: true },
      });
      const legCodes = await this.prisma.leg.findMany({
        where: { id: { in: entry.legIds } },
        select: { legCode: true },
        orderBy: { legCode: "asc" },
      });
      const legNames = legCodes.map((l) => l.legCode).join(", ");
      const deadlineIso = deadline.toISOString();

      // reminders (future tiers only) + one expiry, anchored to the RFQ
      await this.scheduled.schedule(
        "RFQ", entry.rfqId, "rfq.reminder",
        offsets.map((h) => ({ tier: `T${h}H`, dueAt: new Date(deadline.getTime() - h * 60 * 60 * 1000) })),
        { tenantId: user.tenantId },
      );
      await this.scheduled.schedule(
        "RFQ", entry.rfqId, "rfq.expiry",
        [{ tier: "DEADLINE", dueAt: deadline }],
        { tenantId: user.tenantId },
      );

      // invitation (fresh mint has the raw token) / updated (amend — no fresh link)
      if (entry.minted && entry.accessToken) {
        await this.dispatcher.dispatch("rfq.invitation", {
          scope: { entityType: "QUERY", entityId: query.id },
          tokens: { RFQ_Number: entry.rfqNumber, Leg_Names: legNames, Deadline: deadlineIso, Access_Link: `${base}/ff/rfq/${entry.accessToken}` },
          recipients: { EMAIL: ff?.email ? [ff.email] : [] },
          tenantId: user.tenantId,
        });
      } else {
        await this.dispatcher.dispatch("rfq.updated", {
          scope: { entityType: "QUERY", entityId: query.id },
          tokens: { RFQ_Number: entry.rfqNumber, Leg_Names: legNames },
          recipients: { EMAIL: ff?.email ? [ff.email] : [] },
          tenantId: user.tenantId,
        });
      }
    }
```

Add `ScheduledEventService` and `NotificationDispatcher` to the `RfqService` constructor (imported from `../comms/...`).

- [ ] **Step 3: Run tests + lint**

Run: `pnpm --filter @svyft/api test -- rfq-distribute-comms && pnpm --filter @svyft/api test -- rfq && pnpm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/rfq/rfq.service.ts apps/api/test/rfq-distribute-comms.e2e-spec.ts
git commit -m "feat(rfq): on distribute, seed reminder/expiry timers + log invitation/updated email"
```

---

### Task 10: Reminder + expiry listeners

**Files:**
- Create: `apps/api/src/modules/rfq/rfq-schedule.listener.ts` (+ add to `RfqModule` providers)
- Test: `apps/api/test/rfq-expiry.e2e-spec.ts`

**Interfaces:**
- Consumes (`@OnEvent`): `"rfq.reminder"` and `"rfq.expiry"` with payload `{ entityType: "RFQ"; entityId: rfqId; tier }`.
- Produces: reminder → `dispatch("rfq.reminder", …)` email to the FF; expiry → for each `RFQ_SENT` quote on the RFQ: clear `draftJson`, `StatusService.fire(quote, EXPIRE)`, then `dispatch("rfq.expiry", …)` (EMAIL→FF + IN_APP→assigned Executive, or all active Executives if unassigned), and cancel the RFQ's remaining reminders.

- [ ] **Step 1: Write the failing e2e** (create Query with `assignedUserId` = a seeded Executive, a Leg, an ACTIVE FF, a distributed `RFQ_SENT` Quote with a non-null `draftJson`, and an `rfq.expiry` ScheduledEvent due now).

```ts
// apps/api/test/rfq-expiry.e2e-spec.ts — core
it("expiry: quote → EXPIRED, draft discarded, FF email + Exec notification, reminders cancelled", async () => {
  await scheduled.runDue(new Date(deadline.getTime() + 60_000)); // past the DEADLINE row

  const quote = await prisma.quote.findUnique({ where: { id: quoteId } });
  expect(quote?.status).toBe("EXPIRED");
  expect(quote?.draftJson).toBeNull();

  const ffMail = await prisma.messageLog.count({ where: { entityId: queryId, eventKey: "rfq.expiry", channel: "EMAIL" } });
  expect(ffMail).toBeGreaterThanOrEqual(1);
  const execNotif = await prisma.notification.count({ where: { recipientUserId: execUserId, type: "rfq.expiry" } });
  expect(execNotif).toBeGreaterThanOrEqual(1);

  const liveReminders = await prisma.scheduledEvent.count({
    where: { entityType: "RFQ", entityId: rfqId, eventKey: "rfq.reminder", firedAt: null, cancelledAt: null },
  });
  expect(liveReminders).toBe(0);
});
```

Run: `pnpm --filter @svyft/api test -- rfq-expiry` → FAIL.

- [ ] **Step 2: Write the listener**

```ts
// apps/api/src/modules/rfq/rfq-schedule.listener.ts
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Prisma } from "@prisma/client";
import { QuoteEvent, QuoteStatus } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { StatusService } from "../status/status.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";
import { ScheduledEventService } from "../comms/scheduled-event.service";

type TimerPayload = { entityType: string; entityId: string; tier: string };

@Injectable()
export class RfqScheduleListener {
  private readonly logger = new Logger(RfqScheduleListener.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly status: StatusService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly scheduled: ScheduledEventService,
  ) {}

  @OnEvent("rfq.reminder")
  async onReminder(p: TimerPayload): Promise<void> {
    try {
      const rfq = await this.prisma.rfq.findUnique({
        where: { id: p.entityId },
        select: { rfqNumber: true, submissionDeadline: true, queryId: true, tenantId: true, freightForwarder: { select: { email: true } } },
      });
      if (!rfq) return;
      await this.dispatcher.dispatch("rfq.reminder", {
        scope: { entityType: "QUERY", entityId: rfq.queryId },
        tokens: { RFQ_Number: rfq.rfqNumber, Deadline: rfq.submissionDeadline.toISOString() },
        recipients: { EMAIL: rfq.freightForwarder?.email ? [rfq.freightForwarder.email] : [] },
        tenantId: rfq.tenantId,
      });
    } catch (err) {
      this.logger.error(`onReminder failed for rfq ${p.entityId}`, err as Error);
    }
  }

  @OnEvent("rfq.expiry")
  async onExpiry(p: TimerPayload): Promise<void> {
    try {
      const rfq = await this.prisma.rfq.findUnique({
        where: { id: p.entityId },
        select: {
          rfqNumber: true, queryId: true, tenantId: true,
          freightForwarder: { select: { companyName: true, email: true } },
        },
      });
      if (!rfq) return;

      const openQuotes = await this.prisma.quote.findMany({
        where: { rfqId: p.entityId, status: QuoteStatus.RFQ_SENT },
        select: { id: true, legId: true, leg: { select: { legCode: true } } },
      });
      if (openQuotes.length === 0) return;

      const query = await this.prisma.query.findUnique({
        where: { id: rfq.queryId },
        select: { assignedUserId: true },
      });
      let execIds: string[] = query?.assignedUserId ? [query.assignedUserId] : [];
      if (execIds.length === 0) {
        const execs = await this.prisma.user.findMany({ where: { role: "EXECUTIVE", isActive: true }, select: { id: true } });
        execIds = execs.map((u) => u.id);
      }

      for (const q of openQuotes) {
        // discard the unsubmitted draft (permanent, spec S8/E3), then fire EXPIRE (the one door, after the write)
        await this.prisma.quote.update({ where: { id: q.id }, data: { draftJson: Prisma.DbNull } });
        await this.status.fire("quote", q.id, QuoteEvent.EXPIRE, { queryId: rfq.queryId });

        await this.dispatcher.dispatch("rfq.expiry", {
          scope: { entityType: "QUERY", entityId: rfq.queryId },
          tokens: { RFQ_Number: rfq.rfqNumber, FF_Name: rfq.freightForwarder?.companyName ?? "", Leg_Name: q.leg.legCode },
          recipients: {
            EMAIL: rfq.freightForwarder?.email ? [rfq.freightForwarder.email] : [],
            IN_APP: execIds,
          },
          tenantId: rfq.tenantId,
        });
      }

      // no more reminders once the window closed
      await this.scheduled.cancel("RFQ", p.entityId, "rfq.reminder");
    } catch (err) {
      this.logger.error(`onExpiry failed for rfq ${p.entityId}`, err as Error);
    }
  }
}
```

Add `RfqScheduleListener` to `RfqModule` `providers`. (`RfqModule` already imports `StatusModule`; it now also imports `CommsModule` from Task 8.)

> **FF fetch caveat:** the listener reads the FF via the `Rfq.freightForwarder` relation. If `schema.prisma` exposes only the scalar `freightForwarderId` (no named relation on `Rfq`), replace each `freightForwarder: { select: … }` include with a separate `prisma.freightForwarder.findUnique({ where: { id: rfq.freightForwarderId }, select: { companyName: true, email: true } })`. Confirm the relation name before implementing.

- [ ] **Step 3: Run tests + lint**

Run: `pnpm --filter @svyft/api test -- rfq-expiry && pnpm run lint`
Expected: PASS. (Quote `RFQ_SENT → EXPIRED` is a legal edge — `QuoteEvent.EXPIRE`.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/rfq/rfq-schedule.listener.ts apps/api/src/modules/rfq/rfq.module.ts apps/api/test/rfq-expiry.e2e-spec.ts
git commit -m "feat(rfq): reminder + expiry listeners (draft discard, fire EXPIRE, notify, cancel reminders)"
```

---

### Task 11: Submit wiring — ack + quote-received + cancel reminders

**Files:**
- Modify: `apps/api/src/modules/ff-portal/ff-portal.service.ts`
- Modify: `apps/api/src/modules/ff-portal/ff-portal.module.ts` (import `CommsModule`)
- Test: `apps/api/test/ff-portal.e2e-spec.ts` (extend)

**Interfaces:**
- Consumes: `NotificationDispatcher.dispatch`, `ScheduledEventService.cancel`.
- Produces: after a successful `submit`, a `rfq.submission_ack` email to the FF + a `quote.received` in-app notification to the Executive, and the RFQ's remaining reminders cancelled.

- [ ] **Step 1: Extend the ff-portal e2e (failing)** — after a successful submit, assert the ack email + the Exec notification + no live reminders.

```ts
it("submit logs an acknowledgement + notifies the Executive + cancels reminders", async () => {
  // ...perform a valid submit for legId as in the existing happy-path test...
  const ack = await prisma.messageLog.count({ where: { entityId: queryId, eventKey: "rfq.submission_ack" } });
  expect(ack).toBeGreaterThanOrEqual(1);
  const notif = await prisma.notification.count({ where: { recipientUserId: execUserId, type: "quote.received" } });
  expect(notif).toBeGreaterThanOrEqual(1);
});
```

Run: `pnpm --filter @svyft/api test -- ff-portal` → FAIL.

- [ ] **Step 2: Add the post-fire hook to `submit`**

In `ff-portal.service.ts`, after `await this.status.fire("quote", q.id, QuoteEvent.SUBMIT, …)` and before `return`, add:

```ts
    // ── comms (post-commit; compose-&-log) ──
    const rfq = await this.prisma.rfq.findUnique({
      where: { id: scope.rfq.id },
      select: { rfqNumber: true, tenantId: true, freightForwarder: { select: { companyName: true, email: true } } },
    });
    const query = await this.prisma.query.findUnique({
      where: { id: scope.rfq.queryId }, select: { assignedUserId: true },
    });
    let execIds: string[] = query?.assignedUserId ? [query.assignedUserId] : [];
    if (execIds.length === 0) {
      const execs = await this.prisma.user.findMany({ where: { role: "EXECUTIVE", isActive: true }, select: { id: true } });
      execIds = execs.map((u) => u.id);
    }
    const tokens = { RFQ_Number: rfq?.rfqNumber ?? "", FF_Name: rfq?.freightForwarder?.companyName ?? "", Leg_Name: q.leg.legCode ?? "" };
    await this.dispatcher.dispatch("rfq.submission_ack", {
      scope: { entityType: "QUERY", entityId: scope.rfq.queryId },
      tokens, recipients: { EMAIL: rfq?.freightForwarder?.email ? [rfq.freightForwarder.email] : [] },
      tenantId: rfq?.tenantId ?? null,
    });
    await this.dispatcher.dispatch("quote.received", {
      scope: { entityType: "QUERY", entityId: scope.rfq.queryId },
      tokens, recipients: { IN_APP: execIds }, tenantId: rfq?.tenantId ?? null,
    });
    await this.scheduled.cancel("RFQ", scope.rfq.id, "rfq.reminder");
```

Add `NotificationDispatcher` + `ScheduledEventService` to the `FfPortalService` constructor. Confirm `scope.quotes[...].leg` exposes `legCode` (add it to the token-scope select if absent — the guard resolves the quote with its leg). Add `CommsModule` to `ff-portal.module.ts` `imports`.

> **FF fetch caveat:** same as Task 10 — the hook reads the FF via `Rfq.freightForwarder`; if only the scalar exists, fetch via `prisma.freightForwarder.findUnique({ where: { id: scope.rfq.freightForwarderId } })`.

- [ ] **Step 3: Run tests + lint**

Run: `pnpm --filter @svyft/api test -- ff-portal && pnpm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/ff-portal/ apps/api/test/ff-portal.e2e-spec.ts
git commit -m "feat(ff-portal): on submit, log acknowledgement + notify Executive + cancel reminders"
```

---

# Phase 4 — "No Response" status

### Task 12: `QueryStatus.NO_RESPONSE` + projector

**Files:**
- Modify: `packages/shared/src/status.ts` (`QueryStatus.NO_RESPONSE` + `deriveQueryStatus`)
- Modify: `packages/shared/src/status.test.ts`
- Create: `prisma/migrations/<timestamp>_query_no_response/migration.sql` (`ALTER TYPE "QueryStatus" ADD VALUE 'NO_RESPONSE'`)
- Modify: `apps/api/src/modules/status/query-status.projector.ts` (compute + pass `noResponse`)
- Test: `apps/api/test/query-no-response.e2e-spec.ts`

**Interfaces:**
- Produces: `QueryStatus.NO_RESPONSE`; `QueryMilestones.noResponse?: boolean`; `deriveQueryStatus` returns `NO_RESPONSE` when the leg rollup is fully-resolved but `noResponse` is set.

- [ ] **Step 1: Write the failing shared test**

Add to `packages/shared/src/status.test.ts`:

```ts
it("returns NO_RESPONSE when all legs resolved but every quote expired", () => {
  expect(deriveQueryStatus(["FULLY_QUOTED"], { rfqReady: true, noResponse: true })).toBe("NO_RESPONSE");
});
it("returns QUOTED when all legs FULLY_QUOTED and noResponse is false", () => {
  expect(deriveQueryStatus(["FULLY_QUOTED"], { rfqReady: true })).toBe("QUOTED");
});
```

Run: `pnpm --filter @svyft/shared test -- status` → FAIL.

- [ ] **Step 2: Update shared `status.ts`**

Add `NO_RESPONSE: "NO_RESPONSE",` to the `QueryStatus` const (after `QUOTED`). Add `noResponse?: boolean;` to the `QueryMilestones` interface. In `deriveQueryStatus`, change the `FULLY_QUOTED` branch:

```ts
    case LegStatus.FULLY_QUOTED:
      return milestones.noResponse ? QueryStatus.NO_RESPONSE : QueryStatus.QUOTED;
```

Run: `pnpm --filter @svyft/shared test -- status && pnpm --filter @svyft/shared build` → PASS.

- [ ] **Step 3: Migration for the enum value**

`prisma/migrations/<timestamp>_query_no_response/migration.sql`:

```sql
ALTER TYPE "QueryStatus" ADD VALUE 'NO_RESPONSE';
```

Add `NO_RESPONSE` to the `QueryStatus` enum in `schema.prisma`. Then `set -a; . apps/api/.env; set +a; pnpm exec prisma migrate deploy --schema prisma/schema.prisma && pnpm exec prisma generate --schema prisma/schema.prisma`.

- [ ] **Step 4: Compute `noResponse` in the projector**

In `query-status.projector.ts` `recompute`, before `this.project(...)`, compute the flag from the query's quotes:

```ts
    const quotes = await client.quote.findMany({
      where: { queryId, status: { not: "SELECT" } },
      select: { status: true },
    });
    const noResponse =
      quotes.length > 0 &&
      quotes.every((qt) => qt.status === "EXPIRED" || qt.status === "INVALID") &&
      !quotes.some((qt) => qt.status === "QUOTED");

    const status = this.project(legStatuses, { rfqReady: !!q.rfqReadyAt, noResponse });
```

- [ ] **Step 5: Write the projector e2e** (Query with one Leg; one distributed Quote fired to `EXPIRED`; recompute → query status `NO_RESPONSE`).

```ts
// apps/api/test/query-no-response.e2e-spec.ts — core
it("a query whose only quote expired rolls up to NO_RESPONSE", async () => {
  await projector.recompute(queryId);
  const q = await prisma.query.findUnique({ where: { id: queryId }, select: { status: true } });
  expect(q?.status).toBe("NO_RESPONSE");
});
```

- [ ] **Step 6: Run all + lint + full CI gate**

Run:
```bash
pnpm --filter @svyft/shared build
pnpm --filter @svyft/api test -- query-no-response
pnpm run lint
pnpm --filter @svyft/shared test
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/status.ts packages/shared/src/status.test.ts prisma apps/api/src/modules/status/query-status.projector.ts apps/api/test/query-no-response.e2e-spec.ts
git commit -m "feat(status): NO_RESPONSE query rollup when all quotes expired"
```

---

## Final verification (before the PR)

- [ ] `pnpm --filter @svyft/shared build`
- [ ] `pnpm run lint`
- [ ] `pnpm --filter @svyft/shared test` (shared unit)
- [ ] `pnpm --filter @svyft/web typecheck` (shared enum removals must not break the web app)
- [ ] `pnpm --filter @svyft/api test` (full api e2e — confirm every spec `await app.close()`; no hang)
- [ ] Watch CI on the PR (`gh pr checks <n> --watch`) — do not assume green.
- [ ] Update docs (per design §16): `Stage 4 - Session Handoff.md` (move SB5 to delivered + list the new tables), `Stage 4 - Technical Design.md` (generic `ScheduledEvent`/`MessageTemplate`/`MessageLog`), `Stage 3 - Session Handoff.md` (Escalation/EmailLog/Notification generalized; escalation email recipient corrected).

## Self-Review notes (coverage map)

- Design §4 tables → Task 2 (schema) · §5 dispatcher → Task 4 · §6 scheduler → Task 5 · §7 config → Task 8 · §9.1 distribute/submit → Tasks 9/11 · §9.2 reminder/expiry → Task 10 · §9.3 NO_RESPONSE → Task 12 · §10 migrations (additive→backfill→retire) → Tasks 2/6/7/12 · §11 back-compat (emails endpoint, escalation parity, recipient correction) → Tasks 6/7 · §1 compose-&-log (LogTransport) → Task 4.
- Deferred (NOT built here, per §13/§17): admin UI, live SmtpTransport, template API, O-S4-6 soft-warning, RFQ PDF, SB6 REOPENED.
