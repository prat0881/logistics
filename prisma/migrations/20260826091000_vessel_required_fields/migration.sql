-- 1. vesselType: enum → text, with the old values rendered as the labels users will now type.
ALTER TABLE "Vessel" ALTER COLUMN "vesselType" TYPE TEXT USING (
  CASE "vesselType"::TEXT
    WHEN 'CONTAINER'     THEN 'Container Vessel'
    WHEN 'BULK_CARRIER'  THEN 'Bulk Carrier'
    WHEN 'TANKER'        THEN 'Tanker'
    WHEN 'RORO'          THEN 'RoRo'
    WHEN 'GENERAL_CARGO' THEN 'General Cargo'
    WHEN 'REEFER'        THEN 'Reefer'
    ELSE 'Other'
  END
);
DROP TYPE "VesselType";

-- 2. shippingLine: a vessel with no carrier recorded is marked, not invented.
UPDATE "Vessel" SET "shippingLine" = 'Unknown' WHERE "shippingLine" IS NULL OR "shippingLine" = '';
ALTER TABLE "Vessel" ALTER COLUMN "shippingLine" SET NOT NULL;

-- 3. imoNumber: generated, unique, seven digits, in the 8000000 block so backfilled rows are
--    identifiable — real IMO numbers in use start 9xxxxxx. The migration prints every row it
--    touches so the affected vessels can be corrected from the UI (spec D8).
DO $$
DECLARE v RECORD; n INT := 8000000;
BEGIN
  FOR v IN SELECT "id", "name" FROM "Vessel" WHERE "imoNumber" IS NULL ORDER BY "createdAt" LOOP
    LOOP
      n := n + 1;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "Vessel" WHERE "imoNumber" = n::TEXT);
    END LOOP;
    UPDATE "Vessel" SET "imoNumber" = n::TEXT WHERE "id" = v."id";
    RAISE NOTICE 'IMO backfilled: vessel % (%) -> %', v."name", v."id", n;
  END LOOP;
END $$;
ALTER TABLE "Vessel" ALTER COLUMN "imoNumber" SET NOT NULL;
