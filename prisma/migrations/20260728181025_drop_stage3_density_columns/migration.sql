-- Drop vestigial Stage-3 density columns (O-S4-3).
-- All four are nullable and contain only NULL values — non-destructive.

-- AlterTable CargoItem: drop freightDensity + chargeableWeight
ALTER TABLE "CargoItem"
  DROP COLUMN "freightDensity",
  DROP COLUMN "chargeableWeight";

-- AlterTable Leg: drop totalChargeableWeight
ALTER TABLE "Leg"
  DROP COLUMN "totalChargeableWeight";

-- AlterTable LegCargo: drop manifestSnapshot
ALTER TABLE "LegCargo"
  DROP COLUMN "manifestSnapshot";
