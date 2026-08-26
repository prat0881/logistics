CREATE TYPE "PocLevel" AS ENUM ('PRIMARY', 'SECONDARY', 'NONE');

ALTER TABLE "Client" ADD COLUMN "streetAddress" TEXT, ADD COLUMN "city" TEXT, ADD COLUMN "postalCode" TEXT;
UPDATE "Client" SET "streetAddress" = 'Not recorded' WHERE "streetAddress" IS NULL;
UPDATE "Client" SET "city" = 'Not recorded' WHERE "city" IS NULL;
ALTER TABLE "Client" ALTER COLUMN "streetAddress" SET NOT NULL, ALTER COLUMN "city" SET NOT NULL;

ALTER TABLE "ClientContact"
  ADD COLUMN "whatsappAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "wechatAvailable"   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "botimAvailable"    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "pocLevel" "PocLevel" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE';

-- Carry the old boolean across before dropping it.
UPDATE "ClientContact" SET "pocLevel" = 'PRIMARY' WHERE "isPrimary" = TRUE;
ALTER TABLE "ClientContact" DROP COLUMN "isPrimary";

UPDATE "ClientContact" SET "email" = 'not.recorded@example.invalid' WHERE "email" IS NULL;
UPDATE "ClientContact" SET "contactNo" = '+10000000000' WHERE "contactNo" IS NULL;
ALTER TABLE "ClientContact" ALTER COLUMN "email" SET NOT NULL, ALTER COLUMN "contactNo" SET NOT NULL;

-- One primary per client. Prisma cannot express a partial unique index, so it is raw SQL.
-- If more than one existing contact per client carries PRIMARY, demote all but the earliest
-- so the unique index below can be created.
UPDATE "ClientContact" c SET "pocLevel" = 'SECONDARY' WHERE "pocLevel" = 'PRIMARY' AND "createdAt" > (SELECT MIN("createdAt") FROM "ClientContact" WHERE "clientId" = c."clientId" AND "pocLevel" = 'PRIMARY');

CREATE UNIQUE INDEX "ClientContact_one_primary" ON "ClientContact" ("clientId") WHERE "pocLevel" = 'PRIMARY';
