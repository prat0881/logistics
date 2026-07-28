-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('SELECT', 'RFQ_SENT', 'QUOTED', 'EXPIRED', 'INVALID', 'REQUOTED', 'CLOSED', 'APPROVED');

-- CreateTable
CREATE TABLE "Rfq" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "freightForwarderId" UUID NOT NULL,
    "rfqNumber" TEXT NOT NULL,
    "accessTokenHash" TEXT NOT NULL,
    "submissionDeadline" TIMESTAMP(3) NOT NULL,
    "incoterms" "Incoterms",
    "currency" TEXT,
    "quoteValidityUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rfq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "queryId" UUID NOT NULL,
    "legId" UUID NOT NULL,
    "freightForwarderId" UUID NOT NULL,
    "rfqId" UUID,
    "status" "QuoteStatus" NOT NULL DEFAULT 'SELECT',
    "manifestSnapshot" JSONB,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqSequence" (
    "queryId" UUID NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RfqSequence_pkey" PRIMARY KEY ("queryId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Rfq_rfqNumber_key" ON "Rfq"("rfqNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Rfq_accessTokenHash_key" ON "Rfq"("accessTokenHash");

-- CreateIndex
CREATE INDEX "Rfq_queryId_idx" ON "Rfq"("queryId");

-- CreateIndex
CREATE INDEX "Rfq_tenantId_idx" ON "Rfq"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Rfq_queryId_freightForwarderId_key" ON "Rfq"("queryId", "freightForwarderId");

-- CreateIndex
CREATE INDEX "Quote_queryId_idx" ON "Quote"("queryId");

-- CreateIndex
CREATE INDEX "Quote_legId_idx" ON "Quote"("legId");

-- CreateIndex
CREATE INDEX "Quote_rfqId_idx" ON "Quote"("rfqId");

-- CreateIndex
CREATE INDEX "Quote_tenantId_idx" ON "Quote"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_legId_freightForwarderId_key" ON "Quote"("legId", "freightForwarderId");

-- AddForeignKey
ALTER TABLE "Rfq" ADD CONSTRAINT "Rfq_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;
