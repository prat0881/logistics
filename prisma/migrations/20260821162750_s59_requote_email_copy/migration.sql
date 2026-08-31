-- S5.9 Task 5 review round 2, IMPORTANT 2 — same root cause as
-- 20260806020000_backfill_air_heavy_weight_calc: seedReferenceData's MessageTemplate upsert is
-- create-only (`update: {}`, message-templates.seed.ts), so editing the
-- rfq.requote_requested.email body in source has no effect on a row that was already seeded
-- (dev/staging/prod). D7 stopped rotating the FF's portal token on a re-quote, so this copy
-- needs to stop implying a fresh link and say the existing one hasn't changed instead. Backfill
-- the already-seeded row directly so every deployed environment actually gets the new copy, not
-- just a freshly-seeded one.
UPDATE "MessageTemplate"
SET "body" = 'We would like to request a revised quote for RFQ {{RFQ_Number}}.
Comment: {{Comment}}

Your earlier submission remains on file. Please submit your updated price via your usual secure portal link — it has not changed: {{Access_Link}}',
    "updatedAt" = now()
WHERE "key" = 'rfq.requote_requested.email';
