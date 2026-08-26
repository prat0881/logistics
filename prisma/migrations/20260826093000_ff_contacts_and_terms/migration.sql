CREATE TYPE "PaymentTerm" AS ENUM (
  'CREDIT_7','CREDIT_15','CREDIT_30','CREDIT_45','CREDIT_60',
  'ADVANCE_100','ADVANCE_50_BALANCE_50','ADVANCE_30_BALANCE_70',
  'ADVANCE_70_BALANCE_30','AFTER_DELIVERY_100'
);

CREATE TABLE "FreightForwarderContact" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "freightForwarderId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "designation" TEXT,
  "email" TEXT NOT NULL,
  "contactNo" TEXT NOT NULL,
  "whatsappAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
  "wechatAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
  "botimAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
  "pocLevel" "PocLevel" NOT NULL DEFAULT 'NONE',
  "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
  -- TEXT, not UUID: consistent with every other master table, not a deviation. Task 2
  -- deliberately moved createdById/updatedById off @db.Uuid to plain text across the master
  -- tables, because these columns carry no foreign key and a UUID type forced a guard that
  -- silently nulled malformed actor ids. ClientContact (Task 4) already follows this; this
  -- table matches it. (A UUID column would also reject this repo's e2e JWT convention — a
  -- `sub` of the literal form "u-<ROLE>", not a real UUID — with Prisma P2023, but that's a
  -- symptom of the same underlying inconsistency, not the reason for the choice.)
  "createdById" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FreightForwarderContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FreightForwarderContact_freightForwarderId_idx" ON "FreightForwarderContact" ("freightForwarderId");
ALTER TABLE "FreightForwarderContact" ADD CONSTRAINT "FreightForwarderContact_ff_fkey"
  FOREIGN KEY ("freightForwarderId") REFERENCES "FreightForwarder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "FreightForwarderContact_one_primary"
  ON "FreightForwarderContact" ("freightForwarderId") WHERE "pocLevel" = 'PRIMARY';

-- Every existing forwarder's embedded contact becomes its primary contact row.
INSERT INTO "FreightForwarderContact" ("freightForwarderId", "name", "email", "contactNo", "pocLevel", "updatedAt")
SELECT "id", "pic", "email", "contactNumber", 'PRIMARY', CURRENT_TIMESTAMP FROM "FreightForwarder";

-- companyAddress/country/city become required. Backfill first, then constrain NOT NULL.
-- No column default: these are business-required fields, and master-data tables are empty
-- in production today. A default would let the database silently accept an address-less
-- forwarder and label it — indistinguishable from a row this backfill legitimately touched.
-- If 'Not recorded' were ever to appear outside this one-time backfill, that should surface
-- as a loud failure (a 400 from freightForwarderCreateSchema, which requires all three), not
-- a silently-defaulted column. Test fixtures that need a complete create-input use the
-- `ffFixture()` helper (apps/api/test/helpers/freight-forwarder.ts) instead of relying on a
-- database default.
UPDATE "FreightForwarder" SET "companyAddress" = 'Not recorded' WHERE "companyAddress" IS NULL OR "companyAddress" = '';
UPDATE "FreightForwarder" SET "country" = 'Not recorded' WHERE "country" IS NULL OR "country" = '';
UPDATE "FreightForwarder" SET "city" = 'Not recorded' WHERE "city" IS NULL OR "city" = '';
ALTER TABLE "FreightForwarder"
  ALTER COLUMN "companyAddress" SET NOT NULL,
  ALTER COLUMN "country" SET NOT NULL,
  ALTER COLUMN "city" SET NOT NULL;

-- paymentTerms: free text → enum. Anything unrecognised becomes NULL rather than a wrong guess.
ALTER TABLE "FreightForwarder" ADD COLUMN "paymentTermsEnum" "PaymentTerm";
UPDATE "FreightForwarder" SET "paymentTermsEnum" = CASE
  WHEN "paymentTerms" ILIKE '%net 7%'  OR "paymentTerms" ILIKE '%7 day%'  THEN 'CREDIT_7'::"PaymentTerm"
  WHEN "paymentTerms" ILIKE '%net 15%' OR "paymentTerms" ILIKE '%15 day%' THEN 'CREDIT_15'::"PaymentTerm"
  WHEN "paymentTerms" ILIKE '%net 30%' OR "paymentTerms" ILIKE '%30 day%' THEN 'CREDIT_30'::"PaymentTerm"
  WHEN "paymentTerms" ILIKE '%net 45%' OR "paymentTerms" ILIKE '%45 day%' THEN 'CREDIT_45'::"PaymentTerm"
  WHEN "paymentTerms" ILIKE '%net 60%' OR "paymentTerms" ILIKE '%60 day%' THEN 'CREDIT_60'::"PaymentTerm"
  WHEN "paymentTerms" ILIKE '%advance%' THEN 'ADVANCE_100'::"PaymentTerm"
  ELSE NULL END;
ALTER TABLE "FreightForwarder" DROP COLUMN "paymentTerms";
ALTER TABLE "FreightForwarder" RENAME COLUMN "paymentTermsEnum" TO "paymentTerms";

-- typicalLeadTime: text → integer days, keeping only the leading digits.
ALTER TABLE "FreightForwarder" ADD COLUMN "typicalLeadTimeInt" INTEGER;
UPDATE "FreightForwarder"
   SET "typicalLeadTimeInt" = NULLIF(substring("typicalLeadTime" FROM '^\s*(\d+)'), '')::INTEGER
 WHERE "typicalLeadTime" IS NOT NULL;
ALTER TABLE "FreightForwarder" DROP COLUMN "typicalLeadTime";
ALTER TABLE "FreightForwarder" RENAME COLUMN "typicalLeadTimeInt" TO "typicalLeadTime";
