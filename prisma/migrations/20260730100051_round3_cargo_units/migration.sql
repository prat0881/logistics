-- New unit enums
CREATE TYPE "DimUnit" AS ENUM ('CM', 'MM');
CREATE TYPE "WeightUnit" AS ENUM ('KG', 'GM');

-- Extend existing enums (PG12+: ADD VALUE is fine in a tx as long as the value isn't USED in this tx -- it isn't)
ALTER TYPE "ReferenceTag" ADD VALUE 'OUT_OF_GAUGE';
ALTER TYPE "Incoterms" ADD VALUE 'NA';

-- Per-row unit columns (existing rows backfill to CM/KG -- their stored values are already cm/kg)
ALTER TABLE "CargoItem" ADD COLUMN "dimUnit" "DimUnit" NOT NULL DEFAULT 'CM';
ALTER TABLE "CargoItem" ADD COLUMN "weightUnit" "WeightUnit" NOT NULL DEFAULT 'KG';

-- Unit-aware volumeCbm. PG<17 cannot alter a generated expression -> drop + re-add.
-- STORED recomputes for every row on ADD; existing CM rows recompute identically (/1e6).
ALTER TABLE "CargoItem" DROP COLUMN "volumeCbm";
ALTER TABLE "CargoItem" ADD COLUMN "volumeCbm" DECIMAL(14,6)
  GENERATED ALWAYS AS ("dimL" * "dimW" * "dimH" * "qty" / (CASE WHEN "dimUnit" = 'MM' THEN 1000000000 ELSE 1000000 END)) STORED;
