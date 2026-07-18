-- CreateEnum
CREATE TYPE "QueryStatus" AS ENUM ('DRAFT', 'CREATED', 'RFQ_READY', 'RFQ_SENT', 'QUOTED', 'AWAITING_CLIENT_DECISION', 'WON', 'LOST', 'CLOSED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "Incoterms" AS ENUM ('EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP');

-- CreateEnum
CREATE TYPE "ReferenceTag" AS ENUM ('HEAVY', 'FRAGILE', 'NON_STACKABLE');

-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('MSDS');

-- CreateTable
CREATE TABLE "QuerySequence" (
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuerySequence_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "Query" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryCode" TEXT NOT NULL,
    "queryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "responseDeadline" TIMESTAMP(3),
    "responseDeadlineRemarks" TEXT,
    "clientId" UUID,
    "contactName" TEXT,
    "contactDesignation" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "faxNumber" TEXT,
    "vesselId" UUID,
    "vesselName" TEXT,
    "imoNumber" TEXT,
    "eta" TIMESTAMP(3),
    "etb" TIMESTAMP(3),
    "etd" TIMESTAMP(3),
    "portOfCall" TEXT,
    "incoterms" "Incoterms",
    "shipmentDescription" TEXT,
    "dgIndicator" BOOLEAN NOT NULL DEFAULT false,
    "readyDate" TIMESTAMP(3),
    "targetDelivery" TIMESTAMP(3),
    "internalNotes" TEXT,
    "status" "QueryStatus" NOT NULL DEFAULT 'DRAFT',
    "rfqReadyAt" TIMESTAMP(3),
    "assignedUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Query_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CargoItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "poReference" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "referenceTags" "ReferenceTag"[],
    "hsCode" TEXT,
    "packageType" TEXT NOT NULL,
    "isDangerous" BOOLEAN NOT NULL DEFAULT false,
    "msdsFileId" UUID,
    "qty" INTEGER NOT NULL,
    "dimL" DECIMAL(10,2) NOT NULL,
    "dimW" DECIMAL(10,2) NOT NULL,
    "dimH" DECIMAL(10,2) NOT NULL,
    "netWt" DECIMAL(12,3),
    "grossWt" DECIMAL(12,3) NOT NULL,
    "volumeCbm" DECIMAL(14,6) GENERATED ALWAYS AS ("dimL" * "dimW" * "dimH" * "qty" / 1000000) STORED,
    "freightDensity" DECIMAL(12,3),
    "chargeableWeight" DECIMAL(12,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CargoItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueryChecklistItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "itemKey" TEXT NOT NULL,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueryChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileAsset" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "kind" "FileKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Query_queryCode_key" ON "Query"("queryCode");

-- CreateIndex
CREATE INDEX "Query_tenantId_idx" ON "Query"("tenantId");

-- CreateIndex
CREATE INDEX "Query_clientId_idx" ON "Query"("clientId");

-- CreateIndex
CREATE INDEX "Query_assignedUserId_idx" ON "Query"("assignedUserId");

-- CreateIndex
CREATE INDEX "CargoItem_queryId_idx" ON "CargoItem"("queryId");

-- CreateIndex
CREATE INDEX "CargoItem_tenantId_idx" ON "CargoItem"("tenantId");

-- CreateIndex
CREATE INDEX "QueryChecklistItem_queryId_idx" ON "QueryChecklistItem"("queryId");

-- CreateIndex
CREATE UNIQUE INDEX "QueryChecklistItem_queryId_itemKey_key" ON "QueryChecklistItem"("queryId", "itemKey");

-- CreateIndex
CREATE INDEX "FileAsset_queryId_idx" ON "FileAsset"("queryId");

-- CreateIndex
CREATE INDEX "FileAsset_tenantId_idx" ON "FileAsset"("tenantId");

-- AddForeignKey
ALTER TABLE "Query" ADD CONSTRAINT "Query_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Query" ADD CONSTRAINT "Query_vesselId_fkey" FOREIGN KEY ("vesselId") REFERENCES "Vessel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CargoItem" ADD CONSTRAINT "CargoItem_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CargoItem" ADD CONSTRAINT "CargoItem_msdsFileId_fkey" FOREIGN KEY ("msdsFileId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueryChecklistItem" ADD CONSTRAINT "QueryChecklistItem_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;
