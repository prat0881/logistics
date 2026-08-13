-- new enums
CREATE TYPE "ChargeRateVariant" AS ENUM ('DEDICATED', 'GROUPAGE', 'FCL', 'LCL');
CREATE TYPE "TruckTonnage" AS ENUM ('T_1','T_2','T_3_5','T_5','T_7','T_9','T_12','T_16','T_20','T_25','TRAILER_30_40T');
CREATE TYPE "ContainerSize" AS ENUM ('TWENTY', 'FORTY', 'FORTY_FIVE_HC');
CREATE TYPE "BillOfLadingType" AS ENUM ('ORIGINAL', 'TELEX');
CREATE TYPE "WarehouseSide" AS ENUM ('DROP', 'PICKUP');
ALTER TYPE "ChargeLineInputType" ADD VALUE 'HEAVY_WEIGHT_CALC';

-- QuoteCargoLine: drop density model, add FF-entered kg
ALTER TABLE "QuoteCargoLine" DROP COLUMN "freightDensity";
ALTER TABLE "QuoteCargoLine" DROP COLUMN "chargeableWeightT";
ALTER TABLE "QuoteCargoLine" ADD COLUMN "chargedWeightKg" DECIMAL(12,3) NOT NULL DEFAULT 0;
ALTER TABLE "QuoteCargoLine" ALTER COLUMN "chargedWeightKg" DROP DEFAULT;

-- TruckingCharge: dual-rate
ALTER TABLE "TruckingCharge" ADD COLUMN "rateVariant" "ChargeRateVariant" NOT NULL DEFAULT 'DEDICATED';
ALTER TABLE "TruckingCharge" ADD COLUMN "tonnage" "TruckTonnage";

-- SeaFreightRate
CREATE TABLE "SeaFreightRate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "quoteId" UUID NOT NULL,
  "rateVariant" "ChargeRateVariant" NOT NULL,
  "containerSize" "ContainerSize",
  "amount" DECIMAL(14,2) NOT NULL,
  "remarks" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SeaFreightRate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SeaFreightRate_quoteId_idx" ON "SeaFreightRate"("quoteId");
CREATE INDEX "SeaFreightRate_tenantId_idx" ON "SeaFreightRate"("tenantId");
ALTER TABLE "SeaFreightRate" ADD CONSTRAINT "SeaFreightRate_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ChargeLine: heavy-weight calc inputs + Sea B/L
ALTER TABLE "ChargeLine" ADD COLUMN "pieceWeightKg" DECIMAL(12,3);
ALTER TABLE "ChargeLine" ADD COLUMN "airlineLimitKg" DECIMAL(12,3);
ALTER TABLE "ChargeLine" ADD COLUMN "ratePerExcessKg" DECIMAL(14,2);
ALTER TABLE "ChargeLine" ADD COLUMN "billOfLadingType" "BillOfLadingType";

-- WarehouseStagingLine: richer zones
ALTER TABLE "WarehouseStagingLine" ADD COLUMN "cfsCode" TEXT;
ALTER TABLE "WarehouseStagingLine" ADD COLUMN "side" "WarehouseSide";

-- TransitPlan: mode-specific
ALTER TABLE "TransitPlan" ADD COLUMN "plannedPickupDate" TIMESTAMP(3);
ALTER TABLE "TransitPlan" ADD COLUMN "airline" TEXT;
ALTER TABLE "TransitPlan" ADD COLUMN "flightNumber" TEXT;
ALTER TABLE "TransitPlan" ADD COLUMN "plannedDeparture" TIMESTAMP(3);
ALTER TABLE "TransitPlan" ADD COLUMN "plannedArrival" TIMESTAMP(3);
ALTER TABLE "TransitPlan" ADD COLUMN "shippingLine" TEXT;
ALTER TABLE "TransitPlan" ADD COLUMN "vesselVoyage" TEXT;
ALTER TABLE "TransitPlan" ADD COLUMN "etd" TIMESTAMP(3);
ALTER TABLE "TransitPlan" ADD COLUMN "eta" TIMESTAMP(3);
