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
-- RFQ_SENT is excluded because for it the copy is at best worthless and at worst a phantom offer:
-- submit leaves no row at RFQ_SENT (it fires SUBMIT -> QUOTED in the same request), and the one
-- edge back into RFQ_SENT — INVALID --send--> RFQ_SENT on re-distribution — clears `draftJson` in
-- the same write (RfqService.distribute). So an RFQ_SENT row that still has both a `submittedAt`
-- and a `draftJson` got that draft from a post-reactivation `saveDraft`: a scratchpad, never an
-- offer.
--
-- SCOPED, because this runs against HISTORICAL rows and the argument above is about today's code:
-- that `draftJson` clear only landed in 34e0ef2 (2026-08-08), while submit started persisting the
-- bid onto `draftJson` in 2b7eb08 (2026-08-07). A quote reactivated inside that one-day window
-- sits at RFQ_SENT with a `submittedAt` and its GENUINE old submitted draft, and this exclusion
-- drops it. That is benign: RFQ_SENT is not in COMPARABLE_STATUSES (comparison.service.ts), so the
-- row shows no offer either way, and the draft was priced against a basis the re-distribution had
-- already superseded. The exclusion can only ever drop a value, never manufacture one.
UPDATE "Quote" SET "submittedJson" = "draftJson"
 WHERE "submittedAt" IS NOT NULL AND "draftJson" IS NOT NULL AND "status" <> 'RFQ_SENT';
