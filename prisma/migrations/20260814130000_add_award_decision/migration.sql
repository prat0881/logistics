ALTER TYPE "QueryStatus" ADD VALUE 'QUOTING_CLIENT';
ALTER TYPE "LegStatus" ADD VALUE 'APPROVED';

CREATE TYPE "AwardDecisionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

ALTER TABLE "StatusTransition" ADD COLUMN "reason" TEXT;
ALTER TABLE "Query" ADD COLUMN "awardSnapshot" JSONB;

CREATE TABLE "LegAwardDecision" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "legId" UUID NOT NULL,
  "queryId" UUID NOT NULL,
  "shortlistedQuoteId" UUID,
  "shortlistedVariant" "ChargeRateVariant",
  "recommendedQuoteId" UUID,
  "recommendedVariant" "ChargeRateVariant",
  "overrideReason" TEXT,
  "status" "AwardDecisionStatus" NOT NULL DEFAULT 'DRAFT',
  "sentForApprovalAt" TIMESTAMP(3),
  "sentByUserId" UUID,
  "decidedByUserId" UUID,
  "decidedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LegAwardDecision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LegAwardDecision_legId_key" ON "LegAwardDecision"("legId");
CREATE INDEX "LegAwardDecision_queryId_idx" ON "LegAwardDecision"("queryId");

CREATE TABLE "AwardDecisionEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "legId" UUID NOT NULL,
  "queryId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "quoteId" UUID,
  "variant" "ChargeRateVariant",
  "reason" TEXT,
  "actorId" UUID,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AwardDecisionEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AwardDecisionEvent_legId_idx" ON "AwardDecisionEvent"("legId");
CREATE INDEX "AwardDecisionEvent_queryId_idx" ON "AwardDecisionEvent"("queryId");
