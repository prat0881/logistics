-- CreateTable
CREATE TABLE "RfqTokenReissue" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "rfqId" UUID NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RfqTokenReissue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RfqTokenReissue_rfqId_idx" ON "RfqTokenReissue"("rfqId");

-- CreateIndex
CREATE INDEX "RfqTokenReissue_tenantId_idx" ON "RfqTokenReissue"("tenantId");

-- AddForeignKey
ALTER TABLE "RfqTokenReissue" ADD CONSTRAINT "RfqTokenReissue_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;
