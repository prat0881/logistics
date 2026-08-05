CREATE TYPE "PackageType" AS ENUM ('BOX','PALLET','CRATE','CARTON','DRUM','BUNDLE');
CREATE TYPE "UnitOfMeasure" AS ENUM ('PC','SET','BOX','KG','M','ROLL');
ALTER TYPE "ReferenceTag" ADD VALUE 'DG';
ALTER TYPE "WeightUnit" ADD VALUE 'TONNE' AFTER 'KG';

-- Prod-safety (pre-go-live, data-disposable): clear QuoteCargoLine so the repoint + FK re-add
-- cannot orphan on a non-empty environment (e.g. Neon prod at merge-time). No-op on empty local DB.
DELETE FROM "QuoteCargoLine";

DROP TABLE "LegCargo";
ALTER TABLE "QuoteCargoLine" DROP CONSTRAINT "QuoteCargoLine_cargoItemId_fkey";
ALTER TABLE "QuoteCargoLine" RENAME COLUMN "cargoItemId" TO "packageId";
-- QuoteCargoLine is renamed in-place (not dropped+recreated like the other cargo tables), so the
-- pre-existing unique index keeps its old physical name after the column rename unless renamed here.
-- Without this, `prisma migrate diff` would flag it as drift against the schema's @@unique([quoteId, packageId]).
ALTER INDEX "QuoteCargoLine_quoteId_cargoItemId_key" RENAME TO "QuoteCargoLine_quoteId_packageId_key";
DROP TABLE "CargoItem";

CREATE TABLE "Cargo" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID, "queryId" UUID NOT NULL, "rowIndex" INTEGER NOT NULL,
    "poReference" TEXT, "label" TEXT,
    "dimUnit" "DimUnit" NOT NULL DEFAULT 'CM', "weightUnit" "WeightUnit" NOT NULL DEFAULT 'KG',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Cargo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Cargo_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Cargo_queryId_idx" ON "Cargo"("queryId");
CREATE INDEX "Cargo_tenantId_idx" ON "Cargo"("tenantId");

CREATE TABLE "Package" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID, "queryId" UUID NOT NULL, "cargoId" UUID NOT NULL, "rowIndex" INTEGER NOT NULL,
    "packageNo" TEXT NOT NULL, "packageType" "PackageType" NOT NULL,
    "dimL" DECIMAL(10,2) NOT NULL, "dimW" DECIMAL(10,2) NOT NULL, "dimH" DECIMAL(10,2) NOT NULL,
    "grossWt" DECIMAL(12,3) NOT NULL, "netWt" DECIMAL(12,3),
    "tags" "ReferenceTag"[] NOT NULL DEFAULT ARRAY[]::"ReferenceTag"[],
    "msdsFileId" UUID, "packageCount" INTEGER NOT NULL DEFAULT 1,
    "volumeCbm" DECIMAL(14,6) GENERATED ALWAYS AS ("dimL" * "dimW" * "dimH" / 1000000) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Package_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Package_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Package_cargoId_fkey" FOREIGN KEY ("cargoId") REFERENCES "Cargo"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Package_msdsFileId_fkey" FOREIGN KEY ("msdsFileId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Package_queryId_packageNo_key" ON "Package"("queryId","packageNo");
CREATE INDEX "Package_queryId_idx" ON "Package"("queryId");
CREATE INDEX "Package_cargoId_idx" ON "Package"("cargoId");
CREATE INDEX "Package_tenantId_idx" ON "Package"("tenantId");

CREATE TABLE "Item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID, "packageId" UUID NOT NULL, "rowIndex" INTEGER NOT NULL,
    "product" TEXT, "qty" DECIMAL(14,3), "uom" "UnitOfMeasure", "hsCode" TEXT,
    "tags" "ReferenceTag"[] NOT NULL DEFAULT ARRAY[]::"ReferenceTag"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Item_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Item_packageId_idx" ON "Item"("packageId");
CREATE INDEX "Item_tenantId_idx" ON "Item"("tenantId");

CREATE TABLE "LegPackage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID, "legId" UUID NOT NULL, "packageId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LegPackage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegPackage_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LegPackage_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LegPackage_legId_packageId_key" ON "LegPackage"("legId","packageId");
CREATE INDEX "LegPackage_legId_idx" ON "LegPackage"("legId");
CREATE INDEX "LegPackage_packageId_idx" ON "LegPackage"("packageId");
CREATE INDEX "LegPackage_tenantId_idx" ON "LegPackage"("tenantId");

ALTER TABLE "QuoteCargoLine" ADD CONSTRAINT "QuoteCargoLine_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
