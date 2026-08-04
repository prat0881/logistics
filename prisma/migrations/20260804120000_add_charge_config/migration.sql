CREATE TYPE "ChargeLineRole" AS ENUM ('CORE', 'STANDARD', 'TAG_DRIVEN', 'WAREHOUSE');
CREATE TYPE "ChargeLineInputType" AS ENUM ('PLAIN', 'TRUCKING', 'WAREHOUSE_STAGING');

CREATE TABLE "ChargeLineDefinition" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "mode" "FreightMode" NOT NULL,
    "role" "ChargeLineRole" NOT NULL,
    "inputType" "ChargeLineInputType" NOT NULL DEFAULT 'PLAIN',
    "zone" "ChargeZone",
    "tagKey" TEXT,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChargeLineDefinition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChargeLineDefinition_key_key" ON "ChargeLineDefinition"("key");
CREATE INDEX "ChargeLineDefinition_mode_role_isActive_idx" ON "ChargeLineDefinition"("mode", "role", "isActive");

CREATE TABLE "LegChargeLineSelection" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "legId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LegChargeLineSelection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LegChargeLineSelection_legId_definitionId_key" ON "LegChargeLineSelection"("legId", "definitionId");
CREATE INDEX "LegChargeLineSelection_legId_idx" ON "LegChargeLineSelection"("legId");
ALTER TABLE "LegChargeLineSelection" ADD CONSTRAINT "LegChargeLineSelection_legId_fkey"
    FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LegChargeLineSelection" ADD CONSTRAINT "LegChargeLineSelection_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "ChargeLineDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Leg" ADD COLUMN "warehouseHandlingIncluded" BOOLEAN;
ALTER TABLE "Quote" ADD COLUMN "chargeConfigSnapshot" JSONB;
ALTER TABLE "ChargeLine" ALTER COLUMN "zone" DROP NOT NULL;
ALTER TABLE "ChargeLine" ADD COLUMN "definitionKey" TEXT;
ALTER TABLE "TruckingCharge" ADD COLUMN "definitionKey" TEXT;
ALTER TABLE "WarehouseStagingLine" ADD COLUMN "definitionKey" TEXT;
