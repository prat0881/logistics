-- S5.9.6 (register A6) — split Quote.draftJson: `draftJson` stays the forwarder's scratchpad,
-- `submittedJson` becomes the offer, written by FfPortalService.submit alone.
ALTER TABLE "Quote" ADD COLUMN "submittedJson" JSONB;

-- Backfill, best-effort and deliberately conservative. What is PROVEN about the predicate:
--   * `submittedAt` is written in exactly one place in the codebase — the update inside
--     FfPortalService.submit's transaction — and is never cleared anywhere. So
--     `submittedAt IS NOT NULL` means "this forwarder submitted at least once", exactly.
--   * That same update also wrote the submitted bid onto `draftJson`, so for a row nobody has
--     touched since, `draftJson` IS the submitted offer.
-- What is NOT proven, and cannot be recovered here: `saveDraft` overwrites `draftJson` verbatim at
-- any writable status (RFQ_SENT/REQUOTED) with no version guard, so a forwarder asked to re-quote
-- who typed and saved after submitting has already overwritten their submitted value — the old one
-- is simply gone. For those legacy REQUOTED rows this copies the last saved state, which is the
-- same deliberate "keep a price rather than lose one" bias rfq-schedule.listener.ts documents for
-- the expiry sweep, not a provenance claim. Rows written after this migration are exact: submit
-- writes both columns from one value.
-- RFQ_SENT is excluded because for it the copy would be provably wrong rather than merely
-- unproven: submit leaves no row at RFQ_SENT (it fires SUBMIT -> QUOTED in the same request), and
-- the one edge back into RFQ_SENT — INVALID --send--> RFQ_SENT on re-distribution — clears
-- `draftJson` in the same write (RfqService.distribute). So an RFQ_SENT row that still has both a
-- `submittedAt` and a `draftJson` got that draft from a post-reactivation `saveDraft`: a
-- scratchpad, never an offer.
UPDATE "Quote" SET "submittedJson" = "draftJson"
 WHERE "submittedAt" IS NOT NULL AND "draftJson" IS NOT NULL AND "status" <> 'RFQ_SENT';
