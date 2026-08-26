# S5.9.5 — Approval Freeze & Compare Screen Round 4 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make approval a real freeze on the Compare Quotes screen — the approved forwarder stays visible and marked, every other action on that leg is disabled, Reject is the one way back — and stop an unanswered re-quote from destroying the forwarder's price.

**Architecture:** Backend first (read model, machine edges, guards), then the pure frontend row model, then the two grid renderers and the action bar. Nine of the ten tasks are independently testable; the read-model change in Task 1 is what makes Tasks 8–10 have anything to render. Design of record: `docs/Stage 5 - Approval Freeze & Compare Screen Round 4 - Design.md` — read it before Task 1.

**Tech Stack:** NestJS + Prisma/Postgres (`apps/api`), React/Vite + TanStack Query + react-hook-form (`apps/web`), pure TS + Zod domain core (`packages/shared`). Jest e2e for api, Vitest for web/shared.

## Global Constraints

- **No database migration is required by this plan.** No new status values, no new columns. The reopen reason lands on the existing `AwardDecisionEvent.reason` column. If you find yourself reaching for `prisma migrate`, stop — you have gone outside the design.
- **Rebuild `@svyft/shared` after editing it:** `pnpm --filter @svyft/shared build`. api runtime and web build resolve it through a `node_modules` symlink to `dist/`; a stale `dist` means consumers silently see old code.
- **`vitest`/`jest` do not type-check.** `pnpm run typecheck` is a separate gate and must be run per task, not once at the end.
- **API e2e needs a real Postgres on port 5433** (5432 is a different project). Before running: `set -a; . apps/api/.env; set +a`. Always `--runInBand`.
- **Known intermittent e2e flakes (register C5):** `award-generate`, `ff-portal-v3`, `charge-catalogue`, `emails`, `ff-portal-stale-submit`. If one of these fails, re-run it in isolation and report the result. **Never "fix" them.**
- **Mutation-prove every absence assertion.** Break the production code, watch the test go red, revert, watch it go green. Paste the red output into the task report. Six tests that could not fail have already been found in this area.
- **Never write a comment asserting a mechanism you have not traced end to end.** Five review rounds have been spent correcting these, one of which replaced a false claim with a different false claim. "This is a safety bias, not exercised behaviour" is an acceptable and often correct thing to write.
- **Vocabulary rule D5 is binding.** No user-visible string may say "Awarded" or claim something has happened before it has. "Approved" is provisional. The disabled Award rail step is the sole exception and is not touched by this plan.
- **RBAC:** roles are `EXECUTIVE` / `MANAGER` / `ADMINISTRATOR`. Both guards are global; no `@Roles` means any authenticated role.

---

## File Structure

**Backend — modified**

| File | Responsibility after this plan |
| :-- | :-- |
| `apps/api/src/modules/comparison/comparison.service.ts` | `COMPARABLE_STATUSES` admits `APPROVED` + `EXPIRED`; `pendingForwarders` excludes any quote that produced an offer; `buildRecommendation` ranks `EXPIRED` too |
| `apps/api/src/modules/rfq/rfq-schedule.listener.ts` | Expiry sweep keeps `draftJson` for `REQUOTED`, still discards it for `RFQ_SENT` |
| `apps/api/src/modules/award/award.module.ts` | Two new leg edges from `APPROVED`; one new quote edge from `EXPIRED` |
| `apps/api/src/modules/award/award.service.ts` | `reject()` gains its `APPROVED` mode; `reopenComparison()` takes a reason |
| `apps/api/src/modules/award/award.controller.ts` | `@Roles(EXECUTIVE)` on request-requote; `@Roles(ADMINISTRATOR, MANAGER)` + body on reopen-comparison |
| `apps/api/src/modules/award/negotiation.service.ts` | `REQUOTABLE_STATUSES` admits `EXPIRED` |
| `apps/api/src/modules/ff-portal/ff-portal.service.ts` | Submit refused on a leg with an approved forwarder; DTO says why |

**Backend — created**

| File | Responsibility |
| :-- | :-- |
| `apps/api/src/modules/award/query-lock.service.ts` | The ONE definition of "this query is locked". `assertUnlocked(queryId, tx?)` throws 409. Replaces five ad-hoc `awardSnapshot` checks. |

**Shared — modified**

| File | Responsibility |
| :-- | :-- |
| `packages/shared/src/award.ts` | `reopenComparisonSchema` + `ReopenComparisonInput` |
| `packages/shared/src/ff-portal.ts` | `FfPortalLegDto.closedReason` |

**Frontend — modified**

| File | Responsibility |
| :-- | :-- |
| `apps/web/src/features/compare/comparisonRowModel.ts` | `GridCell` discriminated union (`offer` \| `pending`); `approved` flag; approved mark/tint/footnote constants |
| `apps/web/src/features/compare/ComparisonGrid.tsx` | Renders both cell kinds; the "Awaiting response" list is deleted |
| `apps/web/src/features/compare/ComparisonGridColumns.tsx` | Pending columns; uses the extracted `OfferMarks` |
| `apps/web/src/features/compare/ComparisonGridRows.tsx` | Pending rows; uses the extracted `OfferMarks` |
| `apps/web/src/features/compare/CompareLegPanel.tsx` | Approved leg → every control disabled-with-reason except Reject; locked → nothing |
| `apps/web/src/features/compare/QuotingClientPanel.tsx` | Reopen opens a reason dialog instead of firing directly |
| `apps/web/src/features/compare/useAwardActions.ts` | `useReopenComparison` takes a body |
| `apps/web/src/features/ff-portal/LegSection.tsx` | Renders `closedReason` |

**Frontend — created**

| File | Responsibility |
| :-- | :-- |
| `apps/web/src/features/compare/OfferMarks.tsx` | The ★ / ⚑ / approved mark cluster. Extracted because it is currently duplicated **four** times (priced and unpriced branches × two orientations) and this plan adds a third mark to every copy. |
| `apps/web/src/features/compare/ReopenDialog.tsx` | Reopen's required-reason modal, same shape as `RejectDialog` |

---

## Task 1: The compare read model shows every forwarder and every live status

**Files:**
- Modify: `apps/api/src/modules/comparison/comparison.service.ts:75-89` (`COMPARABLE_STATUSES`, `PENDING_STATUSES`), `:339-343` (`pendingForwarders`), `:395-399` (`buildRecommendation`'s filter)
- Test: `apps/api/test/comparison.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GET /api/queries/:id/comparison` now emits an `OfferDto` for a quote whose status is `APPROVED` or `EXPIRED` **when that quote still has a `draftJson`**, and emits no `PendingForwarderDto` for any quote that produced an offer. `LegComparisonDto` shape is unchanged — no new fields. Tasks 8–10 depend on this and on nothing else here.

- [ ] **Step 1: Read the design's D4 and D8 sections, and re-trace the five comments they name**

Open `docs/Stage 5 - Approval Freeze & Compare Screen Round 4 - Design.md` and read D4 and D8 in full. D8 names five places that reason *from* `APPROVED` being excluded. Open each and decide, per comment, whether its **conclusion** survives this change:

1. `comparison.service.ts:80-83` — `PENDING_STATUSES`' comment ("SELECT … and APPROVED … appear in neither list"). **Becomes false.**
2. `apps/web/src/features/compare/comparisonRowModel.ts` — `buildComparisonRowModel`'s `locked` rationale. **Conclusion survives** (`buildRecommendation` still never ranks `APPROVED`), **stated cause becomes false**. Rewrite the cause; do not delete the suppression.
3. `apps/web/src/features/compare/QuotingClientPanel.test.tsx:15-18` — the forwarder-lookup note.
4. `apps/web/src/features/compare/NegotiateDialog.tsx` — the "`APPROVED` is eligible" branch in `buildCandidates`, currently dead code. **Becomes live.**
5. `packages/shared/src/award.ts:106` and `:134`.

Write down, in the task report, which conclusions survive and which do not. Do not edit them yet — items 2, 3 and 4 are frontend and belong to Tasks 8 and 10; fix items 1 and 5 in this task.

- [ ] **Step 2: Write the failing e2e tests**

Add to `apps/api/test/comparison.e2e-spec.ts`. Follow the file's existing `PREFIX`/`CODE` namespacing and `afterAll` cleanup convention — do not invent a new one.

```ts
it("S5.9.5 (D8) — an APPROVED quote still produces an offer on its own leg", async () => {
  // Seed a leg with two forwarders, both QUOTED, then drive the REAL maker+checker endpoints
  // (send-for-approval, then approve by a DIFFERENT manager) so APPROVED is reached honestly.
  const res = await request(app.getHttpServer())
    .get(`/api/queries/${queryId}/comparison`)
    .set("Cookie", execCookie)
    .expect(200);
  const leg = res.body.legs.find((l: any) => l.legId === legId);
  const approved = leg.offers.filter((o: any) => o.quoteStatus === "APPROVED");
  expect(approved.length).toBeGreaterThan(0);
  expect(approved[0].freightForwarderId).toBe(winnerFfId);
  expect(approved[0].priced).toBe(true);
  // and it must NOT also appear as a pending forwarder
  expect(leg.pendingForwarders.map((p: any) => p.freightForwarderId)).not.toContain(winnerFfId);
});

it("S5.9.5 (D4) — an EXPIRED quote that still carries a price produces an offer; one that does not, does not", async () => {
  // Two forwarders on one leg:
  //   ffWithPrice: QUOTED -> (request-requote) -> REQUOTED -> expiry sweep -> EXPIRED, draftJson kept
  //   ffNoPrice:   RFQ_SENT -> expiry sweep -> EXPIRED, draftJson discarded
  const leg = /* fetch as above */;
  const priced = leg.offers.find((o: any) => o.freightForwarderId === ffWithPrice);
  expect(priced).toBeDefined();
  expect(priced.quoteStatus).toBe("EXPIRED");
  expect(priced.priced).toBe(true);
  expect(leg.pendingForwarders.map((p: any) => p.freightForwarderId)).not.toContain(ffWithPrice);

  expect(leg.offers.find((o: any) => o.freightForwarderId === ffNoPrice)).toBeUndefined();
  expect(leg.pendingForwarders.map((p: any) => p.freightForwarderId)).toContain(ffNoPrice);
});

it("S5.9.5 (D4) — an EXPIRED offer carrying a price is rankable; a REQUOTED one is not", async () => {
  // One leg, one forwarder, priced. While REQUOTED: recommendation must not name it.
  expect(legWhileRequoted.recommendation).toBeNull();
  // After the sweep expires it: recommendation must name it.
  expect(legAfterExpiry.recommendation.quoteId).toBe(quoteId);
});
```

The second test's two halves must both be present in the same test — they are the positive and negative control for the same `draftJson` condition, so neither can be reached by a bug that collapses them.

- [ ] **Step 3: Run the tests and confirm they fail for the right reason**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- comparison.e2e-spec.ts --runInBand
```

Expected: all three FAIL. The first two should fail on `expect(received).toBeGreaterThan(0)` / `toBeDefined()` — i.e. the offer is genuinely missing, not the test erroring during setup. If a test errors in setup instead of asserting, fix the setup before continuing; a test that dies before its assertion proves nothing.

- [ ] **Step 4: Widen the two status lists**

In `apps/api/src/modules/comparison/comparison.service.ts`, replace lines 68-89 (the two constants and their comments):

```ts
// A quote is "comparable" (produces `OfferDto` rows, design §7/§11) once it has been submitted
// and carries a priceable draft. QUOTED is the normal, rankable case. REQUOTED is the DURABLE
// "awaiting a revised quote" state (a change-order re-ask): the FF's EARLIER price stays visible
// here but is excluded from RANKING — see buildRecommendation's filter and `awaitingReQuote`.
// PENDING_APPROVAL (S5.9 §4.4) is a QUOTED offer under review, not a different price.
// APPROVED and EXPIRED are S5.9.5 (design D8/D4):
//   APPROVED — the winning offer must not vanish from the grid the moment a checker approves it.
//     This is the same defect this list already fixed once for PENDING_APPROVAL.
//   EXPIRED  — after D4 the expiry sweep no longer discards a REQUOTED quote's `draftJson`, so an
//     EXPIRED quote can now carry a real, submitted price. Admitting EXPIRED here is SELF-LIMITING:
//     `buildLeg` below skips any quote with no `draftJson`, so an ordinary forwarder who never
//     submitted still produces no offer. Only one holding a real price does.
const COMPARABLE_STATUSES: readonly QuoteStatus[] = [
  QuoteStatus.QUOTED,
  QuoteStatus.REQUOTED,
  QuoteStatus.PENDING_APPROVAL,
  QuoteStatus.APPROVED,
  QuoteStatus.EXPIRED,
];
// FFs with NO comparable price at all — surfaced as "awaiting" in `pendingForwarders`. REQUOTED is
// deliberately NOT here (it always has an offer). EXPIRED IS in BOTH lists after S5.9.5, which is
// why `pendingForwarders` below subtracts the quotes that actually produced an offer rather than
// filtering on status alone — without that subtraction the same forwarder renders twice, once as a
// priced cell and once as a "Not quoted" cell.
const PENDING_STATUSES: readonly QuoteStatus[] = [
  QuoteStatus.RFQ_SENT,
  QuoteStatus.EXPIRED,
  QuoteStatus.INVALID,
  QuoteStatus.CLOSED,
];
```

- [ ] **Step 5: Subtract offered quotes from `pendingForwarders`**

In `buildLeg`, the `offers` loop already runs before `pendingForwarders` is built. Record which quote ids produced an offer, and subtract them. Replace the `pendingForwarders` assignment (around `:339`):

```ts
// S5.9.5 — a quote id lands here only if it actually emitted at least one OfferDto above.
// `offers` is (FF × variant), so one quote can contribute several entries; a Set collapses them.
const offeredQuoteIds = new Set(offers.map((o) => o.quoteId));
const pendingForwarders: PendingForwarderDto[] = legQuotes
  .filter((q) => PENDING_STATUSES.includes(q.status) && !offeredQuoteIds.has(q.id))
  .map((q) => ({
    freightForwarderId: q.freightForwarderId,
    freightForwarderName: ffNameById.get(q.freightForwarderId) ?? "",
    quoteStatus: q.status,
  }));
```

- [ ] **Step 6: Let the engine rank an EXPIRED offer**

In `buildRecommendation` (around `:395`), replace the filter and its comment:

```ts
const candidates: RecommendOffer[] = offers
  // REQUOTED offers stay visible but are excluded from ranking: we have asked the forwarder to
  // replace this price and are still waiting, so recommending it now would be premature (design
  // §10.1). EXPIRED is admitted (S5.9.5 D4) for the mirror-image reason — the waiting is OVER and
  // the forwarder did not answer, so this IS their final price and it should be ranked.
  //
  // Consequence, accepted in the design and not a bug: the `★` can leave a forwarder when you
  // negotiate and return if they go silent. It only oscillates before a decision exists — once a
  // leg is sent for approval the mark reads the decision's frozen snapshot, not this function.
  //
  // APPROVED is still NOT ranked. An approved leg's recommendation is a matter of record, read
  // from the decision snapshot by the frontend row model, not re-derived live.
  .filter(
    (o) =>
      o.priced &&
      (o.quoteStatus === QuoteStatus.QUOTED || o.quoteStatus === QuoteStatus.EXPIRED),
  )
```

- [ ] **Step 7: Fix the two shared-package comments**

In `packages/shared/src/award.ts`, update the comments at `:106` and `:134` that reason from `APPROVED` being excluded from `offers`. Both claim the exclusion as a fact; state the new fact instead. Do not change any type.

- [ ] **Step 8: Run the tests and confirm they pass**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- comparison.e2e-spec.ts --runInBand
```

Expected: all three PASS.

- [ ] **Step 9: Mutation-prove each new assertion**

Three separate mutations, each reverted before the next:

1. Remove `QuoteStatus.APPROVED` from `COMPARABLE_STATUSES` → test 1 must go red. Revert.
2. Remove `!offeredQuoteIds.has(q.id)` from the `pendingForwarders` filter → tests 1 and 2's "not to contain" assertions must go red. Revert.
3. Remove `|| o.quoteStatus === QuoteStatus.EXPIRED` from the ranking filter → test 3's second half must go red **and its first half must stay green**. Revert.

Paste each red output into the task report. If mutation 3 reddens both halves of test 3, the test is collapsing two failure modes into one — split it.

- [ ] **Step 10: Full api gate + typecheck**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- --runInBand
pnpm run typecheck
```

Report any failure in the register-C5 flake list separately, with an isolated re-run.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/modules/comparison/comparison.service.ts packages/shared/src/award.ts apps/api/test/comparison.e2e-spec.ts
git commit -m "feat(s5.9.5): APPROVED and priced-EXPIRED quotes are comparable (D4/D8)"
```

---

## Task 2: An unanswered re-quote keeps its price and stays re-negotiable

**Files:**
- Modify: `apps/api/src/modules/rfq/rfq-schedule.listener.ts:108-115` (the per-quote sweep body)
- Modify: `apps/api/src/modules/award/award.module.ts:59-79` (quote transitions — add one edge)
- Modify: `apps/api/src/modules/award/negotiation.service.ts:18-21` (`REQUOTABLE_STATUSES`)
- Test: `apps/api/test/award-requote.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1's widened `COMPARABLE_STATUSES` — without it, a preserved price on an `EXPIRED` quote would still not appear in the comparison, so Task 1 must land first.
- Produces: quote transition `EXPIRED --request_requote--> REQUOTED`; `REQUOTABLE_STATUSES` includes `EXPIRED`. Task 10's `NegotiateDialog` eligibility mirrors this list and must match it exactly.

- [ ] **Step 1: Write the failing e2e tests**

Add to `apps/api/test/award-requote.e2e-spec.ts`, following its existing `seedLeg` helper and prefix convention.

```ts
it("S5.9.5 (D4) — the expiry sweep keeps a REQUOTED quote's submitted price, and still discards an RFQ_SENT draft", async () => {
  // ffPriced: QUOTED with a real draftJson -> request-requote -> REQUOTED
  // ffDraft:  RFQ_SENT with a partially-filled draftJson the FF never submitted
  await fireExpirySweep(rfqId);

  const requoted = await prisma.quote.findUniqueOrThrow({ where: { id: pricedQuoteId } });
  expect(requoted.status).toBe("EXPIRED");
  expect(requoted.draftJson).not.toBeNull();          // the price survived
  expect((requoted.draftJson as any).charges).toBeDefined();

  const neverSubmitted = await prisma.quote.findUniqueOrThrow({ where: { id: draftQuoteId } });
  expect(neverSubmitted.status).toBe("EXPIRED");
  expect(neverSubmitted.draftJson).toBeNull();        // still discarded
});

it("S5.9.5 (D4) — an EXPIRED quote can be re-negotiated, which reopens the forwarder's portal", async () => {
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/quotes/${expiredQuoteId}/request-requote`)
    .set("Cookie", execCookie)
    .send({ comment: "Are you still able to hold this price?" })
    .expect(201);

  const after = await prisma.quote.findUniqueOrThrow({ where: { id: expiredQuoteId } });
  expect(after.status).toBe("REQUOTED");
  expect(after.draftJson).not.toBeNull();  // re-negotiating does not discard it either
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- award-requote.e2e-spec.ts --runInBand
```

Expected: test 1 fails on `expect(requoted.draftJson).not.toBeNull()`; test 2 fails with a 409 ("Only a live (QUOTED) or provisionally APPROVED quote can be re-negotiated").

- [ ] **Step 3: Stop the sweep from discarding a submitted price**

In `apps/api/src/modules/rfq/rfq-schedule.listener.ts`, the `openQuotes` query already selects `id`, `legId` and `leg.legCode`. Add `status` to that select, then replace the discard line (`:112`) inside the `for (const q of openQuotes)` loop:

```ts
// S5.9.5 (D4, register A4) — discard the draft ONLY for a quote that was still RFQ_SENT.
// For a REQUOTED quote `draftJson` is NOT an unsubmitted draft: it is the forwarder's ALREADY
// SUBMITTED earlier price, retained on purpose by `requestRequote` (negotiation.service.ts, which
// fires the status change with no effect precisely so the price survives) and it is the only
// thing keeping that offer on the compare screen. Nulling it here destroyed a real, acceptable
// price as a direct consequence of asking for a better one — doing nothing would have kept it.
// The quote still EXPIRES: the window really did close and the forwarder's silence must be
// visible rather than reading as still-pending forever (design D4).
if (q.status === QuoteStatus.RFQ_SENT) {
  await this.prisma.quote.update({ where: { id: q.id }, data: { draftJson: Prisma.DbNull } });
}
await this.status.fire("quote", q.id, QuoteEvent.EXPIRE, { queryId: rfq.queryId });
```

- [ ] **Step 4: Add the quote edge back out of EXPIRED**

In `apps/api/src/modules/award/award.module.ts`, inside `this.registry.contribute("quote", [ … ])`, add beside the other negotiation sources:

```ts
// S5.9.5 (D4) — an EXPIRED quote that still carries a price can be asked again. Without this
// edge, D4's price-preservation would freeze the forwarder OUT: their price visible and
// approvable, their portal closed, and no way to reopen it. Re-negotiating is the deliberate act
// that reopens it with a fresh deadline, exactly as it is for a live quote.
{ from: QuoteStatus.EXPIRED, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
```

- [ ] **Step 5: Admit EXPIRED to the negotiation guard**

In `apps/api/src/modules/award/negotiation.service.ts`, replace the constant and its comment:

```ts
// Quote statuses a re-quote can legally be requested against — a live offer (QUOTED), one already
// provisionally selected (APPROVED, design §5), or one whose re-quote window closed with the
// forwarder silent (EXPIRED, S5.9.5 D4 — their price survives the sweep now, so asking again is
// the only way back into a conversation with them). Anything else (RFQ_SENT — no price to
// negotiate yet; INVALID/CLOSED/REQUOTED — already not-live, or already being asked) is a 409.
const REQUOTABLE_STATUSES: readonly string[] = [
  QuoteStatus.QUOTED,
  QuoteStatus.APPROVED,
  QuoteStatus.EXPIRED,
];
```

Then update the 409 message on `:80` so it no longer says only "live (QUOTED) or provisionally APPROVED":

```ts
throw new ConflictException(
  "Only a live, provisionally approved, or expired quote can be re-negotiated",
);
```

- [ ] **Step 6: Run and confirm the tests pass**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- award-requote.e2e-spec.ts --runInBand
```

- [ ] **Step 7: Mutation-prove**

1. Change the `if (q.status === QuoteStatus.RFQ_SENT)` guard to an unconditional null → test 1's `not.toBeNull()` reddens **and** its `neverSubmitted` half stays green. Revert.
2. Remove `QuoteStatus.EXPIRED` from `REQUOTABLE_STATUSES` → test 2 reddens with a 409. Revert.
3. Remove the new quote edge but keep `EXPIRED` in `REQUOTABLE_STATUSES` → test 2 must redden with an `IllegalTransitionError`, **not** a 409. This proves the guard and the edge are two independent gates, not one. Revert.

- [ ] **Step 8: Full api gate + typecheck, then commit**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- --runInBand
pnpm run typecheck
git add apps/api/src/modules/rfq/rfq-schedule.listener.ts apps/api/src/modules/award/award.module.ts apps/api/src/modules/award/negotiation.service.ts apps/api/test/award-requote.e2e-spec.ts
git commit -m "feat(s5.9.5): an unanswered re-quote keeps its price and stays re-negotiable (D4, closes A4)"
```

---

## Task 3: Reject reverses an approval

**Files:**
- Modify: `apps/api/src/modules/award/award.module.ts` (leg transitions — two new edges)
- Modify: `apps/api/src/modules/award/award.service.ts:613-627` (`requireDecidable`), `:838-960` (`reject`)
- Test: `apps/api/test/award-workflow-checker.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: `POST /api/queries/:id/legs/:legId/reject` accepts a decision in `PENDING_APPROVAL` **or** `APPROVED`. In `APPROVED` mode it writes decision → `DRAFT`, fires `QuoteEvent.UNAPPROVE` on the approved quote, and fires `LegEvent.RETURN_FULL`/`RETURN_PARTIAL` on the leg. Task 10's action bar depends on this route accepting an approved leg.

- [ ] **Step 1: Add the two leg edges**

In `apps/api/src/modules/award/award.module.ts`, inside `this.registry.contribute("leg", [ … ])`, beside the existing pair from `PENDING_APPROVAL`:

```ts
// S5.9.5 (design D2) — the reversal edges. reject() gains a second mode that walks an APPROVED
// leg back, and it already chooses between "full" and "partial" using `isFullyQuotedForDecision`
// (the shared D4 rule), so it reuses the SAME two events rather than needing new ones.
//
// Deliberately NOT reusing REOPEN_AWARD + the projector's re-quote recompute (the route
// negotiation.service.ts takes): REQUOTE_PARTIAL/REQUOTE_OUTSTANDING are documented as fireable
// only by LegQuoteProjector's re-quote branch, and borrowing them here would break that stated
// rule and make the StatusTransition log unable to say whether a leg moved because of a re-quote
// or a rejection.
{ from: LegStatus.APPROVED, on: LegEvent.RETURN_FULL, to: LegStatus.FULLY_QUOTED, kind: "reopen" },
{ from: LegStatus.APPROVED, on: LegEvent.RETURN_PARTIAL, to: LegStatus.PARTIALLY_QUOTED, kind: "reopen" },
```

- [ ] **Step 2: Write the failing e2e tests**

Add to `apps/api/test/award-workflow-checker.e2e-spec.ts`:

```ts
it("S5.9.5 (D2) — a Manager rejects an APPROVED leg, reversing the approval on all three rows", async () => {
  // Drive the real flow: exec sends for approval, manager A approves.
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/reject`)
    .set("Cookie", managerBCookie)
    .send({ reason: "Client changed the delivery window" })
    .expect(201);

  const decision = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId } });
  expect(decision.status).toBe("DRAFT");
  expect(decision.rejectionReason).toBe("Client changed the delivery window");
  expect(decision.sentByUserId).toBeNull();

  expect((await prisma.quote.findUniqueOrThrow({ where: { id: winningQuoteId } })).status).toBe("QUOTED");
  expect((await prisma.leg.findUniqueOrThrow({ where: { id: legId } })).status).toBe("FULLY_QUOTED");
});

it("S5.9.5 (D2) — the Manager who approved may reject it back; four-eyes still bites on a PENDING_APPROVAL reject", async () => {
  // (a) APPROVED mode, same manager who approved -> 201
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legA}/reject`)
    .set("Cookie", managerACookie)
    .send({ reason: "My own mistake" })
    .expect(201);

  // (b) PENDING_APPROVAL mode, the manager who SENT it -> 403 SELF_APPROVAL, unchanged
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legB}/reject`)
    .set("Cookie", managerWhoSentCookie)
    .send({ reason: "trying to decide my own send" })
    .expect(403);
});

it("S5.9.5 (D2) — a reversal on a leg with an unanswered sibling returns it to PARTIALLY_QUOTED, not FULLY_QUOTED", async () => {
  // leg has ff1 (approved) + ff2 (still RFQ_SENT, deadline in the future)
  expect((await prisma.leg.findUniqueOrThrow({ where: { id: legId } })).status).toBe("PARTIALLY_QUOTED");
});
```

Test (b) is the positive control for (a): both halves must be present so a bug that removes four-eyes entirely cannot pass by making everything 201.

- [ ] **Step 3: Run and confirm failure**

Expected: all three FAIL with 409 `"This leg is not pending approval"` from `requireDecidable`.

- [ ] **Step 4: Split `requireDecidable` into decidable-vs-reversible**

In `apps/api/src/modules/award/award.service.ts`, keep `requireDecidable` exactly as it is for `approve()`, and add a sibling for `reject()`:

```ts
/**
 * S5.9.5 (design D2) — reject() accepts a decision in EITHER live state, and reports which one it
 * found so the caller can pick the right reversal fires.
 *
 * - PENDING_APPROVAL: the original mode. Four-eyes applies — the user who SENT it may not decide it.
 * - APPROVED: the reversal mode. Four-eyes deliberately does NOT apply: undoing your own mistake
 *   is a different act from approving your own work, and the product owner ruled explicitly that
 *   the Manager who approved a leg may reject it back. A single-manager team could otherwise never
 *   undo an approval at all.
 *
 * Anything else (DRAFT, or the REJECTED literal the enum allows but nothing ever persists) has no
 * live decision to act on and still 409s.
 */
private async requireRejectable(
  tx: Prisma.TransactionClient,
  legId: string,
  user: RequestUser,
): Promise<{ decision: LegAwardDecision; mode: "PENDING_APPROVAL" | "APPROVED" }> {
  const decision = await tx.legAwardDecision.findUnique({ where: { legId } });
  if (!decision) throw new NotFoundException("No award decision on this leg");
  if (decision.status === AwardDecisionStatus.PENDING_APPROVAL) {
    if (decision.sentByUserId === user.userId) throw new ForbiddenException("SELF_APPROVAL");
    return { decision, mode: "PENDING_APPROVAL" };
  }
  if (decision.status === AwardDecisionStatus.APPROVED) {
    return { decision, mode: "APPROVED" };
  }
  throw new ConflictException("This leg has no decision to reject");
}
```

- [ ] **Step 5: Teach `reject()` the reversal mode**

In `reject()`, replace `const { decision } = await this.requireDecidable(tx, legId, user);` with `const { decision, mode } = await this.requireRejectable(tx, legId, user);` and generalise the two "needs return" reads, which currently hard-code `PENDING_APPROVAL` as the only valid source:

```ts
// S5.9.5 (D2) — which status each row must be sitting in for its reversal edge to exist.
// In PENDING_APPROVAL mode this is exactly the old behaviour; in APPROVED mode it is the
// approval being undone. Both keep the existing "tolerate rather than refuse" shape (Q5):
// a row that has already drifted off the expected status is skipped with a warning, never a
// 409 — rejection must stay possible.
const expectedQuoteStatus =
  mode === "APPROVED" ? QuoteStatus.APPROVED : QuoteStatus.PENDING_APPROVAL;
const expectedLegStatus =
  mode === "APPROVED" ? LegStatus.APPROVED : LegStatus.PENDING_APPROVAL;
```

Use `expectedLegStatus` in the `legNeedsReturn` comparison and `expectedQuoteStatus` in the `quoteNeedsReturn` comparison, and update both `logger.warn` strings to name the expected status rather than the literal `"PENDING_APPROVAL"`.

Then pick the quote event by mode, at the existing post-commit quote fire:

```ts
// S5.9.5 (D2) — RETURN walks PENDING_APPROVAL -> QUOTED; UNAPPROVE walks APPROVED -> QUOTED.
// Both edges already exist and are already registered in award.module.ts; UNAPPROVE has simply
// never been fired by anything until now.
const quoteEvent = mode === "APPROVED" ? QuoteEvent.UNAPPROVE : QuoteEvent.RETURN;
if (decision.shortlistedQuoteId && quoteNeedsReturn) {
  await this.status.fire("quote", decision.shortlistedQuoteId, quoteEvent, {
    queryId, actorId: user.userId, reason: input.reason,
  });
}
```

The leg fire below it needs **no** change: it already chooses `RETURN_FULL`/`RETURN_PARTIAL` from `returnToFullyQuoted`, and Step 1 gave both events an `APPROVED` source.

- [ ] **Step 6: Run and confirm the tests pass**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- award-workflow-checker.e2e-spec.ts --runInBand
```

- [ ] **Step 7: Mutation-prove**

1. Delete the `APPROVED` branch from `requireRejectable` → tests 1 and 3 and half (a) of test 2 redden; half (b) stays green. Revert.
2. Force `quoteEvent` to always be `QuoteEvent.RETURN` → test 1's quote assertion reddens with an `IllegalTransitionError`. Revert.
3. Delete only the `RETURN_PARTIAL`-from-`APPROVED` edge → test 3 reddens, tests 1 and 2 stay green. Revert.
4. Add a four-eyes check to the `APPROVED` branch → test 2 half (a) reddens, half (b) stays green. Revert.

- [ ] **Step 8: Full api gate + typecheck, then commit**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- --runInBand
pnpm run typecheck
git add apps/api/src/modules/award/award.module.ts apps/api/src/modules/award/award.service.ts apps/api/test/award-workflow-checker.e2e-spec.ts
git commit -m "feat(s5.9.5): reject reverses an approval, no four-eyes on the reversal (D2, closes A3)"
```

---

## Task 4: Negotiation is Executive-only, enforced by the server

**Files:**
- Modify: `apps/api/src/modules/award/award.controller.ts:69-80` (the request-requote route)
- Test: `apps/api/test/award-requote.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `POST …/request-requote` returns 403 for `MANAGER` and `ADMINISTRATOR`.

- [ ] **Step 1: Write the failing test**

```ts
it("S5.9.5 (D3) — request-requote is Executive-only; a Manager and an Administrator are both refused", async () => {
  const body = { comment: "please sharpen" };
  const url = `/api/queries/${queryId}/legs/${legId}/quotes/${quoteId}/request-requote`;
  await request(app.getHttpServer()).post(url).set("Cookie", managerCookie).send(body).expect(403);
  await request(app.getHttpServer()).post(url).set("Cookie", adminCookie).send(body).expect(403);
  // Positive control — the same call from an Executive still succeeds, so a bug that 403s
  // everyone cannot pass this test.
  await request(app.getHttpServer()).post(url).set("Cookie", execCookie).send(body).expect(201);
});
```

- [ ] **Step 2: Run and confirm failure** — the two 403 expectations fail with 201.

- [ ] **Step 3: Add the role decorator**

```ts
// S5.9.5 (design D3) — Executive ONLY, and deliberately EXCLUDING the higher roles. This is the
// first workflow write in the codebase to do that, and it is not an oversight to be normalised
// away: the product owner's rule is that negotiation with a forwarder is always the Executive's,
// and a Manager/Administrator's route to a revised price is Reject-with-a-reason. The UI has
// enforced this since S5.9.1 R3; the server never shared the rule, so a checker could negotiate
// straight through the API — the same shape as register B1, already found and closed once.
@Roles(Role.EXECUTIVE)
@Post("legs/:legId/quotes/:quoteId/request-requote")
```

- [ ] **Step 4: Run and confirm the test passes.**

- [ ] **Step 5: Mutation-prove** — remove the decorator; the two 403 halves redden and the 201 half stays green. Revert.

- [ ] **Step 6: Full api gate + typecheck, then commit**

```bash
git add apps/api/src/modules/award/award.controller.ts apps/api/test/award-requote.e2e-spec.ts
git commit -m "feat(s5.9.5): request-requote is Executive-only, server-enforced (D3)"
```

---

## Task 5: A locked query refuses every write except Reopen and the quotation builder

**Files:**
- Create: `apps/api/src/modules/award/query-lock.service.ts`
- Create: `apps/api/test/query-lock.e2e-spec.ts`
- Modify: `apps/api/src/modules/award/award.module.ts` (provide + export `QueryLockService`)
- Modify: the services behind every write listed in Step 2

**Interfaces:**
- Consumes: nothing from Tasks 1–4.
- Produces: `QueryLockService.assertUnlocked(queryId: string, tx?: Prisma.TransactionClient): Promise<void>` — resolves when `Query.awardSnapshot` is `null`, throws `ConflictException(QUERY_LOCKED_MESSAGE)` otherwise. `export const QUERY_LOCKED_MESSAGE` is the single copy string. Task 10's frontend surfaces this message.

- [ ] **Step 1: Read D6 in the design, including the two exceptions**

`docs/Stage 5 - Approval Freeze & Compare Screen Round 4 - Design.md`, section D6. Note especially: **the quotation writes are excepted and this is not optional.** `QUOTING_CLIENT` is entered by freezing the snapshot and `AWAITING_CLIENT_DECISION` is reached by issuing the letter, so a lock that blocks `queries/:id/quotation` makes the locked state a dead end.

- [ ] **Step 2: Produce the endpoint inventory, and put it in the task report**

Do not guess this list — derive it. Run:

```bash
grep -rn "@Controller\|@Post\|@Patch\|@Put\|@Delete" apps/api/src/modules/*/*.controller.ts | grep -v node_modules
```

The query-scoped write surface, as of this plan, is:

| Controller | Prefix | Gate? |
| :-- | :-- | :-- |
| `queries.controller.ts` | `queries` | `PATCH :id`, `POST :id/create`, `PATCH :id/checklist` — **gate** |
| `legs.controller.ts` | `queries/:id/legs` | all three — **gate** |
| `cargo.controller.ts` | `queries/:id/cargo` | all writes — **gate** |
| `package.controller.ts` | `queries/:id/cargo/:cid/packages` | all writes — **gate** |
| `item.controller.ts` | `queries/:id/cargo/:cid/packages/:pid/items` | all writes — **gate** |
| `rfq.controller.ts` | `queries/:id` | ff-selection, distribute-all, distribute, reissue-token — **gate** |
| `award.controller.ts` | `queries/:id` | send-for-approval, approve, reject, request-requote, generate-client-quote — **gate**. `reopen-comparison` — **EXCEPT** |
| `emails.controller.ts` | `queries/:id/emails` | follow-up, acknowledgement — **gate** |
| `quotation.controller.ts` | `queries/:id/quotation` | **EXCEPT — all writes** |
| `ff-portal.controller.ts` | public portal | no gate needed — a locked query has every leg `APPROVED` and Task 7 closes an approved leg's portal |

If your inventory finds a write not in this table, add it and say so in the report. A missed endpoint is a hole in the lock.

- [ ] **Step 3: Write the failing e2e test**

Create `apps/api/test/query-lock.e2e-spec.ts`. Seed one query, drive it to `QUOTING_CLIENT` through the real endpoints (approve every leg, then `generate-client-quote`), then assert the whole surface at once:

```ts
const LOCKED = [
  { method: "patch", url: () => `/api/queries/${queryId}`, body: { contactName: "x" } },
  { method: "post",  url: () => `/api/queries/${queryId}/legs`, body: { /* minimal valid */ } },
  { method: "post",  url: () => `/api/queries/${queryId}/legs/${legId}/distribute`, body: {} },
  { method: "post",  url: () => `/api/queries/${queryId}/legs/${legId}/send-for-approval`, body: { quoteId, variant } },
  // …one row per gated endpoint from the Step 2 table
];

it.each(LOCKED)("S5.9.5 (D6) — $url is refused while the query is locked", async (row) => {
  const res = await (request(app.getHttpServer()) as any)
    [row.method](row.url()).set("Cookie", execCookie).send(row.body);
  expect(res.status).toBe(409);
  expect(res.body.message).toMatch(/quoted to the client/i);
});

it("S5.9.5 (D6) — the two exceptions still work while locked", async () => {
  // The quotation builder is the WHOLE POINT of the locked state.
  await request(app.getHttpServer())
    .patch(`/api/queries/${queryId}/quotation`)
    .set("Cookie", managerCookie).send({ marginPct: "12.5" }).expect(200);
  // And reopen is the door out.
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/reopen-comparison`)
    .set("Cookie", managerCookie).send({ reason: "client pushed the dates" }).expect(201);
});

it("S5.9.5 (D6) — every one of those same writes succeeds once the query is NOT locked", async () => {
  // Positive control for the whole table. Without this, a bug that 409s unconditionally passes
  // the `it.each` above with a full green board.
});
```

The third test is not optional. It is the positive control for the entire `it.each`.

- [ ] **Step 4: Run and confirm failure** — every `it.each` row fails with a 200/201.

- [ ] **Step 5: Write the service**

```ts
import { ConflictException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/** The one copy string for a refused write on a locked query. One constant because it is asserted
 *  in e2e and rendered by the compare screen — the two must not drift. */
export const QUERY_LOCKED_MESSAGE =
  "This query is being quoted to the client — reopen the comparison before changing anything";

/**
 * QueryLockService — the ONE definition of "this query is locked" (S5.9.5 design D6).
 *
 * Locked means `Query.awardSnapshot != null`, which is exactly the condition
 * `query-status.projector.ts` reads to derive QUOTING_CLIENT and, once a letter is issued,
 * AWAITING_CLIENT_DECISION. Before this service five sites checked that column ad hoc; the point
 * of centralising is that a new write cannot be added without a single, obvious call to make.
 *
 * Two callers deliberately do NOT use this — see D6:
 *   - `reopenComparison` is the door out and asserts the OPPOSITE (it 409s when NOT locked).
 *   - Everything under `queries/:id/quotation`: the locked state exists so that the client
 *     quotation can be composed and issued, so gating it would forbid the only work it allows.
 */
@Injectable()
export class QueryLockService {
  constructor(private readonly prisma: PrismaService) {}

  async assertUnlocked(queryId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    const query = await client.query.findUnique({
      where: { id: queryId },
      select: { awardSnapshot: true },
    });
    // A missing query is NOT this service's error to raise — every caller already 404s on its own
    // read, and answering "locked" for a row that does not exist would turn a 404 into a 409.
    if (query?.awardSnapshot != null) throw new ConflictException(QUERY_LOCKED_MESSAGE);
  }
}
```

- [ ] **Step 6: Wire it into every gated service**

Provide and export `QueryLockService` from `award.module.ts`, import that module where needed, and add `await this.lock.assertUnlocked(queryId)` as the **first** operation of each gated service method — before any other read, so a locked query never does partial work. Where the method already opens a transaction, pass `tx` so the check shares the transaction's snapshot.

- [ ] **Step 7: Run the test, confirm green, then mutation-prove**

1. Remove the `assertUnlocked` call from one gated service (pick `legs.service.ts`) → exactly that `it.each` row reddens and every other row stays green. This proves the rows are independent rather than all riding one guard. Revert.
2. Add an `assertUnlocked` call to `QuotationService.patch` → the exceptions test reddens. Revert. **This mutation is the one that protects the design's most important exception.**

- [ ] **Step 8: Full api gate + typecheck, then commit**

```bash
git add apps/api/src/modules/award/query-lock.service.ts apps/api/src/modules/award/award.module.ts apps/api/test/query-lock.e2e-spec.ts apps/api/src/modules
git commit -m "feat(s5.9.5): a locked query refuses every write except reopen and the quotation (D6)"
```

---

## Task 6: Reopen is Manager/Admin only and takes a required reason

**Files:**
- Modify: `packages/shared/src/award.ts` (add `reopenComparisonSchema`)
- Modify: `apps/api/src/modules/award/award.controller.ts:89-103`
- Modify: `apps/api/src/modules/award/award.service.ts:1167-1204` (`reopenComparison`)
- Test: `apps/api/test/award-generate.e2e-spec.ts` (which already covers reopen)

**Interfaces:**
- Consumes: nothing.
- Produces: `export const reopenComparisonSchema = z.object({ reason: z.string().trim().min(1).max(2000) })` and `export type ReopenComparisonInput`. `POST …/reopen-comparison` now requires that body and the `ADMINISTRATOR`/`MANAGER` role. Task 10's `ReopenDialog` and `useReopenComparison` consume this exact type.

- [ ] **Step 1: Write the failing e2e tests**

```ts
it("S5.9.5 (D6) — reopen is Manager/Admin only", async () => {
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/reopen-comparison`)
    .set("Cookie", execCookie).send({ reason: "x" }).expect(403);
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/reopen-comparison`)
    .set("Cookie", managerCookie).send({ reason: "x" }).expect(201);
});

it("S5.9.5 (D6) — reopen requires a reason, and stores it on every leg's REOPEN event", async () => {
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/reopen-comparison`)
    .set("Cookie", managerCookie).send({}).expect(400);
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/reopen-comparison`)
    .set("Cookie", managerCookie).send({ reason: "   " }).expect(400);

  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/reopen-comparison`)
    .set("Cookie", managerCookie).send({ reason: "Client pushed the dates" }).expect(201);
  const events = await prisma.awardDecisionEvent.findMany({ where: { queryId, type: "REOPEN" } });
  expect(events.length).toBe(legCount);
  expect(events.every((e) => e.reason === "Client pushed the dates")).toBe(true);
});
```

- [ ] **Step 2: Run and confirm failure** — the 403 expectation fails with 201; the two 400s fail with 201; `e.reason` is `null`.

- [ ] **Step 3: Add the schema to `@svyft/shared`**

In `packages/shared/src/award.ts`, beside `rejectSchema`:

```ts
/** S5.9.5 (D6) — reopening a client-quoted comparison is a consequential, auditable act (it
 *  supersedes an ISSUED quotation and discards a DRAFT one), so it collects a reason the same way
 *  a rejection does. Same shape as `rejectSchema` deliberately: one validation rule for "a
 *  required free-text reason", not two that can drift. */
export const reopenComparisonSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export type ReopenComparisonInput = z.infer<typeof reopenComparisonSchema>;
```

Then rebuild: `pnpm --filter @svyft/shared build`.

- [ ] **Step 4: Gate and validate the route**

```ts
// S5.9.5 (design D6) — Manager/Admin only. Reopening supersedes an ISSUED client quotation and
// deletes a DRAFT one (see `reopenComparison`), which is a checker-tier act, not a maker one; the
// route carried no @Roles at all before this, so an Executive could do it.
@Roles(Role.ADMINISTRATOR, Role.MANAGER)
@Post("reopen-comparison")
reopenComparison(
  @Param("id") id: string,
  @Body(new ZodValidationPipe(reopenComparisonSchema)) body: ReopenComparisonInput,
  @CurrentUser() user: RequestUser,
) {
  return this.award.reopenComparison(id, body, user);
}
```

- [ ] **Step 5: Store the reason**

In `reopenComparison`, take the input and pass it to the event it already writes per leg:

```ts
await tx.awardDecisionEvent.create({
  data: { legId: leg.id, queryId, type: "REOPEN", reason: input.reason, actorId: user.userId },
});
```

`AwardDecisionEvent.reason` already exists (`reject()` writes it) — no migration.

- [ ] **Step 6: Run, confirm green, then mutation-prove**

1. Remove `@Roles` → the 403 half reddens, the 201 half stays green. Revert.
2. Remove the `ZodValidationPipe` → both 400 halves redden, the 201 half stays green. Revert.
3. Drop `reason: input.reason` from the event write → the `every(...)` assertion reddens and the `events.length` assertion stays green. Revert.

- [ ] **Step 7: Full api gate + typecheck, then commit**

```bash
git add packages/shared/src/award.ts apps/api/src/modules/award/award.controller.ts apps/api/src/modules/award/award.service.ts apps/api/test/award-generate.e2e-spec.ts
git commit -m "feat(s5.9.5): reopen is Manager/Admin only and records a required reason (D6)"
```

---

## Task 7: The forwarder portal closes an approved leg

**Files:**
- Modify: `packages/shared/src/ff-portal.ts:57-73` (`FfPortalLegDto`)
- Modify: `apps/api/src/modules/ff-portal/ff-portal.service.ts:190-210` (DTO mapping), `:290-310` (submit guard)
- Modify: `apps/web/src/features/ff-portal/LegSection.tsx:171-185`
- Test: `apps/api/test/ff-portal.e2e-spec.ts`, `apps/web/src/features/ff-portal/LegSection.test.tsx`

**Interfaces:**
- Consumes: nothing from Tasks 1–6.
- Produces: `FfPortalLegDto.closedReason: string | null` — non-null exactly when the leg is closed to this forwarder. One value today: `LEG_APPROVED_REASON`.

- [ ] **Step 1: Read D5, including the two things it explicitly does NOT do**

`PENDING_APPROVAL` does **not** close the portal — only `APPROVED` does. And this closes the **leg**, never the RFQ: `Rfq` is unique on `(queryId, freightForwarderId)`, so one RFQ covers all of a forwarder's legs and a forwarder approved on LEG-1 must keep quoting LEG-2. Their reminder timers are per-RFQ and rightly keep running.

- [ ] **Step 2: Write the failing tests**

```ts
it("S5.9.5 (D5) — a forwarder cannot submit on a leg approved to someone else, and the leg says why", async () => {
  // leg has ffA (approved via the real checker flow) and ffB (still RFQ_SENT)
  const view = await request(app.getHttpServer()).get(`/api/ff/rfq/${ffBToken}`).expect(200);
  const closedLeg = view.body.legs.find((l: any) => l.legId === approvedLegId);
  expect(closedLeg.closedReason).toMatch(/approved/i);

  await request(app.getHttpServer())
    .post(`/api/ff/rfq/${ffBToken}/legs/${approvedLegId}/submit`)
    .send({ /* valid draft */, version: closedLeg.version })
    .expect(409);
});

it("S5.9.5 (D5) — a leg merely PENDING_APPROVAL stays open, and the forwarder's OTHER leg stays open too", async () => {
  // Positive control on both halves of the rule: neither PENDING_APPROVAL nor a sibling leg closes.
  const view = await request(app.getHttpServer()).get(`/api/ff/rfq/${ffBToken}`).expect(200);
  expect(view.body.legs.find((l: any) => l.legId === pendingLegId).closedReason).toBeNull();
  expect(view.body.legs.find((l: any) => l.legId === siblingLegId).closedReason).toBeNull();
  await request(app.getHttpServer())
    .post(`/api/ff/rfq/${ffBToken}/legs/${siblingLegId}/submit`)
    .send({ /* valid draft */, version: siblingVersion })
    .expect(201);
});
```

- [ ] **Step 3: Run and confirm failure** — `closedReason` is `undefined` and the submit returns 201.

- [ ] **Step 4: Add the DTO field**

In `packages/shared/src/ff-portal.ts`, on `FfPortalLegDto`:

```ts
  /** S5.9.5 (D5) — non-null when this leg is closed to this forwarder and why, in copy the
   *  forwarder may read. Today there is exactly one cause: another forwarder has been approved for
   *  the leg. Deliberately a REASON STRING rather than a new `QuoteStatus`: the product owner
   *  ruled against a "Cancelled" status, and the forwarder's own quote status is unchanged — it is
   *  the LEG that closed, not their quote. */
  closedReason: string | null;
```

Rebuild `@svyft/shared`.

- [ ] **Step 5: Populate it and enforce it**

In `ff-portal.service.ts`, resolve the leg's `LegAwardDecision` status alongside the existing per-leg load, export the copy string, set `closedReason` in the DTO mapping, and add the guard to `submit` — **after** the S5.9 D10 stale-page guard and **before** the quote-status guard, matching the ordering comment already there:

```ts
/** S5.9.5 (D5) — forwarder-facing copy, so vocabulary rule D5 applies with full force. The
 *  obvious phrasing here is "this leg has been awarded to another forwarder", and it is WRONG:
 *  nothing has been awarded, no forwarder has been notified, and the selection stays reversible
 *  until the client accepts. It also deliberately does not name who was selected — that is a
 *  competitor's commercial information, not this forwarder's to read. */
export const LEG_APPROVED_REASON =
  "This leg is no longer open for quoting — a forwarder has been selected.";
```

- [ ] **Step 6: Render it in the portal**

`LegSection.tsx` already branches at `:171` (`leg.status === "QUOTED"` → read-only) and `:179` (anything not `RFQ_SENT`/`REQUOTED` → read-only). Add a branch **above both** for `leg.closedReason != null`, rendering the reason. Do not remove the existing branches — a forwarder can be closed *and* have already quoted.

- [ ] **Step 7: Run both suites, confirm green, then mutation-prove**

1. Remove the submit guard → test 1's 409 reddens, test 2's 201 stays green. Revert.
2. Change the guard's condition from `APPROVED` to `APPROVED || PENDING_APPROVAL` → test 2's `pendingLeg` assertion reddens. Revert. **This is the mutation that pins the "PENDING_APPROVAL does not close it" decision.**
3. Make `closedReason` non-null for every leg → test 2's two `toBeNull()` assertions redden. Revert.

- [ ] **Step 8: Full gates + commit**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- --runInBand
pnpm --filter @svyft/web test
pnpm run typecheck
git add packages/shared/src/ff-portal.ts apps/api/src/modules/ff-portal apps/web/src/features/ff-portal apps/api/test/ff-portal.e2e-spec.ts
git commit -m "feat(s5.9.5): the forwarder portal closes a leg once a forwarder is approved (D5)"
```

---

## Task 8: The row model gains pending cells and an approved mark

**Files:**
- Modify: `apps/web/src/features/compare/comparisonRowModel.ts`
- Test: `apps/web/src/features/compare/comparisonRowModel.test.ts`

**Interfaces:**
- Consumes: Task 1's read model (an `APPROVED` offer now arrives in `leg.offers`).
- Produces, for Tasks 9 and 10:

```ts
export interface OfferCell {
  kind: "offer";
  key: string;              // offerKey(quoteId, variant)
  offer: OfferDto;
  recommended: boolean;
  sentForApproval: boolean;
  approved: boolean;        // NEW
  stale: boolean;
}
export interface PendingCell {
  kind: "pending";
  key: string;              // pendingKey(freightForwarderId)
  forwarder: PendingForwarderDto;
}
export type GridCell = OfferCell | PendingCell;

export function pendingKey(freightForwarderId: string): string;
export const APPROVED_MARK: string;
export const APPROVED_ACCESSIBLE_NAME: string;
export const APPROVED_FOOTNOTE: string;
export const APPROVED_TINT: string;
export const NOT_QUOTED_LABEL: string;
```

`ForwarderGroup.cells` and `ComparisonRowModel.cells` both become `GridCell[]`. `OfferCell` keeps its name so `METRICS[].render(c: OfferCell)` and `onOpenBreakdown(cell: OfferCell)` stay typed to real offers only — a pending cell can never reach either.

- [ ] **Step 1: Write the failing unit tests**

```ts
it("S5.9.5 — a pendingForwarder becomes its own group with one pending cell", () => {
  const model = buildComparisonRowModel(legWithOneOfferAndOnePending, false);
  expect(model.groups).toHaveLength(2);
  const pendingGroup = model.groups.find((g) => g.freightForwarderId === PENDING_FF_ID)!;
  expect(pendingGroup.cells).toHaveLength(1);
  expect(pendingGroup.cells[0]!.kind).toBe("pending");
  expect(model.cells.filter((c) => c.kind === "offer")).toHaveLength(1);
});

it("S5.9.5 — a forwarder that already has an offer never gains a second, pending group", () => {
  // Defensive: Task 1's server-side subtraction should make this impossible, but the model must
  // not double-render if a stale payload ever carries both.
  const model = buildComparisonRowModel(legWhereFfAppearsInBothLists, false);
  expect(model.groups.filter((g) => g.freightForwarderId === FF_ID)).toHaveLength(1);
});

it("S5.9.5 — the approved offer is marked, and the sent-for-approval flag is not", () => {
  const model = buildComparisonRowModel(legWithApprovedDecision, false);
  const cell = model.cells.find((c) => c.key === offerKey(WINNER_QUOTE, "FCL"))!;
  expect(cell.kind).toBe("offer");
  expect((cell as OfferCell).approved).toBe(true);
  expect((cell as OfferCell).sentForApproval).toBe(false);
});

it("S5.9.5 — approved and sentForApproval can never both be true", () => {
  // Positive control: the PENDING_APPROVAL fixture must produce the mirror image.
  const pending = buildComparisonRowModel(legWithPendingDecision, false);
  const cell = pending.cells.find((c) => c.key === offerKey(WINNER_QUOTE, "FCL"))! as OfferCell;
  expect(cell.sentForApproval).toBe(true);
  expect(cell.approved).toBe(false);
});

it("S5.9.5 — `locked` suppresses the star and the flag but NOT the approved mark", () => {
  const model = buildComparisonRowModel(legWithApprovedDecision, true);
  const cell = model.cells.find((c) => c.key === offerKey(WINNER_QUOTE, "FCL"))! as OfferCell;
  expect(cell.approved).toBe(true);
  expect(cell.recommended).toBe(false);
  expect(cell.sentForApproval).toBe(false);
  expect(model.recommendedKey).toBeNull();
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @svyft/web test -- src/features/compare/comparisonRowModel.test.ts
```

- [ ] **Step 3: Introduce the union**

Add `kind: "offer"` to the existing `OfferCell`, add `PendingCell`, `GridCell`, and `pendingKey`:

```ts
/** The pending cell's key. A separate namespace from `offerKey` on purpose — a pending forwarder
 *  has no quote id to key on, and the two must never collide in a `key` prop or a `data-testid`. */
export function pendingKey(freightForwarderId: string): string {
  return `pending::${freightForwarderId}`;
}
```

- [ ] **Step 4: Add the approved flag**

Alongside the existing `sentForApprovalKey` derivation:

```ts
// S5.9.5 (design D8) — the approved offer's own mark. Reads the DECISION, exactly like
// `sentForApprovalKey` above and for the same traced reason (see `OfferCell.sentForApproval`'s
// doc comment: `offer.quoteStatus` is a second-hand signal that has been observed to drift from
// the decision record). The two are mutually exclusive BY CONSTRUCTION — one requires
// `status === "PENDING_APPROVAL"`, the other `status === "APPROVED"` — so no precedence rule is
// needed and the product owner's "approved replaces the flag" falls out of the gate itself.
//
// `locked` deliberately does NOT suppress this one, unlike `recKey` and `sentForApprovalKey`.
// Those two are suppressed because they would CONTRADICT the frozen award panel below the grid
// (the live ranking re-ranks the losers; "currently under checker review" is false once frozen).
// The approved mark AGREES with that panel — it names the same winner the snapshot froze — so
// suppressing it would remove the one mark that is still true.
const approvedKey =
  leg.decision?.status === "APPROVED" && leg.decision.shortlistedQuoteId
    ? offerKey(leg.decision.shortlistedQuoteId, leg.decision.shortlistedVariant)
    : null;
```

Set `approved: approvedKey != null && key === approvedKey` on each offer cell, and add `kind: "offer"`.

- [ ] **Step 5: Append the pending groups**

After the `offers` loop, before the `return`:

```ts
// S5.9.5 (design D7) — every forwarder at RFQ_SENT and beyond belongs IN the table, not in a list
// below it. Appended after the offering forwarders rather than interleaved: the priced columns are
// what the Executive is comparing, and a run of empty ones between them would break that reading.
// The `existing` branch is defensive, not exercised: Task 1 subtracts any quote that produced an
// offer from `pendingForwarders`, so a forwarder cannot legitimately be in both lists. It is here
// so a stale or hand-built payload degrades to one group rather than rendering the forwarder twice.
for (const pf of leg.pendingForwarders) {
  const cell: PendingCell = { kind: "pending", key: pendingKey(pf.freightForwarderId), forwarder: pf };
  const existing = groups.find((g) => g.freightForwarderId === pf.freightForwarderId);
  if (existing) existing.cells.push(cell);
  else
    groups.push({
      freightForwarderId: pf.freightForwarderId,
      freightForwarderName: pf.freightForwarderName,
      cells: [cell],
    });
}
```

- [ ] **Step 6: Add the display constants**

```ts
/** S5.9.5 (D8) — the approved offer's mark. A checkmark, which `SENT_FOR_APPROVAL_MARK`'s own doc
 *  comment deliberately avoided precisely because "a checkmark reads as approved" — here that
 *  reading is the correct one. Its tint is the app's `primary`, distinct from the star's emerald,
 *  and the two can coexist on one cell (an offer can be both recommended and approved). */
export const APPROVED_MARK = "✔";
export const APPROVED_ACCESSIBLE_NAME = "Approved";
export const APPROVED_FOOTNOTE = "✔ Approved — the forwarder selected for this leg.";
export const APPROVED_TINT = "bg-primary/10";

/** S5.9.5 (D7) — what a forwarder who has not priced anything reads as in the grid. Deliberately
 *  NOT a status name: `ForwarderStatusBadge` in the same cell already gives the precise status
 *  (RFQ Sent / Expired / Invalid), and this is the variant slot, where every other cell names what
 *  was priced. */
export const NOT_QUOTED_LABEL = "Not quoted";
```

- [ ] **Step 7: Run, confirm green, then mutation-prove**

1. Delete the pending-groups loop → tests 1 reddens, test 3 stays green. Revert.
2. Change `approvedKey`'s gate from `"APPROVED"` to `"PENDING_APPROVAL"` → tests 3 and 4 both redden. Revert.
3. Add `!locked &&` to `approvedKey` → test 5's first assertion reddens and its other three stay green. Revert. **This is the mutation that pins the "locked does not suppress the approved mark" decision.**

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm --filter @svyft/web test -- src/features/compare/comparisonRowModel.test.ts
pnpm run typecheck
git add apps/web/src/features/compare/comparisonRowModel.ts apps/web/src/features/compare/comparisonRowModel.test.ts
git commit -m "feat(s5.9.5): row model gains pending cells and the approved mark (D7/D8)"
```

Note: `pnpm run typecheck` **will fail** at this step, in `ComparisonGrid.tsx` / `ComparisonGridColumns.tsx` / `ComparisonGridRows.tsx`, because `GridCell` is a union those files do not yet narrow. That is expected and is exactly the compile error the union exists to produce. Commit the model anyway and fix the three renderers in Task 9 — but say so explicitly in the task report so the reviewer does not read it as a broken gate.

---

## Task 9: Both grid orientations render pending cells and the approved mark; the list below goes

**Files:**
- Create: `apps/web/src/features/compare/OfferMarks.tsx`
- Modify: `apps/web/src/features/compare/ComparisonGridColumns.tsx`, `ComparisonGridRows.tsx`, `ComparisonGrid.tsx`
- Test: `apps/web/src/features/compare/ComparisonGrid.test.tsx`

**Interfaces:**
- Consumes: Task 8's `GridCell`, `pendingKey`, `APPROVED_*`, `NOT_QUOTED_LABEL`.
- Produces: `data-testid` contract for Task 10's tests — `offer-approved-<key>` on the mark, `pending-cell-<pendingKey>` on a pending cell's variant slot. The `pending-forwarders` testid **is deleted**.

- [ ] **Step 1: Write the failing component tests**

```ts
it("S5.9.5 (D7) — a forwarder who never quoted renders IN the table, not in a list below it", () => {
  render(<ComparisonGrid leg={legWithOnePending} />);
  expect(screen.getByTestId(`pending-cell-${pendingKey(PENDING_FF_ID)}`)).toHaveTextContent("Not quoted");
  expect(screen.getByText(PENDING_FF_NAME)).toBeInTheDocument();
  // The old list is gone — and this assertion has a positive control below, so it cannot pass by
  // the whole grid failing to render.
  expect(screen.queryByTestId("pending-forwarders")).not.toBeInTheDocument();
  expect(screen.getByTestId("comparison-grid")).toBeInTheDocument();
});

it("S5.9.5 (D8) — the approved offer carries its mark and its footnote, in BOTH orientations", () => {
  for (const viewMode of ["columns", "rows"] as const) {
    const { unmount } = render(<ComparisonGrid leg={legWithApprovedDecision} viewMode={viewMode} />);
    expect(screen.getByTestId(`offer-approved-${offerKey(WINNER_QUOTE, "FCL")}`)).toBeInTheDocument();
    expect(screen.getByTestId("comparison-footnote")).toHaveTextContent(APPROVED_FOOTNOTE);
    unmount();
  }
});

it("S5.9.5 — a pending cell has no charge-breakdown affordance", () => {
  render(<ComparisonGrid leg={legWithOnePending} onSelectOffer={spy} />);
  expect(screen.queryByTestId(`offer-header-${pendingKey(PENDING_FF_ID)}`)).not.toBeInTheDocument();
  // Positive control: the priced offer in the same fixture DOES have one.
  expect(screen.getByTestId(`offer-header-${offerKey(PRICED_QUOTE, "FCL")}`)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Extract `OfferMarks`**

The ★ and ⚑ blocks are currently duplicated **four** times — the priced and unpriced branches of `ComparisonGridColumns`, and the same pair in `ComparisonGridRows`. This task adds a third mark to all four. Extract first, then add.

```tsx
import { cn } from "@/lib/utils";
import {
  RECOMMENDED_MARK,
  SENT_FOR_APPROVAL_MARK,
  SENT_FOR_APPROVAL_ACCESSIBLE_NAME,
  APPROVED_MARK,
  APPROVED_ACCESSIBLE_NAME,
  type OfferCell,
} from "./comparisonRowModel";

export interface OfferMarksProps {
  cell: OfferCell;
  /** `ComparisonRowModel.recommendedReason` — the `★`'s accessible name. Never
   *  `leg.recommendation.reason` directly: once a decision snapshot is in play the live reason may
   *  no longer describe the offer this mark points at (see `buildComparisonRowModel`'s doc). */
  recommendedReason: string | null;
}

/**
 * OfferMarks — the ★ / ⚑ / ✔ cluster that sits beside an offer's variant label.
 *
 * Extracted in S5.9.5 from four byte-identical copies (the priced and unpriced branches of both
 * `ComparisonGridColumns` and `ComparisonGridRows`). Behaviour is unchanged for the two existing
 * marks; `approved` is the new one. `recommended` and `approved` CAN coexist — the engine's
 * opinion and the checker's decision are independent — while `sentForApproval` and `approved`
 * cannot, by construction in the model.
 */
export function OfferMarks({ cell, recommendedReason }: OfferMarksProps) {
  return (
    <>
      {cell.recommended && recommendedReason && (
        <span
          data-testid={`offer-recommended-${cell.key}`}
          aria-label={`Recommended — ${recommendedReason}`}
          title={recommendedReason}
          className="ml-1 text-emerald-600"
        >
          {RECOMMENDED_MARK}
        </span>
      )}
      {cell.sentForApproval && (
        <span
          data-testid={`offer-sent-for-approval-${cell.key}`}
          aria-label={SENT_FOR_APPROVAL_ACCESSIBLE_NAME}
          title={SENT_FOR_APPROVAL_ACCESSIBLE_NAME}
          className="ml-1 text-primary"
        >
          {SENT_FOR_APPROVAL_MARK}
        </span>
      )}
      {cell.approved && (
        <span
          data-testid={`offer-approved-${cell.key}`}
          aria-label={APPROVED_ACCESSIBLE_NAME}
          title={APPROVED_ACCESSIBLE_NAME}
          className="ml-1 text-primary"
        >
          {APPROVED_MARK}
        </span>
      )}
    </>
  );
}
```

Replace all four inline copies with `<OfferMarks cell={cell} recommendedReason={model.recommendedReason} />`. Delete the now-unused mark imports from both grid files. **Run the existing `ComparisonGrid.test.tsx` before adding anything else** — this refactor alone must leave the whole suite green, which is the proof it was behaviour-preserving.

- [ ] **Step 4: Narrow the union in `ComparisonGridColumns`**

Every place that reads `cell.offer` needs the narrow. In the header row, in the metric rows, and in the Status row:

```tsx
{cells.map((cell) =>
  cell.kind === "pending" ? (
    <TableHead
      key={cell.key}
      className={cn("h-auto px-2 py-1.5 align-bottom", METRIC_ALIGN.columns)}
    >
      <div data-testid={`pending-cell-${cell.key}`} className="w-full px-1 py-0.5">
        <span className="block text-xs font-medium text-muted-foreground">{NOT_QUOTED_LABEL}</span>
      </div>
    </TableHead>
  ) : (
    /* the existing priced/unpriced offer header, now using <OfferMarks /> */
  ),
)}
```

In the metric rows, a pending cell renders an em-dash rather than calling `metric.render` — `METRICS` is typed against `OfferCell` and a pending cell has no offer to measure:

```tsx
{cell.kind === "pending" ? "—" : metric.render(cell)}
```

In the Status row, a pending cell's badge reads its own `forwarder.quoteStatus`:

```tsx
<ForwarderStatusBadge
  status={cell.kind === "pending" ? cell.forwarder.quoteStatus : cell.offer.quoteStatus}
/>
```

Apply `APPROVED_TINT` wherever `RECOMMENDED_TINT` is currently applied, listed **after** it so `cn`'s tailwind-merge resolves an offer that is both in favour of the approval — the decision outranks the engine's opinion.

- [ ] **Step 5: Narrow the union in `ComparisonGridRows`**

Same three places, same rules. A pending cell is one `<TableRow>` inside its forwarder's group: the variant cell reads `NOT_QUOTED_LABEL` with no button, each metric cell an em-dash, the status cell the forwarder's own badge.

- [ ] **Step 6: Delete the list and add the third footnote in `ComparisonGrid.tsx`**

Delete the whole `leg.pendingForwarders.length > 0` block (`:120-137`) **and** the `ForwarderStatusBadge` import it was the only user of. Keep the `leg.awaitingReQuote` warning — it is a different thing and D7 does not touch it, so its wrapper condition narrows to `leg.awaitingReQuote` alone.

Add the third footnote half beside the two existing ones:

```tsx
const hasApprovedCell = model.cells.some((c) => c.kind === "offer" && c.approved);
const footnote = [
  hasRecommendedCell && RECOMMENDED_FOOTNOTE,
  hasSentForApprovalCell && SENT_FOR_APPROVAL_FOOTNOTE,
  hasApprovedCell && APPROVED_FOOTNOTE,
]
  .filter((x): x is string => Boolean(x))
  .join("  ");
```

Both existing `some(...)` calls need the `c.kind === "offer"` narrow too.

`model.groups.length === 0` still drives the "No comparable quotes yet." empty state — but it now means "no forwarders at all on this leg", not "nobody has priced". Update that copy to **"No forwarders on this leg yet."** and say so in the task report; the old string would be actively wrong for a leg where three forwarders were sent an RFQ and none replied.

- [ ] **Step 7: Run, confirm green, then mutation-prove**

1. Delete the `pending-cell` branch from `ComparisonGridColumns` → test 1 reddens. Revert.
2. Restore the deleted `pending-forwarders` block → test 1's `queryByTestId(...).not.toBeInTheDocument()` reddens, and its `getByTestId("comparison-grid")` control stays green. Revert.
3. Remove `cell.approved &&` from `OfferMarks` so the mark always renders → test 2 stays green (wrong direction), so **also** assert in test 3's fixture that a non-approved offer has no `offer-approved-*` testid, and re-run this mutation until it reddens. An absence assertion with no positive control is the exact failure this project has hit six times.

- [ ] **Step 8: Full web gate + typecheck, then commit**

```bash
pnpm --filter @svyft/web test
pnpm run typecheck
git add apps/web/src/features/compare
git commit -m "feat(s5.9.5): the grid shows every forwarder and marks the approved offer (D7/D8)"
```

---

## Task 10: The action bar freezes an approved leg, and Reopen collects a reason

**Files:**
- Create: `apps/web/src/features/compare/ReopenDialog.tsx`
- Modify: `apps/web/src/features/compare/CompareLegPanel.tsx`, `QuotingClientPanel.tsx`, `useAwardActions.ts`, `NegotiateDialog.tsx`
- Test: `apps/web/src/features/compare/ComparisonGrid.test.tsx` (the `CompareLegPanel` describe block), `QuotingClientPanel.test.tsx`, `NegotiateDialog.test.tsx`

**Interfaces:**
- Consumes: Task 3's reject-an-approval route, Task 6's `reopenComparisonSchema`/`ReopenComparisonInput`, Task 8's `approved` flag.
- Produces: nothing downstream — this is the last task.

- [ ] **Step 1: Write the failing tests**

```ts
it("S5.9.5 (D1) — on an APPROVED leg every control is disabled with a reason, except Reject for a checker", async () => {
  renderPanel({ leg: legWithApprovedDecision, role: Role.EXECUTIVE });
  const send = screen.getByRole("button", { name: /send for approval/i });
  expect(send).toBeDisabled();
  expect(screen.getByRole("button", { name: /negotiate/i })).toBeDisabled();
  expect(screen.getByTestId("leg-action-bar")).toHaveTextContent(/approved/i);

  // An Executive still has NO Reject — that is a ROLE rule, so it hides rather than disables.
  expect(screen.queryByRole("button", { name: /^reject$/i })).not.toBeInTheDocument();
});

it("S5.9.5 (D1/D2) — a Manager on an APPROVED leg gets an enabled Reject and nothing else enabled", async () => {
  renderPanel({ leg: legWithApprovedDecision, role: Role.MANAGER });
  expect(screen.getByRole("button", { name: /^reject$/i })).toBeEnabled();
  expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
  // Negotiate is checker-hidden (S5.9.1 R3, unchanged by this sub-build).
  expect(screen.queryByRole("button", { name: /negotiate/i })).not.toBeInTheDocument();
});

it("S5.9.5 (D1) — the same controls are ENABLED on a leg whose decision is still DRAFT", async () => {
  // The positive control for both tests above. Without it, a bug that disables everything
  // unconditionally passes them.
  renderPanel({ leg: legWithDraftDecision, role: Role.EXECUTIVE });
  expect(screen.getByRole("button", { name: /send for approval/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /negotiate/i })).toBeEnabled();
});

it("S5.9.5 (D6) — a locked leg shows no action bar at all", async () => {
  renderPanel({ leg: legWithApprovedDecision, role: Role.MANAGER, locked: true });
  expect(screen.queryByTestId("leg-action-bar")).not.toBeInTheDocument();
  // Positive control: the grid is still there, so this did not pass by rendering nothing.
  expect(screen.getByTestId("comparison-grid")).toBeInTheDocument();
});

it("S5.9.5 (D6) — Reopen collects a required reason and posts it", async () => {
  renderQuotingClientPanel();
  await userEvent.click(screen.getByRole("button", { name: /reopen comparison/i }));
  await userEvent.click(screen.getByRole("button", { name: /^reopen$/i }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();   // required-field error
  expect(postSpy).not.toHaveBeenCalled();

  await userEvent.type(screen.getByLabelText(/reason/i), "Client pushed the dates");
  await userEvent.click(screen.getByRole("button", { name: /^reopen$/i }));
  expect(postSpy).toHaveBeenCalledWith(
    `/api/queries/${QUERY_ID}/reopen-comparison`,
    { reason: "Client pushed the dates" },
  );
});
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Rework the predicates in `CompareLegPanel`**

Replace the `canSend` / `canCheck` block. Keep every existing comment that is still true; rewrite the ones that are not.

```tsx
const decisionStatus = leg.decision?.status;
const isApproved = decisionStatus === "APPROVED";
const isPendingApproval = decisionStatus === "PENDING_APPROVAL";

// S5.9.5 (design D1) — "visible but disabled with a reason" applies to STATE rules only. ROLE
// rules keep hiding, as they always have: an Executive has never had Reject, a checker has never
// had Negotiate, and a checker has no Send on a leg no exec ever sent (S5.9.2 Q6). A disabled
// control must be one THIS viewer could use in some other state — never one their role can never
// reach, which would be a permanently greyed button that never means anything.
const sendHidden = locked || (isChecker && leg.decision == null);
const sendDisabledReason = isApproved
  ? "This leg is approved — a checker must reject it before it can be sent again."
  : isPendingApproval
    ? "This leg is already with a checker."
    : null;
// Gates the DIALOG's mount and the reset effect below — NOT the button's presence. A disabled
// button must not be able to open a dialog, so these two conditions are deliberately different.
const canSend = !sendHidden && sendDisabledReason == null;

// S5.9.5 (D2) — Reject is now the ONE action that survives an approval, and the only way back.
const canReject = isChecker && !locked && (isPendingApproval || isApproved);
// Approve is unchanged: it only ever exists at PENDING_APPROVAL. A reopened leg's decision is
// APPROVED, so Approve is already unavailable there and needed no work for D2's flow.
const canApprove = isChecker && !locked && isPendingApproval;

// S5.9.5 (D1) — Negotiate is refused on an approved leg too, not just a pending one. This
// REVERSES an earlier ruling in the same product round ("Negotiate should be allowed with all the
// quoted options" on an approved leg), which was confirmed once and then overturned after a
// business discussion. Do not restore it as a bug fix; see the design's D1.
const negotiateDisabledReason = isApproved
  ? "This leg is approved — it must be rejected before it can be re-negotiated."
  : isPendingApproval
    ? "A checker must reject this leg before it can be re-negotiated."
    : null;
```

`isSelf` keeps gating Approve only. It must **not** gate Reject any more: D2 rules that the manager who approved may reject it back, so a four-eyes disable here would contradict the server, which now allows it. Split the existing shared `disabled={isSelf}` accordingly and update the visible hint so it names Approve rather than "another manager must decide".

- [ ] **Step 4: Rework the bar's JSX**

- `hasActionBarControls` becomes `!isChecker || canApprove || canReject || !sendHidden`.
- The Send button renders whenever `!sendHidden`, with `disabled={sendDisabledReason != null}` and the reason text beside it.
- The Negotiate button keeps its `!isChecker` gate and takes `disabled={negotiateDisabledReason != null}`.
- Reject's gate moves from `canCheck` to `canReject`; Approve's to `canApprove`.
- `SendForApprovalDialog` stays gated on `canSend`; `ApproveDialog` on `canApprove`; `RejectDialog` on `canReject`; `NegotiateDialog` on `!locked && !isChecker && negotiateDisabledReason == null`.
- Both reset effects follow: `useEffect(() => { if (!canApprove) setApproveOpen(false); if (!canReject) setRejectOpen(false); }, [canApprove, canReject])` and the existing `canSend` one is unchanged.

- [ ] **Step 5: Update `NegotiateDialog`'s eligibility to match the server exactly**

`buildCandidates` currently treats `QUOTED` and `APPROVED` as quotable. After Task 2 the server's `REQUOTABLE_STATUSES` is `QUOTED | APPROVED | EXPIRED`, and after D1 the dialog cannot even open on an approved leg. Bring the two into line:

```ts
// Mirrors negotiation.service.ts's REQUOTABLE_STATUSES exactly (S5.9.5 D4). EXPIRED is new: after
// D4 an expired quote can still carry the forwarder's real submitted price, and re-negotiating is
// the deliberate act that reopens their portal with a fresh deadline. APPROVED stays listed
// because the SERVER still accepts it — but D1 means this dialog can no longer be opened on an
// approved leg, so it is unreachable from here. Kept rather than deleted so the two lists stay
// readable side by side; do not "clean it up" without checking the server first.
const quotable =
  offer.quoteStatus === "QUOTED" ||
  offer.quoteStatus === "APPROVED" ||
  offer.quoteStatus === "EXPIRED";
```

The `ineligibleReason` chain also needs an `EXPIRED` arm removed — an expired offer is now eligible, so the fallback "Already awaiting a revised quote." must no longer be reachable for it.

- [ ] **Step 6: Build `ReopenDialog` and wire it up**

`ReopenDialog.tsx` mirrors `RejectDialog.tsx` exactly — `react-hook-form` + `zodResolver(reopenComparisonSchema)`, a required `reason` textarea, an inline `role="alert"` field error, the same in-flight close guard. Its copy must state the consequence, the way `RejectDialog`'s does: reopening supersedes an issued client quotation and discards a draft one.

`useReopenComparison` takes a body:

```ts
export function useReopenComparison(queryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReopenComparisonInput) =>
      postJson(`/api/queries/${queryId}/reopen-comparison`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comparison", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
    },
  });
}
```

`QuotingClientPanel`'s button opens the dialog instead of calling `reopen.mutate()` directly. Its doc comment currently says "resolution #3 — no confirmation dialog"; that is now false and must be rewritten, not left.

- [ ] **Step 7: Run, confirm green, then mutation-prove**

1. Remove the `isApproved` arm from `sendDisabledReason` → test 1's `toBeDisabled()` reddens, test 3 stays green. Revert.
2. Change `canReject` back to `isChecker && !locked && isPendingApproval` → test 2's `toBeEnabled()` reddens. Revert.
3. Add `disabled={isSelf}` back onto Reject with a same-user fixture → test 2 reddens. Revert.
4. Remove `zodResolver` from `ReopenDialog` → test 5's first half (the `role="alert"` and `not.toHaveBeenCalled()`) reddens and its second half stays green. Revert.

- [ ] **Step 8: Full gates and commit**

```bash
pnpm --filter @svyft/web test
pnpm run typecheck
git add apps/web/src/features/compare
git commit -m "feat(s5.9.5): an approved leg is frozen except Reject; reopen collects a reason (D1/D2/D6)"
```

---

## Final gate (not a task — run after Task 10)

- [ ] **Full CI**

```bash
set -a; . apps/api/.env; set +a
pnpm run ci
```

Green, or every failure explained. A failure in the register-C5 list (`award-generate`, `ff-portal-v3`, `charge-catalogue`, `emails`, `ff-portal-stale-submit`) must be re-run in isolation and **reported, never fixed**.

- [ ] **Opus whole-branch review**

Not a task-scoped review — the whole branch. This pass has found a real defect on **every single** Stage-5 sub-build that all the task-scoped reviews had passed. Do not skip it. Direct it especially at:

- The five comments Task 1 Step 1 re-traced. Are the new claims true, or merely different?
- Every inverted absence assertion in this plan. Was each one mutation-proven, with output?
- Task 5's endpoint inventory. Is there a query-scoped write with no lock and no stated exception?
- Task 3's `requireRejectable`. Can a `DRAFT` decision reach either reversal fire?
- Task 9's `OfferMarks` extraction. Did the refactor change any rendered output?

- [ ] **Update the Stage 5 handoff**

`docs/Stage 5 - Session Handoff.md`: add the S5.9.5 row to the sub-build table, close **A3** and **A4** in the register, amend **C4** (`EXPIRED` is now comparable and rankable; `AWAITING_CLIENT_DECISION` now gates writes), and record under Decisions the two reversals — D1 overturning "Negotiate allowed on an approved leg", and D2 replacing "reopen resets statuses". **C8 stays open and untouched.**

---

## Self-review

**Spec coverage.** D1 → Task 10. D2 → Task 3 (server) + Task 10 (UI). D3 → Task 4. D4 → Task 2 + Task 1 (comparable/rankable). D5 → Task 7. D6 → Task 5 (lock) + Task 6 (roles/reason) + Task 10 (dialog). D7 → Task 8 + Task 9. D8 → Task 1 + Task 8 + Task 9. The "no new statuses" section → Global Constraints (no migration) + Tasks 2 and 3, which add edges only. No design section is unimplemented.

**Type consistency.** `OfferCell` keeps its name and gains `kind: "offer"` and `approved`; `GridCell = OfferCell | PendingCell` is what `ForwarderGroup.cells` and `ComparisonRowModel.cells` hold; `METRICS[].render` and `onOpenBreakdown` stay typed to `OfferCell`, so a pending cell cannot reach either. `pendingKey` is used in Tasks 8, 9 and 10 under that one name. `QueryLockService.assertUnlocked` and `QUERY_LOCKED_MESSAGE` are named identically in Task 5's interface block, its service code and its test. `reopenComparisonSchema`/`ReopenComparisonInput` are named identically in Task 6 (shared, controller) and Task 10 (`ReopenDialog`, `useReopenComparison`).

**Copy trap flagged rather than left to chance.** Task 7's `LEG_APPROVED_REASON` is the one new forwarder-facing string in this plan, and the phrasing an implementer would naturally reach for ("awarded to another forwarder") violates vocabulary rule D5 — which the handoff records as already having been violated twice. The constant carries a doc comment naming the wrong version explicitly, so the trap is visible at the point of editing rather than only in a review.
