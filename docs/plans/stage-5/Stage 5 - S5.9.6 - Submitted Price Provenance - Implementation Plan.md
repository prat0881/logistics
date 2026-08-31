# S5.9.6 — Submitted Price Provenance (closes register A6) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Stop `Quote.draftJson` meaning two different things, so the price the product prices from is provably the one the forwarder submitted.

**Architecture:** `draftJson` becomes the forwarder's scratchpad, full stop. A new `Quote.submittedJson` holds the offer, written by `submit` and by nothing else. Every reader that prices something a human acts on moves to `submittedJson`. Product owner chose this (option A1) over a "retain only if untouched" heuristic and over a history table.

## Global Constraints

- **This is the one migration this whole effort takes.** One nullable Json column plus a backfill. Nothing else.
- **`prisma migrate dev` DOES NOT WORK in this shell.** Use `prisma migrate diff --shadow-database-url <scratch>`, hand-write `migration.sql`, then `migrate deploy`. **Strip the ~10 unrelated `ALTER COLUMN "id" DROP DEFAULT` lines** from any derived diff — that is pre-existing drift, register C3, and must not ride along.
- Rebuild `@svyft/shared` after editing it: `pnpm --filter @svyft/shared build`.
- `vitest`/`jest` do NOT type-check. `pnpm run typecheck` is its own gate.
- Before api e2e: `set -a; . apps/api/.env; set +a`. Postgres on **5433**. Always `--runInBand`.
- MUTATION-PROVE every absence assertion, each with a positive control that stays green. `toHaveTextContent` does substring matching — a mutation to a superset string will not redden.
- NEVER write a comment asserting a mechanism you have not traced. This is the recurring defect on this branch.
- Vocabulary rule D5: no user-visible string may say "Awarded" or claim something has happened before it has.
- Known flakes (register C5): `award-generate`, `ff-portal-v3`, `charge-catalogue`, `emails`, `ff-portal-stale-submit`. Re-run in isolation and REPORT; never "fix".

---

## Task 1: The column and its writers

**Files:** `prisma/schema.prisma`, a new `prisma/migrations/<ts>_quote_submitted_json/migration.sql`, `apps/api/src/modules/ff-portal/ff-portal.service.ts`, `apps/api/src/modules/rfq/rfq.service.ts`, `apps/api/test/ff-portal.e2e-spec.ts`

**Produces:** `Quote.submittedJson Json?` — the last thing the forwarder actually submitted. Task 2's readers consume it.

- [ ] **Step 1 — schema.** Add `submittedJson Json?` to `model Quote`, directly beneath `draftJson`, with a comment stating the split: `draftJson` is the forwarder's scratchpad and is overwritable by `saveDraft` at any writable status; `submittedJson` is the offer and is written by `submit` alone. Name register A6 as the reason.

- [ ] **Step 2 — migration, by hand.** Derive with `migrate diff --shadow-database-url`, then hand-write `migration.sql` containing ONLY:
```sql
ALTER TABLE "Quote" ADD COLUMN "submittedJson" JSONB;
-- Backfill: `submittedAt` is already the exact marker for "this forwarder submitted at least
-- once", so every row that has one had its submitted bid persisted onto draftJson by submit().
UPDATE "Quote" SET "submittedJson" = "draftJson"
 WHERE "submittedAt" IS NOT NULL AND "draftJson" IS NOT NULL;
```
Strip every `ALTER COLUMN "id" DROP DEFAULT` the diff proposes. Apply with `migrate deploy` and confirm `migrate status` is clean.

- [ ] **Step 3 — write the failing e2e** in `ff-portal.e2e-spec.ts`:
```ts
it("S5.9.6 (A6) — submit records submittedJson; a later saveDraft moves draftJson and leaves it alone", async () => {
  // FF submits 5000 -> both columns hold it
  // exec requests a re-quote -> REQUOTED, both untouched
  // FF saves a HALF-EDITED draft (one line 4200, another null) and never submits
  // draftJson === the half-edit; submittedJson === the original 5000
});
```
Plus a positive control in the same test: a second `submit` moves BOTH columns.

- [ ] **Step 4 — run it, confirm it fails** for the right reason (`submittedJson` undefined/null), not a setup error.

- [ ] **Step 5 — `submit` writes both.** `ff-portal.service.ts` around `:642` already writes `draftJson: draft` inside the submit transaction. Write `submittedJson` in the same object, from the same value, so the two can never diverge at submit time.

- [ ] **Step 6 — clear both where a quote is reset.** `rfq.service.ts:510` clears `draftJson` when a quote (re)enters distribution — a REACTIVATED (INVALID→RFQ_SENT) quote must not carry an old bid. `submittedJson` must be cleared in the same write, for the same reason.
  **Then check `change-order.strategy.ts`'s re-freeze**, which also clears `draftJson`. Decide deliberately whether an invalidated quote's `submittedJson` should be cleared too, TRACE the consequence for the compare screen, and state your reasoning in the report either way. Do not guess.

- [ ] **Step 7 — run, confirm green, mutation-prove.** Drop `submittedJson` from `submit`'s write → the test's provenance assertion reddens, the half-edit assertion stays green. Drop the clear in Step 6 → the reactivation assertion reddens. Revert each.

- [ ] **Step 8 — full api gate + typecheck, then commit.**

---

## Task 2: The readers, and the honest reason the sweep keeps a draft

**Files:** `apps/api/src/modules/comparison/comparison.service.ts`, `apps/api/src/modules/award/award.service.ts`, `apps/api/src/modules/quotation/quotation.service.ts`, `apps/api/src/modules/rfq/rfq-schedule.listener.ts`, their e2e specs, `docs/Stage 5 - Approval Freeze & Compare Screen Round 4 - Design.md`, `docs/Stage 5 - Session Handoff.md`

**Consumes:** Task 1's `submittedJson`.

- [ ] **Step 1 — move the three pricing readers.** Each currently reads `draftJson`; each must read `submittedJson`:
  - `comparison.service.ts:301-302` (`buildLeg` — the offer grid). The `if (!draftJson) continue` gate becomes the `submittedJson` gate, which is what makes an offer's existence mean "they submitted".
  - `award.service.ts:1343` (`generateClientQuote`'s winner pricing).
  - `quotation.service.ts:770` (`buildInitialDraft` — the client letter's cost lines and `validUntil`).
  **Do NOT move `ff-portal.service.ts:228`** (the portal's own pre-fill) — the forwarder must keep editing their scratchpad. Trace that before you touch anything and confirm it in your report.

- [ ] **Step 2 — rewrite the sweep's comment, keep its behaviour.** `rfq-schedule.listener.ts:144` retains `draftJson` for a `REQUOTED` quote. That behaviour is still right, but its stated reason ("it is the only thing keeping that offer on the compare screen") becomes FALSE the moment Step 1 lands — the offer now comes from `submittedJson`. The surviving reason is **portal pre-fill**: a forwarder who is re-negotiated after an expiry must still open the portal onto their previous numbers rather than a blank matrix. Say that, and say plainly that it is no longer a provenance claim.

- [ ] **Step 3 — write the failing e2e** in `comparison.e2e-spec.ts`:
```ts
it("S5.9.6 (A6) — the grid prices a REQUOTED forwarder off their SUBMITTED price, not their live draft", async () => {
  // FF submitted 5000, exec re-quoted, FF saved a 4200 half-edit and went silent
  const offer = leg.offers.find((o) => o.freightForwarderId === ffId);
  expect(offer.nativeTotal).toBe(5000);   // not 4200
  // Positive control in the same test: after the FF actually SUBMITS 4750, the grid moves to 4750.
});
```

- [ ] **Step 4 — re-aim the D4 tests.** `award-requote.e2e-spec.ts` and `ff-portal-requote-submit.e2e-spec.ts` currently assert `draftJson` survives the sweep. The surviving guarantee is that **`submittedJson`** does. Update each, and state per test in your report whether the original purpose survived or you narrowed it.

- [ ] **Step 5 — run, confirm green, mutation-prove.** Point `buildLeg` back at `draftJson` → the 5000 assertion reddens and the 4750 control stays green. Revert.

- [ ] **Step 6 — docs.** In the design doc, amend D4: record that its premise was false, that A1 was the product owner's chosen fix, and what each column now means. In the handoff, close register **A6** with the resolution.

- [ ] **Step 7 — full `pnpm run ci`, then commit.**

---

## Final gate

- [ ] Full `pnpm run ci` green.
- [ ] Opus whole-branch review over this sub-build's range. It has found a real defect on every sub-build in this effort, including one the ten task reviews of S5.9.5 all passed. Point it especially at: any remaining reader of `draftJson` that prices something a human acts on; whether the migration's backfill is exact; and whether any comment still claims `draftJson` is the submitted price.
- [ ] Update the handoff.
