-- Not in the Task-8 brief; discovered via the reference-seed e2e (RED) run in this task.
-- Same root cause the brief already diagnosed for SEA_MAIN_FREIGHT: seedReferenceData's
-- upsert is create-only (update: {}), so flipping AIR_MAIN_HEAVY_WEIGHT's inputType in the
-- reference-seed.ts source has no effect on a row that was already seeded (e.g. :5433/prod),
-- because the upsert's update branch is a no-op on an existing key. Backfill it directly so
-- the catalogue row Unit 3 Task 12 reads actually says HEAVY_WEIGHT_CALC.
UPDATE "ChargeLineDefinition" SET "inputType" = 'HEAVY_WEIGHT_CALC' WHERE "key" = 'AIR_MAIN_HEAVY_WEIGHT';
