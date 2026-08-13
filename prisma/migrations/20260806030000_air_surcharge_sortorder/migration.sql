-- Fix: AIR_MAIN_FSC / AIR_MAIN_PEAK_SEASON were seeded with fractional sortOrder (9.1 / 9.2),
-- which Postgres silently truncated to 9 (sortOrder is Int), tying with AIR_MAIN_HEAVY_WEIGHT
-- (a 3-way tie -> nondeterministic display order). Renumber the Air catalogue from
-- AIR_MAIN_FSC onward as whole integers so the sequence stays globally monotonic + distinct.
UPDATE "ChargeLineDefinition" SET "sortOrder" = 10 WHERE "key" = 'AIR_MAIN_FSC';
UPDATE "ChargeLineDefinition" SET "sortOrder" = 11 WHERE "key" = 'AIR_MAIN_PEAK_SEASON';
UPDATE "ChargeLineDefinition" SET "sortOrder" = 12 WHERE "key" = 'AIR_DEST_THC';
UPDATE "ChargeLineDefinition" SET "sortOrder" = 13 WHERE "key" = 'AIR_DEST_IMPORT_CLEARANCE';
UPDATE "ChargeLineDefinition" SET "sortOrder" = 14 WHERE "key" = 'AIR_DEST_STORAGE';
UPDATE "ChargeLineDefinition" SET "sortOrder" = 15 WHERE "key" = 'AIR_DEST_LAST_MILE';
UPDATE "ChargeLineDefinition" SET "sortOrder" = 16 WHERE "key" = 'AIR_TAG_NON_STACKABLE';
UPDATE "ChargeLineDefinition" SET "sortOrder" = 17 WHERE "key" = 'AIR_TAG_FRAGILE';
UPDATE "ChargeLineDefinition" SET "sortOrder" = 18 WHERE "key" = 'AIR_TAG_DG';
UPDATE "ChargeLineDefinition" SET "sortOrder" = 19 WHERE "key" = 'AIR_TAG_OOG';
UPDATE "ChargeLineDefinition" SET "sortOrder" = 20 WHERE "key" = 'AIR_TAG_HEAVY';
