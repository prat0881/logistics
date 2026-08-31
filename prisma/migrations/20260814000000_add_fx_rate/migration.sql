CREATE TABLE "FxRate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "currency" TEXT NOT NULL,
  "unitsPerUsd" DECIMAL(18,8) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FxRate_currency_effectiveFrom_idx" ON "FxRate"("currency", "effectiveFrom");
