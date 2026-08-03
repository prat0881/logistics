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
