-- FF Portal v3 (Test Round 2, per-variant quoting). See docs/superpowers/specs/
-- 2026-08-07-ff-portal-v3-per-variant-quoting-design.md §3-4. v2's shared charge set +
-- per-package chargeable weight + one transit block per leg is replaced by: a per-variant
-- charge matrix, one leg-level chargeable weight, and per-variant Guaranteed Transit Time.
-- Pre-go-live/data-disposable (Quote/QuoteCargoLine/ChargeLine/TransitPlan all 0 rows on :5433
-- at migration time -- see task-2-report.md), so the drop below is a plain drop, no backfill.

-- Quote: chargeable weight moves from per-QuoteCargoLine (per-package) to one leg-level value;
-- add `notes` (a new FF-facing field, distinct from dgSurchargeNote/termsConditions).
ALTER TABLE "Quote" ADD COLUMN "chargedWeightKg" DECIMAL(12,3), ADD COLUMN "notes" TEXT;

-- QuoteCargoLine: drop the per-package chargeable weight now that Quote carries one leg-level
-- value instead.
ALTER TABLE "QuoteCargoLine" DROP COLUMN "chargedWeightKg";

-- ChargeLine: each charge line now belongs to a rate-variant column in the per-variant matrix.
-- NULL = Air's single implicit column (or a non-variant line); DEDICATED/GROUPAGE/FCL/LCL for
-- Road/Sea, mirroring TruckingCharge/SeaFreightRate's existing rateVariant columns.
ALTER TABLE "ChargeLine" ADD COLUMN "rateVariant" "ChargeRateVariant";

-- TransitPlan: was one row per quote (UNIQUE index on quoteId alone: "TransitPlan_quoteId_key",
-- confirmed live via `\d "TransitPlan"` -- a plain unique index, not a named table constraint,
-- so DROP INDEX rather than DROP CONSTRAINT). v3 needs one row per priced variant (Guaranteed
-- Transit Time is now per-variant; the rest of the schedule repeats per row). Replace the
-- singular uniqueness with a composite (quoteId, rateVariant) uniqueness, mirroring
-- QuoteCargoLine's (quoteId, packageId) unique-plus-separate-quoteId-index convention.
-- NULL rateVariant = Air's single implicit row.
DROP INDEX "TransitPlan_quoteId_key";
ALTER TABLE "TransitPlan" ADD COLUMN "rateVariant" "ChargeRateVariant";
CREATE UNIQUE INDEX "TransitPlan_quoteId_rateVariant_key" ON "TransitPlan"("quoteId", "rateVariant");
CREATE INDEX "TransitPlan_quoteId_idx" ON "TransitPlan"("quoteId");
