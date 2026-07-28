-- CreateEnum
CREATE TYPE "ChargeZone" AS ENUM ('ORIGIN', 'MAIN_FREIGHT', 'DESTINATION');

-- CreateEnum
CREATE TYPE "TruckingType" AS ENUM ('DEDICATED', 'GROUPAGE');

-- CreateEnum
CREATE TYPE "TruckingBasis" AS ENUM ('PER_TRUCK', 'PER_CBM', 'PER_TON', 'FIXED');

-- CreateEnum
CREATE TYPE "WarehousePosition" AS ENUM ('ORIGIN', 'DESTINATION');

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "dgSurchargeNote" TEXT,
ADD COLUMN     "grandTotal" DECIMAL(14,2),
ADD COLUMN     "termsConditions" TEXT,
ADD COLUMN     "totalChargeableWeightT" DECIMAL(12,3);

-- CreateTable
CREATE TABLE "QuoteCargoLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "quoteId" UUID NOT NULL,
    "cargoItemId" UUID NOT NULL,
    "freightDensity" DECIMAL(12,3) NOT NULL,
    "chargeableWeightT" DECIMAL(12,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteCargoLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargeLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "quoteId" UUID NOT NULL,
    "zone" "ChargeZone" NOT NULL,
    "label" TEXT NOT NULL,
    "isPreset" BOOLEAN NOT NULL DEFAULT false,
    "presetKey" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TruckingCharge" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "quoteId" UUID NOT NULL,
    "legEndpointPointId" UUID NOT NULL,
    "truckingType" "TruckingType" NOT NULL,
    "basis" "TruckingBasis" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TruckingCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseStagingLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "quoteId" UUID NOT NULL,
    "warehousePointId" UUID NOT NULL,
    "position" "WarehousePosition" NOT NULL,
    "label" TEXT NOT NULL,
    "isPreset" BOOLEAN NOT NULL DEFAULT false,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "cargoAcceptanceWindow" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarehouseStagingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransitPlan" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "quoteId" UUID NOT NULL,
    "carrier" TEXT,
    "flightVoyageNo" TEXT,
    "departureDate" TIMESTAMP(3) NOT NULL,
    "arrivalDate" TIMESTAMP(3) NOT NULL,
    "carrierSurcharge" DECIMAL(14,2),
    "guaranteedTransitDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransitPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteCargoLine_quoteId_idx" ON "QuoteCargoLine"("quoteId");

-- CreateIndex
CREATE INDEX "QuoteCargoLine_tenantId_idx" ON "QuoteCargoLine"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteCargoLine_quoteId_cargoItemId_key" ON "QuoteCargoLine"("quoteId", "cargoItemId");

-- CreateIndex
CREATE INDEX "ChargeLine_quoteId_idx" ON "ChargeLine"("quoteId");

-- CreateIndex
CREATE INDEX "ChargeLine_tenantId_idx" ON "ChargeLine"("tenantId");

-- CreateIndex
CREATE INDEX "TruckingCharge_quoteId_idx" ON "TruckingCharge"("quoteId");

-- CreateIndex
CREATE INDEX "TruckingCharge_tenantId_idx" ON "TruckingCharge"("tenantId");

-- CreateIndex
CREATE INDEX "WarehouseStagingLine_quoteId_idx" ON "WarehouseStagingLine"("quoteId");

-- CreateIndex
CREATE INDEX "WarehouseStagingLine_tenantId_idx" ON "WarehouseStagingLine"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TransitPlan_quoteId_key" ON "TransitPlan"("quoteId");

-- CreateIndex
CREATE INDEX "TransitPlan_tenantId_idx" ON "TransitPlan"("tenantId");

-- AddForeignKey
ALTER TABLE "QuoteCargoLine" ADD CONSTRAINT "QuoteCargoLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteCargoLine" ADD CONSTRAINT "QuoteCargoLine_cargoItemId_fkey" FOREIGN KEY ("cargoItemId") REFERENCES "CargoItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeLine" ADD CONSTRAINT "ChargeLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckingCharge" ADD CONSTRAINT "TruckingCharge_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckingCharge" ADD CONSTRAINT "TruckingCharge_legEndpointPointId_fkey" FOREIGN KEY ("legEndpointPointId") REFERENCES "Point"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseStagingLine" ADD CONSTRAINT "WarehouseStagingLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseStagingLine" ADD CONSTRAINT "WarehouseStagingLine_warehousePointId_fkey" FOREIGN KEY ("warehousePointId") REFERENCES "Point"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitPlan" ADD CONSTRAINT "TransitPlan_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
