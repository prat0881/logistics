-- AlterTable: explicit per-Query timezones for the client-agreed Ready/Target window
ALTER TABLE "Query" ADD COLUMN "readyDateTimezone" TEXT;
ALTER TABLE "Query" ADD COLUMN "targetDeliveryTimezone" TEXT;

-- Stamp existing rows with the org default zone
UPDATE "Query" SET "readyDateTimezone" = 'Asia/Kolkata' WHERE "readyDateTimezone" IS NULL;
UPDATE "Query" SET "targetDeliveryTimezone" = 'Asia/Kolkata' WHERE "targetDeliveryTimezone" IS NULL;
