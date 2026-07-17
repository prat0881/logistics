-- CreateEnum
CREATE TYPE "MasterStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "VesselType" AS ENUM ('CONTAINER', 'BULK_CARRIER', 'TANKER', 'RORO', 'GENERAL_CARGO', 'REEFER', 'OTHER');

-- CreateEnum
CREATE TYPE "FreightMode" AS ENUM ('ROAD', 'AIR', 'SEA');

-- CreateTable
CREATE TABLE "Client" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "clientCode" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "industry" TEXT,
    "country" TEXT NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientContact" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "clientId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT,
    "contactNo" TEXT,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vessel" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "vesselCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imoNumber" TEXT,
    "shippingLine" TEXT,
    "vesselType" "VesselType" NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vessel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreightDensityFactor" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "mode" "FreightMode" NOT NULL,
    "kgPerCbm" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreightDensityFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistDefinition" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "itemKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "dgConditional" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChecklistDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSequence" (
    "key" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CodeSequence_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_clientCode_key" ON "Client"("clientCode");

-- CreateIndex
CREATE UNIQUE INDEX "Client_companyName_key" ON "Client"("companyName");

-- CreateIndex
CREATE INDEX "Client_tenantId_idx" ON "Client"("tenantId");

-- CreateIndex
CREATE INDEX "ClientContact_clientId_idx" ON "ClientContact"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Vessel_vesselCode_key" ON "Vessel"("vesselCode");

-- CreateIndex
CREATE UNIQUE INDEX "Vessel_imoNumber_key" ON "Vessel"("imoNumber");

-- CreateIndex
CREATE INDEX "Vessel_tenantId_idx" ON "Vessel"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FreightDensityFactor_mode_key" ON "FreightDensityFactor"("mode");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistDefinition_itemKey_key" ON "ChecklistDefinition"("itemKey");

-- AddForeignKey
ALTER TABLE "ClientContact" ADD CONSTRAINT "ClientContact_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
