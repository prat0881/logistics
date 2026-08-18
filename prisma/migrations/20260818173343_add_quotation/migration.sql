-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'ISSUED', 'SUPERSEDED');

-- NOTE (S5.8 Task 3): `prisma migrate dev`'s diff also proposed ten unrelated
-- `ALTER TABLE ... ALTER COLUMN "id" DROP DEFAULT` statements against AwardDecisionEvent,
-- Cargo, FxRate, Item, LegAwardDecision, LegPackage, MessageLog, Package, ScheduledEvent and
-- SeaFreightRate. These are pre-existing drift: five earlier migrations (comms_framework,
-- cargo_packing_list, ff_portal_v2, add_fx_rate, add_award_decision) hand-wrote
-- `DEFAULT gen_random_uuid()` on those tables' id columns in raw SQL, while schema.prisma has
-- always declared `@default(uuid())` (a Prisma-client-side default, not a DB default) for the
-- same columns — a mismatch that was only ever going to surface on the first `migrate dev` run
-- against this history, unrelated to whatever change triggers it. Removed from this file so
-- this migration stays scoped to the Quotation addition per the task brief ("purely additive
-- ... no column drop"); harmless either way since the app always supplies `id` explicitly and
-- never relies on the DB-level default. Left as-is for a future dedicated cleanup migration.

-- CreateTable
CREATE TABLE "Quotation" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "marginPct" DECIMAL(5,2) NOT NULL,
    "draftJson" JSONB NOT NULL,
    "issuedSnapshot" JSONB,
    "costTotalUsd" DECIMAL(14,2) NOT NULL,
    "clientTotalUsd" DECIMAL(14,2) NOT NULL,
    "recipientEmail" TEXT,
    "subject" TEXT,
    "bodyText" TEXT,
    "issuedAt" TIMESTAMP(3),
    "issuedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Quotation_queryId_status_idx" ON "Quotation"("queryId", "status");

-- CreateIndex
CREATE INDEX "Quotation_tenantId_idx" ON "Quotation"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_queryId_version_key" ON "Quotation"("queryId", "version");

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;
