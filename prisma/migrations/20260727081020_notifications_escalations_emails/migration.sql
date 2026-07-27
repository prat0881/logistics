-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ESCALATION');

-- CreateEnum
CREATE TYPE "EscalationTier" AS ENUM ('T30M', 'T2H', 'T6H');

-- CreateEnum
CREATE TYPE "EmailTemplate" AS ENUM ('FOLLOW_UP', 'ACKNOWLEDGEMENT', 'ESCALATION');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('LOGGED');

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "recipientUserId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "queryId" UUID,
    "message" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Escalation" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "tier" "EscalationTier" NOT NULL,
    "recipientRole" "Role" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "firedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Escalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "template" "EmailTemplate" NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT,
    "subject" TEXT NOT NULL,
    "bodyRendered" TEXT NOT NULL,
    "tokens" JSONB NOT NULL,
    "composedById" UUID,
    "status" "EmailStatus" NOT NULL DEFAULT 'LOGGED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_readAt_idx" ON "Notification"("recipientUserId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_createdAt_idx" ON "Notification"("recipientUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Escalation_firedAt_cancelledAt_dueAt_idx" ON "Escalation"("firedAt", "cancelledAt", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Escalation_queryId_tier_key" ON "Escalation"("queryId", "tier");

-- CreateIndex
CREATE INDEX "EmailLog_queryId_createdAt_idx" ON "EmailLog"("queryId", "createdAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;
