-- CreateIndex
CREATE INDEX "Quote_freightForwarderId_idx" ON "Quote"("freightForwarderId");

-- CreateIndex
CREATE INDEX "Rfq_freightForwarderId_idx" ON "Rfq"("freightForwarderId");

-- AddForeignKey
ALTER TABLE "Rfq" ADD CONSTRAINT "Rfq_freightForwarderId_fkey" FOREIGN KEY ("freightForwarderId") REFERENCES "FreightForwarder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_freightForwarderId_fkey" FOREIGN KEY ("freightForwarderId") REFERENCES "FreightForwarder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
