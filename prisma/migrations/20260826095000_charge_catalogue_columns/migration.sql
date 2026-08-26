CREATE TYPE "ChargeCategory" AS ENUM ('ORIGIN', 'FREIGHT', 'DESTINATION', 'ADDITIONAL');
CREATE TYPE "ChargeVariant" AS ENUM ('DEDICATED','GROUPAGE','DIRECT','INDIRECT','FCL','LCL','BOTH');

ALTER TABLE "ChargeLineDefinition"
  ADD COLUMN "category" "ChargeCategory",
  ADD COLUMN "variant" "ChargeVariant" NOT NULL DEFAULT 'BOTH',
  ADD COLUMN "isAdditional" BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill the new columns from the old, the exact inverse of deriveZone/deriveRole.
-- Air and Sea take their category from the zone. Road has no zone, so it is split by role:
-- the trucking line is Freight, everything else is Additional.
UPDATE "ChargeLineDefinition" SET "category" = CASE
  WHEN "zone" = 'ORIGIN'          THEN 'ORIGIN'::"ChargeCategory"
  WHEN "zone" = 'MAIN_FREIGHT'    THEN 'FREIGHT'::"ChargeCategory"
  WHEN "zone" = 'DESTINATION'     THEN 'DESTINATION'::"ChargeCategory"
  WHEN "key" = 'ROAD_CORE_TRUCKING' THEN 'FREIGHT'::"ChargeCategory"
  ELSE 'ADDITIONAL'::"ChargeCategory"
END
WHERE "role" <> 'WAREHOUSE';

UPDATE "ChargeLineDefinition" SET "isAdditional" = ("role" <> 'CORE') WHERE "role" <> 'WAREHOUSE';

-- Warehousing is out of scope: ROAD_WH_HANDLING keeps a null category and is hidden from the screen.
UPDATE "ChargeLineDefinition" SET "category" = NULL WHERE "role" = 'WAREHOUSE';
