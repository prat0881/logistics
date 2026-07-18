-- CreateEnum
CREATE TYPE "PointType" AS ENUM ('PICKUP', 'DELIVERY', 'WAREHOUSE', 'AIRPORT', 'SEAPORT');

-- CreateEnum
CREATE TYPE "LegStatus" AS ENUM ('DRAFT', 'READY_FOR_RFQ', 'RFQ_SENT', 'PARTIALLY_QUOTED', 'FULLY_QUOTED', 'AWARDED', 'IN_TRANSIT', 'DELIVERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "LegExecutionStatus" AS ENUM ('PENDING', 'IN_TRANSIT', 'COMPLETED');

-- CreateTable
CREATE TABLE "Point" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "type" "PointType" NOT NULL,
    "name" TEXT,
    "streetAddress" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "warehouseType" TEXT,
    "iataCode" TEXT,
    "icaoCode" TEXT,
    "unLocode" TEXT,
    "terminal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Point_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Leg" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "legCode" TEXT NOT NULL,
    "legName" TEXT,
    "originPointId" UUID,
    "destinationPointId" UUID,
    "mode" "FreightMode",
    "readyDate" TIMESTAMP(3),
    "targetDelivery" TIMESTAMP(3),
    "status" "LegStatus" NOT NULL DEFAULT 'DRAFT',
    "executionStatus" "LegExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "totalChargeableWeight" DECIMAL(12,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Leg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegCargo" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "legId" UUID NOT NULL,
    "cargoItemId" UUID NOT NULL,
    "manifestSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegCargo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Point_queryId_idx" ON "Point"("queryId");

-- CreateIndex
CREATE INDEX "Point_tenantId_idx" ON "Point"("tenantId");

-- CreateIndex
CREATE INDEX "Leg_queryId_idx" ON "Leg"("queryId");

-- CreateIndex
CREATE INDEX "Leg_tenantId_idx" ON "Leg"("tenantId");

-- CreateIndex
CREATE INDEX "Leg_originPointId_idx" ON "Leg"("originPointId");

-- CreateIndex
CREATE INDEX "Leg_destinationPointId_idx" ON "Leg"("destinationPointId");

-- CreateIndex
CREATE UNIQUE INDEX "Leg_queryId_legCode_key" ON "Leg"("queryId", "legCode");

-- CreateIndex
CREATE INDEX "LegCargo_legId_idx" ON "LegCargo"("legId");

-- CreateIndex
CREATE INDEX "LegCargo_cargoItemId_idx" ON "LegCargo"("cargoItemId");

-- CreateIndex
CREATE INDEX "LegCargo_tenantId_idx" ON "LegCargo"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LegCargo_legId_cargoItemId_key" ON "LegCargo"("legId", "cargoItemId");

-- AddForeignKey
ALTER TABLE "Point" ADD CONSTRAINT "Point_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leg" ADD CONSTRAINT "Leg_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leg" ADD CONSTRAINT "Leg_originPointId_fkey" FOREIGN KEY ("originPointId") REFERENCES "Point"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leg" ADD CONSTRAINT "Leg_destinationPointId_fkey" FOREIGN KEY ("destinationPointId") REFERENCES "Point"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegCargo" ADD CONSTRAINT "LegCargo_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegCargo" ADD CONSTRAINT "LegCargo_cargoItemId_fkey" FOREIGN KEY ("cargoItemId") REFERENCES "CargoItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
