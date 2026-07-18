-- CreateTable
CREATE TABLE "StatusTransition" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "seq" SERIAL NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "from" TEXT,
    "to" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "actorId" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StatusTransition_seq_key" ON "StatusTransition"("seq");

-- CreateIndex
CREATE INDEX "StatusTransition_entity_entityId_idx" ON "StatusTransition"("entity", "entityId");

-- CreateIndex
CREATE INDEX "StatusTransition_tenantId_idx" ON "StatusTransition"("tenantId");
