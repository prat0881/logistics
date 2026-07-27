-- CreateTable
CREATE TABLE "FreightForwarder" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "freightForwarderCode" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "companyAddress" TEXT,
    "pic" TEXT NOT NULL,
    "contactNumber" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "availableCountries" TEXT[],
    "modes" "FreightMode"[],
    "handleDg" BOOLEAN NOT NULL DEFAULT false,
    "vatTrnEori" TEXT,
    "whLocation" TEXT,
    "defaultCurrency" TEXT,
    "paymentTerms" TEXT,
    "typicalLeadTime" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreightForwarder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FreightForwarder_freightForwarderCode_key" ON "FreightForwarder"("freightForwarderCode");

-- CreateIndex
CREATE UNIQUE INDEX "FreightForwarder_companyName_key" ON "FreightForwarder"("companyName");

-- CreateIndex
CREATE INDEX "FreightForwarder_tenantId_idx" ON "FreightForwarder"("tenantId");
