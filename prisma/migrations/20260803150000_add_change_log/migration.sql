-- CreateTable
CREATE TABLE "ChangeLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "changeType" TEXT NOT NULL,
    "actorId" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auditRefId" UUID,
    "approvalRequestId" UUID,
    "payload" JSONB NOT NULL,

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangeLog_queryId_idx" ON "ChangeLog"("queryId");

-- CreateIndex
CREATE INDEX "ChangeLog_entity_entityId_idx" ON "ChangeLog"("entity", "entityId");

-- AddForeignKey
ALTER TABLE "ChangeLog" ADD CONSTRAINT "ChangeLog_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;
