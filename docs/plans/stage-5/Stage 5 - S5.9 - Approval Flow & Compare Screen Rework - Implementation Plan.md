# Stage 5 · S5.9 — Approval Flow Statuses & Compare-Screen Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Design of record: [`docs/Stage 5 - Approval Flow & Compare Screen Rework - Design.md`](../../Stage%205%20-%20Approval%20Flow%20%26%20Compare%20Screen%20Rework%20-%20Design.md). Parent designs: `docs/Stage 5 - Compare Quotes - Design.md`, `docs/Stage 5 - Compare Quotes UI Enhancements - Design.md`.

**Goal:** Make the approval flow visible in leg and quote status, fix the shipped defect that prevents a forwarder from answering a re-quote, and rework the Compare Quotes screen into a grid with its actions below it.

**Architecture:** Two new status values (`LegStatus.PENDING_APPROVAL`, `QuoteStatus.PENDING_APPROVAL`) are declared in `@svyft/shared` and contributed as machine edges by `AwardModule`; one pure rollup function in `@svyft/shared` becomes the single rule for "what should this leg's status be", shared by the projector and by reject. Selection and send collapse into one transactional endpoint that names its offer. The forwarder's portal token stops rotating, so their bookmark keeps working.

**Tech Stack:** pnpm monorepo — NestJS + Prisma/Postgres (`apps/api`), React 18 + Vite + TanStack Query v5 + RHF + Zod + shadcn/Radix (`apps/web`), pure TS + Zod (`packages/shared`). Tests: jest e2e (api), vitest (web, shared).

## Global Constraints

- **Vocabulary (D5, binding).** User-visible strings: **Approved**, **Quotation**, **Issue**, **Quoting client**, **Pending approval**. Never "Awarded", never "Won". Internal `award*` identifiers keep their names. Forwarder-facing status for both `PENDING_APPROVAL` and `APPROVED` is **"Under review"** — never the real label.
- **Every owned status change goes through `StatusService.fire`.** Never write `leg.status` or `quote.status` with a bare Prisma update. Query status is a projection — never `fire`d.
- **`findTransition` returns the FIRST `(from, on)` match.** One event therefore cannot have two targets. This is why reject uses two distinct events (`RETURN_FULL` / `RETURN_PARTIAL`) rather than one `RETURN`.
- **Rebuild `@svyft/shared` after editing it:** `pnpm --filter @svyft/shared build`. api runtime, web build and web vitest all resolve it through `node_modules` → `dist/`. Stale `dist` = consumers silently see old code.
- **vitest and jest do NOT type-check.** Run `pnpm run typecheck` at the end of every task. A green suite can hide type errors.
- **API e2e needs a real Postgres.** Container `svyft-postgres-task4` on **:5433**. Before running: `set -a; . apps/api/.env; set +a`. Run with `--runInBand`.
- **New `@OnEvent` listeners MUST `try/catch` + log** — `fire()` awaits `emitAsync`, so a throwing listener fails the caller.
- **Clear a `Json?` column with `Prisma.DbNull`**, never plain `null` (which writes JSON-null and reads back truthy).
- **No toast system.** Surface `ApiError` inline: `<p role="alert" className="text-sm text-destructive">{message}</p>`, via the existing `errorMessage(error, fallback)` in `apps/web/src/features/compare/errorMessage.ts`.
- **After a mutation** invalidate `["comparison", queryId]` (+ `["query", queryId]` where query status changes). No optimistic writes.
- **RBAC unchanged.** Workflow writes are auth-only (no `@Roles`); Approve/Reject stay Manager+ with four-eyes; Generate stays Manager+ with **no** four-eyes (O4).
- **Async-auth test trap (web):** `renderWithProviders`' `/api/auth/me` stub resolves asynchronously. Any assertion made synchronously after `render()` fires while `user` is `null` and proves nothing. Await a positive control first — see the `AuthProbe` pattern in `CheckerPanel.test.tsx:85-92`. **Every absence assertion must be mutation-proven** (break the condition → red → revert → green) and the evidence reported.
- **Migration trap (register C3).** Five earlier migrations hand-wrote `DEFAULT gen_random_uuid()` in raw SQL while `schema.prisma` uses `@default(uuid())`. Every `migrate dev` therefore proposes ~10 unrelated `ALTER COLUMN "id" DROP DEFAULT` statements. **Delete those lines from the generated migration before committing.** Keep only the statements this task intends.
- Commit per task. **Verify `git branch --show-current` before every commit** — HEAD is known to drift to `main` mid-session. Expected branch: `feat/stage-5-fx-master`.

---

## File Structure

### `packages/shared/src`

| File | Responsibility | Task |
| :-- | :-- | :-- |
| `status.ts` *(modify)* | Adds both `PENDING_APPROVAL` values, four new events, the shifted `LEG_RANK`, the `deriveQueryStatus` case, and the new pure `rollupLegTarget()`. | 1 |
| `status.test.ts` *(modify)* | Rollup + derive coverage. | 1 |
| `award.ts` *(modify)* | `sendForApprovalSchema` gains the offer identity; `shortlistSchema` retired. | 3 |
| `ff-portal.ts` *(modify)* | `FfPortalLegDto.version`; `submitQuoteSchema`. | 7 |

### `apps/api/src`

| File | Responsibility | Task |
| :-- | :-- | :-- |
| `modules/award/award.module.ts` *(modify)* | Contributes every new leg + quote edge. | 2 |
| `modules/rfq/leg-quote.projector.ts` *(modify)* | Delegates to `rollupLegTarget`; skips legs under review. | 2 |
| `modules/comparison/comparison.service.ts` *(modify)* | `COMPARABLE_STATUSES` admits `PENDING_APPROVAL`. | 2 |
| `modules/changes/scope.resolver.ts` *(modify)* | Active-quote list admits `PENDING_APPROVAL`. | 2 |
| `modules/award/award.service.ts` *(modify)* | Merged `sendForApproval`; rewritten `approve`/`reject`. | 3, 4 |
| `modules/award/award.controller.ts` *(modify)* | `PUT …/shortlist` retired. | 3 |
| `modules/award/negotiation.service.ts` *(modify)* | B1 guard; no token rotation; link from stored token. | 5 |
| `modules/rfq/rfq.service.ts` *(modify)* | Persists the raw token at every mint. | 5 |
| `modules/ff-portal/ff-portal.service.ts` *(modify)* | Emits `version`; guards submit on it. | 7 |
| `modules/ff-portal/ff-portal.controller.ts` *(modify)* | Submit accepts a body. | 7 |
| `prisma/schema.prisma` *(modify, repo root)* | Two enum values + `Rfq.accessToken`. | 1, 5 |

### `apps/web/src/features`

| File | Responsibility | Task |
| :-- | :-- | :-- |
| `ff-portal/LegSection.tsx` *(modify)* | `REQUOTED` reaches the editable form; "Under review" labels. | 6 |
| `ff-portal/portalClient.ts` *(modify)* | Submit sends `version`. | 7 |
| `compare/comparisonRowModel.ts` *(modify)* | Metric order; `★` marker helper. | 8 |
| `compare/ComparisonGridRows.tsx` *(modify)* | Forwarder band row; Forwarder column dropped; Shortlist column dropped. | 8, 9 |
| `compare/ComparisonGridColumns.tsx` *(modify)* | `★` in the variant header; Shortlist row dropped. | 8, 9 |
| `compare/SendForApprovalDialog.tsx` *(create)* | Lists every priced offer; single-select; reason rules; one call. | 9 |
| `compare/ShortlistDialog.tsx` *(delete)* | Replaced. | 9 |
| `compare/ShortlistSelectCell.tsx` *(delete)* | Replaced. | 9 |
| `compare/CompareLegPanel.tsx` *(modify)* | Actions below the grid; tooltips replace the messages. | 9, 10 |
| `compare/MakerPanel.tsx` *(modify)* | Keeps only the rejection alert. | 10 |
| `compare/NegotiateDialog.tsx` *(modify)* | Eligibility admits `PENDING_APPROVAL`. | 2 |
| `compare/useAwardActions.ts` *(modify)* | `useShortlist` removed; `useSendForApproval` takes the offer. | 9 |

---

## Task 1: Status vocabulary + rollup rule

**Files:**
- Modify: `packages/shared/src/status.ts`
- Modify: `packages/shared/src/status.test.ts`
- Modify: `prisma/schema.prisma:596-618`
- Create: `prisma/migrations/<timestamp>_s59_pending_approval/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LegStatus.PENDING_APPROVAL: "PENDING_APPROVAL"`, `QuoteStatus.PENDING_APPROVAL: "PENDING_APPROVAL"`
  - `LegEvent.SEND_FOR_APPROVAL = "send_for_approval"`, `LegEvent.RETURN_FULL = "return.full"`, `LegEvent.RETURN_PARTIAL = "return.partial"`
  - `QuoteEvent.SEND_FOR_APPROVAL = "send_for_approval"`, `QuoteEvent.RETURN = "return"`
  - `rollupLegTarget(quoteStatuses: QuoteStatus[]): LegStatus | null` — returns `FULLY_QUOTED`, `PARTIALLY_QUOTED`, or `null` (nothing distributed / nothing to say)

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/status.test.ts`:

```ts
describe("S5.9 — pending-approval rollup", () => {
  it("rolls a pending-approval leg up to QUOTED at query level", () => {
    expect(deriveQueryStatus([LegStatus.PENDING_APPROVAL])).toBe(QueryStatus.QUOTED);
  });

  it("still lets the least-advanced leg win", () => {
    expect(deriveQueryStatus([LegStatus.PENDING_APPROVAL, LegStatus.RFQ_SENT])).toBe(
      QueryStatus.RFQ_SENT,
    );
  });

  it("counts a PENDING_APPROVAL quote as resolved, so the leg reads fully quoted", () => {
    expect(rollupLegTarget([QuoteStatus.PENDING_APPROVAL, QuoteStatus.EXPIRED])).toBe(
      LegStatus.FULLY_QUOTED,
    );
  });

  it("reads partially quoted while one forwarder is still outstanding", () => {
    expect(rollupLegTarget([QuoteStatus.QUOTED, QuoteStatus.RFQ_SENT])).toBe(
      LegStatus.PARTIALLY_QUOTED,
    );
  });

  it("ignores undistributed SELECT quotes entirely", () => {
    expect(rollupLegTarget([QuoteStatus.SELECT])).toBeNull();
    expect(rollupLegTarget([QuoteStatus.QUOTED, QuoteStatus.SELECT])).toBe(
      LegStatus.FULLY_QUOTED,
    );
  });

  it("says nothing when every distributed quote is still outstanding", () => {
    expect(rollupLegTarget([QuoteStatus.RFQ_SENT])).toBeNull();
  });

  it("does NOT count an in-flight re-quote as resolved", () => {
    expect(rollupLegTarget([QuoteStatus.QUOTED, QuoteStatus.REQUOTED])).toBe(
      LegStatus.PARTIALLY_QUOTED,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @svyft/shared test -- src/status.test.ts
```

Expected: FAIL — `rollupLegTarget is not a function`, and `LegStatus.PENDING_APPROVAL` is `undefined`.

- [ ] **Step 3: Add the vocabulary in `packages/shared/src/status.ts`**

Insert `PENDING_APPROVAL` into `LegStatus` between `FULLY_QUOTED` and `APPROVED`, and into `QuoteStatus` after `REQUOTED`:

```ts
export const LegStatus = {
  DRAFT: "DRAFT",
  READY_FOR_RFQ: "READY_FOR_RFQ",
  RFQ_SENT: "RFQ_SENT",
  PARTIALLY_QUOTED: "PARTIALLY_QUOTED",
  FULLY_QUOTED: "FULLY_QUOTED",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  AWARDED: "AWARDED",
  IN_TRANSIT: "IN_TRANSIT",
  DELIVERED: "DELIVERED",
  CLOSED: "CLOSED",
} as const;
```

Add the events. **`RETURN` is split in two on purpose** — `findTransition` returns the first `(from, on)` match, so a single event cannot resolve to two different targets:

```ts
export const LegEvent = {
  VALIDATE_PASS: "validate.pass",
  REOPEN: "reopen",
  SEND_RFQ: "rfq.send",
  QUOTE_PARTIAL: "quote.partial",
  QUOTE_FULL: "quote.full",
  SEND_FOR_APPROVAL: "send_for_approval",
  APPROVE: "approve",
  RETURN_FULL: "return.full",
  RETURN_PARTIAL: "return.partial",
  REOPEN_AWARD: "reopen_award",
} as const;
```

```ts
export const QuoteStatus = {
  SELECT: "SELECT",
  RFQ_SENT: "RFQ_SENT",
  QUOTED: "QUOTED",
  EXPIRED: "EXPIRED",
  INVALID: "INVALID",
  REQUOTED: "REQUOTED",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  CLOSED: "CLOSED",
  APPROVED: "APPROVED",
} as const;

export const QuoteEvent = {
  SEND: "send",
  SUBMIT: "submit",
  EXPIRE: "expire",
  INVALIDATE: "invalidate",
  SEND_FOR_APPROVAL: "send_for_approval", // QUOTED → PENDING_APPROVAL
  APPROVE: "approve",                     // PENDING_APPROVAL → APPROVED
  RETURN: "return",                       // PENDING_APPROVAL → QUOTED (reject)
  UNAPPROVE: "unapprove",
  REQUEST_REQUOTE: "request_requote",
} as const;
```

- [ ] **Step 4: Shift `LEG_RANK` and extend `deriveQueryStatus`**

```ts
const LEG_RANK: Record<LegStatus, number> = {
  DRAFT: 0,
  READY_FOR_RFQ: 1,
  RFQ_SENT: 2,
  PARTIALLY_QUOTED: 3,
  FULLY_QUOTED: 4,
  PENDING_APPROVAL: 5,
  APPROVED: 6,
  AWARDED: 7,
  IN_TRANSIT: 8,
  DELIVERED: 9,
  CLOSED: 10,
};
```

Ranks are relative — only `leastAdvanced` reads them — so shifting everything above 4 by one is safe. In `deriveQueryStatus`, fold the new status in with `APPROVED`:

```ts
    case LegStatus.PENDING_APPROVAL:
    case LegStatus.APPROVED:
      return QueryStatus.QUOTED;
```

- [ ] **Step 5: Add the pure rollup rule**

Append to `packages/shared/src/status.ts`. This becomes the ONE definition of "what should this leg's status be" — `LegQuoteProjector` and `AwardService.reject` both call it, so the two cannot drift:

```ts
/**
 * Quote states that count as "settled" for the leg rollup (§9.2). `PENDING_APPROVAL` and
 * `APPROVED` count — a quote under review or already approved is not something we are still
 * waiting on. `REQUOTED` deliberately does NOT: a re-quote in flight is genuinely unresolved.
 */
const LEG_ROLLUP_RESOLVED: readonly QuoteStatus[] = [
  QuoteStatus.QUOTED,
  QuoteStatus.EXPIRED,
  QuoteStatus.CLOSED,
  QuoteStatus.PENDING_APPROVAL,
  QuoteStatus.APPROVED,
];

/**
 * What a leg's status SHOULD be, given its quotes. `null` means "nothing to say" — either
 * nothing was ever distributed, or every distributed quote is still outstanding, in which case
 * the leg keeps whatever status it already has.
 *
 * Undistributed (`SELECT`) quotes are excluded: they were never sent, so they can never resolve.
 */
export function rollupLegTarget(quoteStatuses: QuoteStatus[]): LegStatus | null {
  const distributed = quoteStatuses.filter((s) => s !== QuoteStatus.SELECT);
  if (distributed.length === 0) return null;
  if (distributed.every((s) => LEG_ROLLUP_RESOLVED.includes(s))) return LegStatus.FULLY_QUOTED;
  if (distributed.some((s) => s === QuoteStatus.QUOTED)) return LegStatus.PARTIALLY_QUOTED;
  return null;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @svyft/shared test -- src/status.test.ts
```

Expected: PASS. If any pre-existing test fails, it is asserting on the old `LEG_RANK` numbers — fix the assertion, not the rank.

- [ ] **Step 7: Add both enum values to Prisma and author the migration**

In `prisma/schema.prisma`, add `PENDING_APPROVAL` to `enum LegStatus` (after `FULLY_QUOTED`) and to `enum QuoteStatus` (after `REQUOTED`). Then:

```bash
set -a; . apps/api/.env; set +a; pnpm exec prisma migrate dev --name s59_pending_approval --schema prisma/schema.prisma
```

**Open the generated `migration.sql` and delete every `ALTER COLUMN "id" DROP DEFAULT` statement** — those are the pre-existing drift described in Global Constraints, not part of this change. What must remain is exactly:

```sql
ALTER TYPE "LegStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "QuoteStatus" ADD VALUE 'PENDING_APPROVAL';
```

- [ ] **Step 8: Rebuild shared and typecheck**

```bash
pnpm --filter @svyft/shared build && pnpm run typecheck
```

Expected: PASS. `typecheck` is the point of this step — `LEG_RANK` is an exhaustive `Record<LegStatus, number>`, so a missing entry is a compile error here, not a runtime surprise later.

- [ ] **Step 9: Commit**

```bash
git branch --show-current   # must print feat/stage-5-fx-master
git add packages/shared/src/status.ts packages/shared/src/status.test.ts prisma/schema.prisma prisma/migrations
git commit -m "feat(s5.9): PENDING_APPROVAL leg + quote statuses and the shared rollup rule"
```

---

## Task 2: Machine edges, rollup guard, and the four admittance sites

**Files:**
- Modify: `apps/api/src/modules/award/award.module.ts:44-64`
- Modify: `apps/api/src/modules/rfq/leg-quote.projector.ts`
- Modify: `apps/api/src/modules/comparison/comparison.service.ts:65`
- Modify: `apps/api/src/modules/changes/scope.resolver.ts:34`
- Modify: `apps/web/src/features/compare/NegotiateDialog.tsx` (`buildCandidates`)
- Test: `apps/api/test/leg-rollup.e2e-spec.ts` *(create)*

**Interfaces:**
- Consumes: `LegStatus.PENDING_APPROVAL`, `QuoteStatus.PENDING_APPROVAL`, `LegEvent.SEND_FOR_APPROVAL`/`APPROVE`/`RETURN_FULL`/`RETURN_PARTIAL`, `QuoteEvent.SEND_FOR_APPROVAL`/`APPROVE`/`RETURN`, `rollupLegTarget` (Task 1).
- Produces: the edges Tasks 3–5 fire. No service API changes.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/leg-rollup.e2e-spec.ts` following the existing e2e conventions — per-file prefix constant, `JwtService`-minted cookie, `afterAll` cleanup. Model the setup on `apps/api/test/award-workflow-maker.e2e-spec.ts`.

```ts
const PFX = "S59ROLLUP";

it("a leg under review is not dragged back by a straggler resolving", async () => {
  // Leg with TWO distributed quotes: one QUOTED, one still RFQ_SENT.
  // Move the leg to PENDING_APPROVAL directly through the machine.
  await status.fire("quote", quoteA.id, QuoteEvent.SEND_FOR_APPROVAL, { queryId });
  await status.fire("leg", legId, LegEvent.SEND_FOR_APPROVAL, { queryId });

  // The straggler now expires. Pre-fix this fired an illegal QUOTE_FULL off PENDING_APPROVAL.
  await status.fire("quote", quoteB.id, QuoteEvent.EXPIRE, { queryId });

  const leg = await prisma.leg.findUniqueOrThrow({ where: { id: legId } });
  expect(leg.status).toBe("PENDING_APPROVAL");
});

it("a quote under review still appears in the comparison grid", async () => {
  await status.fire("quote", quoteA.id, QuoteEvent.SEND_FOR_APPROVAL, { queryId });
  const res = await request(app.getHttpServer())
    .get(`/api/queries/${queryId}/comparison`)
    .set("Cookie", cookie)
    .expect(200);
  const offers = res.body.legs[0].offers as { quoteId: string }[];
  expect(offers.map((o) => o.quoteId)).toContain(quoteA.id);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- leg-rollup.e2e-spec.ts --runInBand
```

Expected: FAIL — the first test with an `IllegalTransitionError` logged and the leg no longer `PENDING_APPROVAL`; the second because `COMPARABLE_STATUSES` excludes the new status so the offer is absent.

- [ ] **Step 3: Contribute the edges in `award.module.ts`**

Replace the two `contribute` blocks in `onModuleInit` with:

```ts
    this.registry.contribute("quote", [
      { from: QuoteStatus.QUOTED, on: QuoteEvent.SEND_FOR_APPROVAL, to: QuoteStatus.PENDING_APPROVAL, kind: "forward" },
      { from: QuoteStatus.PENDING_APPROVAL, on: QuoteEvent.APPROVE, to: QuoteStatus.APPROVED, kind: "forward" },
      { from: QuoteStatus.PENDING_APPROVAL, on: QuoteEvent.RETURN, to: QuoteStatus.QUOTED, kind: "reopen" },
      { from: QuoteStatus.APPROVED, on: QuoteEvent.UNAPPROVE, to: QuoteStatus.QUOTED, kind: "reopen" },
      // negotiation sources — a re-quote can be asked for from any live state
      { from: QuoteStatus.QUOTED, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
      { from: QuoteStatus.PENDING_APPROVAL, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
      { from: QuoteStatus.APPROVED, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
      // durable REQUOTED re-submit
      { from: QuoteStatus.REQUOTED, on: QuoteEvent.SUBMIT, to: QuoteStatus.QUOTED, kind: "forward" },
      { from: QuoteStatus.REQUOTED, on: QuoteEvent.EXPIRE, to: QuoteStatus.EXPIRED, kind: "forward" },
      // change-order source
      { from: QuoteStatus.APPROVED, on: QuoteEvent.INVALIDATE, to: QuoteStatus.INVALID, kind: "reopen" },
    ]);
    this.registry.contribute("leg", [
      { from: LegStatus.FULLY_QUOTED, on: LegEvent.SEND_FOR_APPROVAL, to: LegStatus.PENDING_APPROVAL, kind: "forward" },
      { from: LegStatus.PARTIALLY_QUOTED, on: LegEvent.SEND_FOR_APPROVAL, to: LegStatus.PENDING_APPROVAL, kind: "forward" },
      { from: LegStatus.PENDING_APPROVAL, on: LegEvent.APPROVE, to: LegStatus.APPROVED, kind: "forward" },
      { from: LegStatus.PENDING_APPROVAL, on: LegEvent.RETURN_FULL, to: LegStatus.FULLY_QUOTED, kind: "reopen" },
      { from: LegStatus.PENDING_APPROVAL, on: LegEvent.RETURN_PARTIAL, to: LegStatus.PARTIALLY_QUOTED, kind: "reopen" },
      { from: LegStatus.APPROVED, on: LegEvent.REOPEN_AWARD, to: LegStatus.FULLY_QUOTED, kind: "reopen" },
      // change-order source
      { from: LegStatus.APPROVED, on: LegEvent.REOPEN, to: LegStatus.READY_FOR_RFQ, kind: "reopen" },
      { from: LegStatus.PENDING_APPROVAL, on: LegEvent.REOPEN, to: LegStatus.READY_FOR_RFQ, kind: "reopen" },
    ]);
```

Note what is **deliberately gone**: `QUOTED --APPROVE--> APPROVED` and `FULLY_QUOTED --APPROVE--> APPROVED`. Send-for-approval is now the only route to approval, and leaving the old edges would let an approval bypass it.

- [ ] **Step 4: Make the projector delegate and skip legs under review**

In `apps/api/src/modules/rfq/leg-quote.projector.ts`, delete the local `RESOLVED` array (its rule now lives in `rollupLegTarget`) and replace `recomputeLeg`:

```ts
import { LegEvent, LegStatus, QuoteStatus, rollupLegTarget } from "@svyft/shared";

/**
 * Legs whose status is owned by the approval flow, not by the quote rollup. A straggler
 * forwarder resolving while a leg is under review used to fire QUOTE_FULL off PENDING_APPROVAL —
 * an illegal edge, caught and logged, which left the leg permanently un-approvable (S5.9 §4.4).
 */
const ROLLUP_FROZEN: string[] = [LegStatus.PENDING_APPROVAL, LegStatus.APPROVED];

  private async recomputeLeg(legId: string, queryId: string): Promise<void> {
    const leg = await this.prisma.leg.findUnique({ where: { id: legId }, select: { status: true } });
    if (!leg) return;
    if (ROLLUP_FROZEN.includes(leg.status)) return;

    const quotes = await this.prisma.quote.findMany({
      where: { legId, status: { not: QuoteStatus.SELECT } },
      select: { status: true },
    });
    const target = rollupLegTarget(quotes.map((q) => q.status));
    if (target === null || target === leg.status) return;

    if (target === LegStatus.FULLY_QUOTED) {
      await this.status.fire("leg", legId, LegEvent.QUOTE_FULL, { queryId });
    } else if (leg.status === LegStatus.RFQ_SENT) {
      // PARTIALLY_QUOTED is only ever entered from RFQ_SENT — never walk a leg backwards.
      await this.status.fire("leg", legId, LegEvent.QUOTE_PARTIAL, { queryId });
    }
  }
```

- [ ] **Step 5: Admit the new quote status in the three server lists**

`apps/api/src/modules/comparison/comparison.service.ts:65` — **without this the selected offer disappears from the compare grid**, exactly as `APPROVED` once did:

```ts
const COMPARABLE_STATUSES: readonly QuoteStatus[] = [
  QuoteStatus.QUOTED,
  QuoteStatus.REQUOTED,
  QuoteStatus.PENDING_APPROVAL,
];
```

`apps/api/src/modules/changes/scope.resolver.ts:34` — without this, editing a leg while it is under review free-paths instead of raising a change order:

```ts
        status: {
          in: [
            QuoteStatus.RFQ_SENT,
            QuoteStatus.QUOTED,
            QuoteStatus.PENDING_APPROVAL,
            QuoteStatus.APPROVED,
          ],
        },
```

- [ ] **Step 6: Admit it in the negotiate eligibility list**

`apps/web/src/features/compare/NegotiateDialog.tsx`, inside `buildCandidates` — without this the forwarder currently under review becomes ineligible for negotiation:

```ts
    const quotable =
      offer.quoteStatus === "QUOTED" ||
      offer.quoteStatus === "PENDING_APPROVAL" ||
      offer.quoteStatus === "APPROVED";
```

- [ ] **Step 7: Run the new e2e plus the regression suites**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- --runInBand
```

Expected: the two new tests PASS. Existing award/negotiation specs that fire `QuoteEvent.APPROVE` from `QUOTED` will now fail — **do not re-add the retired edge.** Update those specs to send for approval first, which is the flow they are meant to exercise.

- [ ] **Step 8: Typecheck**

```bash
pnpm run typecheck
```

- [ ] **Step 9: Commit**

```bash
git branch --show-current
git add apps/api/src apps/web/src/features/compare/NegotiateDialog.tsx apps/api/test
git commit -m "feat(s5.9): pending-approval machine edges, frozen rollup, and status admittance"
```

---

## Task 3: One transactional `send-for-approval` that names its offer

**Files:**
- Modify: `packages/shared/src/award.ts:118-130`
- Modify: `apps/api/src/modules/award/award.service.ts:135-208` (`sendForApproval`) and `:100-133` (`shortlist`)
- Modify: `apps/api/src/modules/award/award.controller.ts:32-39`
- Modify: `apps/api/test/award-workflow-maker.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2's `QuoteEvent.SEND_FOR_APPROVAL`, `LegEvent.SEND_FOR_APPROVAL`.
- Produces: `sendForApprovalSchema` = `{ quoteId: string (uuid), variant: RateVariant | null, overrideReason?: string, proceedWithoutWaiting?: boolean, proceedReason?: string }`; `SendForApprovalInput`. `shortlistSchema`/`ShortlistInput` and `PUT …/shortlist` no longer exist.

**Why this shape (register B3):** the old endpoint named no offer and re-read `legAwardDecision.shortlistedQuoteId`, so a concurrent change between the two calls could submit a different forwarder than the maker was looking at — 200 OK, no error anywhere. One call in one transaction removes the window rather than narrowing it.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/award-workflow-maker.e2e-spec.ts`:

```ts
it("sends the offer named in the request, not whatever was last persisted", async () => {
  const res = await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/send-for-approval`)
    .set("Cookie", execCookie)
    .send({ quoteId: recommendedQuoteId, variant: "DEDICATED" })
    .expect(201);

  expect(res.body.status).toBe("PENDING_APPROVAL");
  expect(res.body.shortlistedQuoteId).toBe(recommendedQuoteId);

  const [leg, quote] = await Promise.all([
    prisma.leg.findUniqueOrThrow({ where: { id: legId } }),
    prisma.quote.findUniqueOrThrow({ where: { id: recommendedQuoteId } }),
  ]);
  expect(leg.status).toBe("PENDING_APPROVAL");
  expect(quote.status).toBe("PENDING_APPROVAL");
});

it("refuses a second send while the leg is already pending approval", async () => {
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/send-for-approval`)
    .set("Cookie", execCookie)
    .send({ quoteId: recommendedQuoteId, variant: "DEDICATED" })
    .expect(201);

  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/send-for-approval`)
    .set("Cookie", execCookie)
    .send({ quoteId: otherQuoteId, variant: "DEDICATED" })
    .expect(409);
});

it("requires an override reason when the named offer is not the recommendation", async () => {
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/send-for-approval`)
    .set("Cookie", execCookie)
    .send({ quoteId: otherQuoteId, variant: "DEDICATED" })
    .expect(400);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- award-workflow-maker.e2e-spec.ts --runInBand
```

Expected: FAIL — the body is rejected as unrecognised, and no leg/quote transition fires.

- [ ] **Step 3: Reshape the schema**

In `packages/shared/src/award.ts`, delete `shortlistSchema`/`ShortlistInput` and replace `sendForApprovalSchema`:

```ts
// S5.9 (D6, register B3) — selection and send are ONE call. The offer is named by the request
// that acts on it, so the server never has to trust a separately-persisted shortlist.
export const sendForApprovalSchema = z.object({
  quoteId: z.string().uuid(),
  variant: z.enum(CHARGE_RATE_VARIANTS).nullable(),
  overrideReason: z.string().trim().min(1).max(2000).optional(), // required when ≠ recommendation (A2)
  proceedWithoutWaiting: z.boolean().optional(),                 // A9 — in-flight re-quote override
  proceedReason: z.string().trim().min(1).max(2000).optional(),
});
export type SendForApprovalInput = z.infer<typeof sendForApprovalSchema>;
```

Rebuild shared: `pnpm --filter @svyft/shared build`.

- [ ] **Step 4: Merge the service methods**

In `award.service.ts`, rename the existing public `shortlist` to a private `persistSelection(tx, queryId, legId, input, user)` that keeps its current body — the `getComparison` offer validation, the A1 `priced` guard, and the recommendation snapshot — but takes a transaction client and performs only the upsert. Then rewrite `sendForApproval` to run everything in one transaction, in this order:

1. Load the leg (`where: { id: legId, queryId }`) with its non-`SELECT` quotes → 404 if absent.
2. **B2 guard (new):** load the decision; if `decision.status` is `PENDING_APPROVAL` or `APPROVED`, throw `ConflictException("This leg has already been sent for approval")`.
3. A3/D10 guard — unchanged: `leg.status === FULLY_QUOTED`, or every outstanding quote's RFQ deadline has passed.
4. `persistSelection(...)` → writes the decision with the named offer and its recommendation snapshot.
5. **A2 guard** — computed from the freshly-written decision, not a stale read: if the named offer differs from the snapshotted recommendation and `overrideReason` is absent, throw `BadRequestException`. Because this runs inside the transaction, the rejection rolls the selection back too.
6. **A9 guard** — unchanged: an in-flight `REQUOTED` quote on the leg requires `proceedWithoutWaiting === true` and a `proceedReason`.
7. Update the decision to `PENDING_APPROVAL` with `sentByUserId` / `sentForApprovalAt`, and append the `SEND_FOR_APPROVAL` `AwardDecisionEvent`.

Then, **after the transaction commits**, fire the two transitions — quote first, then leg:

```ts
    // Quote first, leg second. The projector skips legs in PENDING_APPROVAL/APPROVED (Task 2),
    // and the leg is still FULLY_QUOTED/PARTIALLY_QUOTED during the quote fire, so the rollup
    // sees a consistent picture either way. Each fire owns its own transaction.
    await this.status.fire("quote", input.quoteId, QuoteEvent.SEND_FOR_APPROVAL, {
      queryId,
      actorId: user.userId,
      reason: null,
    });
    await this.status.fire("leg", legId, LegEvent.SEND_FOR_APPROVAL, {
      queryId,
      actorId: user.userId,
    });
```

- [ ] **Step 5: Retire the shortlist route**

In `award.controller.ts`, delete the `@Put("legs/:legId/shortlist")` handler and the now-unused `shortlistSchema`/`ShortlistInput` imports. Update the `@Post("legs/:legId/send-for-approval")` handler's pipe to `new ZodValidationPipe(sendForApprovalSchema)`.

- [ ] **Step 6: Run the suite**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- --runInBand
```

Expected: the three new tests PASS. Every existing spec that called `PUT …/shortlist` must be rewritten to the single call — that is the point of the change, not collateral damage.

- [ ] **Step 7: Typecheck**

```bash
pnpm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git branch --show-current
git add packages/shared/src/award.ts apps/api/src apps/api/test
git commit -m "feat(s5.9): send-for-approval names its offer and runs in one transaction (B2, B3)"
```

---

## Task 4: Approve and reject against the new statuses

**Files:**
- Modify: `apps/api/src/modules/award/award.service.ts` (`approve`, `reject`, `requireDecidable`)
- Modify: `apps/api/test/award-workflow-checker.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1's `rollupLegTarget`; Task 2's `LegEvent.APPROVE`/`RETURN_FULL`/`RETURN_PARTIAL`, `QuoteEvent.APPROVE`/`RETURN`; Task 3's merged send.
- Produces: no signature changes. `approve` and `reject` keep returning `LegAwardDecision`.

**Why the guard has to change:** `approve()` currently throws `409` unless the leg is `FULLY_QUOTED`. After Task 3 the leg is `PENDING_APPROVAL` by the time anyone approves, so that guard would reject **every** approval. Its real intent — "no outstanding RFQs may still be open" — moves onto the quotes.

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/award-workflow-checker.e2e-spec.ts`:

```ts
it("approves a leg that is pending approval", async () => {
  await sendForApproval(legId, recommendedQuoteId);   // helper: the Task-3 single call
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/approve`)
    .set("Cookie", managerCookie)
    .expect(201);

  const [leg, quote] = await Promise.all([
    prisma.leg.findUniqueOrThrow({ where: { id: legId } }),
    prisma.quote.findUniqueOrThrow({ where: { id: recommendedQuoteId } }),
  ]);
  expect(leg.status).toBe("APPROVED");
  expect(quote.status).toBe("APPROVED");
});

it("returns a rejected leg to FULLY_QUOTED and its quote to QUOTED", async () => {
  await sendForApproval(legId, recommendedQuoteId);
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/reject`)
    .set("Cookie", managerCookie)
    .send({ reason: "Transit time too long" })
    .expect(201);

  const [leg, quote, decision] = await Promise.all([
    prisma.leg.findUniqueOrThrow({ where: { id: legId } }),
    prisma.quote.findUniqueOrThrow({ where: { id: recommendedQuoteId } }),
    prisma.legAwardDecision.findUniqueOrThrow({ where: { legId } }),
  ]);
  expect(leg.status).toBe("FULLY_QUOTED");
  expect(quote.status).toBe("QUOTED");
  expect(decision.status).toBe("DRAFT");
  expect(decision.rejectionReason).toBe("Transit time too long");
  expect(decision.sentByUserId).toBeNull();
});

// D4 — the case a hard-coded FULLY_QUOTED would get wrong.
it("returns a rejected deadline-passed leg to PARTIALLY_QUOTED, not FULLY_QUOTED", async () => {
  // legPartial has one QUOTED quote and one RFQ_SENT quote whose deadline has passed,
  // so the A3 path allows a send from PARTIALLY_QUOTED.
  await sendForApproval(legPartialId, partialQuoteId);
  expect((await prisma.leg.findUniqueOrThrow({ where: { id: legPartialId } })).status)
    .toBe("PENDING_APPROVAL");

  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legPartialId}/reject`)
    .set("Cookie", managerCookie)
    .send({ reason: "Wait for the others" })
    .expect(201);

  expect((await prisma.leg.findUniqueOrThrow({ where: { id: legPartialId } })).status)
    .toBe("PARTIALLY_QUOTED");
});

it("refuses to approve while an RFQ on the leg is still open", async () => {
  await sendForApproval(legPartialId, partialQuoteId);
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legPartialId}/approve`)
    .set("Cookie", managerCookie)
    .expect(409);
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- award-workflow-checker.e2e-spec.ts --runInBand
```

Expected: FAIL — approve 409s on the `FULLY_QUOTED` guard; reject leaves both leg and quote untouched.

- [ ] **Step 3: Add a rollup helper to the service**

```ts
  /**
   * The leg status the quotes currently justify. Delegates to the ONE pure rule in @svyft/shared
   * that LegQuoteProjector also uses, so reject and the rollup can never disagree (D4).
   */
  private async legRollupTarget(legId: string): Promise<LegStatus | null> {
    const quotes = await this.prisma.quote.findMany({
      where: { legId, status: { not: QuoteStatus.SELECT } },
      select: { status: true },
    });
    return rollupLegTarget(quotes.map((q) => q.status));
  }
```

- [ ] **Step 4: Rewrite `approve`**

Replace the `leg.status !== LegStatus.FULLY_QUOTED` guard, and move the A8 freshness check onto the new status:

```ts
    // The leg is PENDING_APPROVAL by now (Task 3), so the old FULLY_QUOTED check would reject
    // every approval. What it actually meant — no RFQ on this leg may still be open — is a
    // property of the QUOTES, so ask them directly. Guard BEFORE firing anything.
    if ((await this.legRollupTarget(legId)) !== LegStatus.FULLY_QUOTED) {
      throw new ConflictException(
        "This leg is not fully quoted; its outstanding RFQs must be closed out before approval",
      );
    }

    const quoteId = decision.shortlistedQuoteId;
    if (!quoteId) throw new ConflictException("This leg has no shortlisted offer");

    // A8 — a concurrent re-quote or change-order may have moved the quote off PENDING_APPROVAL.
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      select: { status: true },
    });
    if (!quote || quote.status !== QuoteStatus.PENDING_APPROVAL) {
      throw new ConflictException("The shortlisted quote is no longer available for approval");
    }

    await this.status.fire("quote", quoteId, QuoteEvent.APPROVE, {
      queryId,
      actorId: user.userId,
      reason: null,
    });
    await this.status.fire("leg", legId, LegEvent.APPROVE, { queryId, actorId: user.userId });
```

The long fire-ordering comment that used to sit here can go: the projector now skips legs in `PENDING_APPROVAL`/`APPROVED` outright (Task 2), so neither order can trigger a spurious rollup.

- [ ] **Step 5: Rewrite `reject`**

`reject` fired no status transitions at all. It now returns both the quote and the leg before writing the decision:

```ts
  async reject(
    queryId: string,
    legId: string,
    input: RejectInput,
    user: RequestUser,
  ): Promise<LegAwardDecision> {
    const { decision } = await this.requireDecidable(queryId, legId, user);

    // Return the quote FIRST: the leg is still PENDING_APPROVAL, so the projector skips the
    // rollup this fire would otherwise trigger, and the leg target below is then computed from
    // post-return quote statuses.
    if (decision.shortlistedQuoteId) {
      await this.status.fire("quote", decision.shortlistedQuoteId, QuoteEvent.RETURN, {
        queryId,
        actorId: user.userId,
        reason: input.reason,
      });
    }

    // D4 — restore the status the quotes justify, NOT a hard-coded FULLY_QUOTED. A leg sent from
    // PARTIALLY_QUOTED via the A3 deadline-passed path must land back on PARTIALLY_QUOTED;
    // promoting it would claim every forwarder quoted when some simply timed out.
    const target = await this.legRollupTarget(legId);
    await this.status.fire(
      "leg",
      legId,
      target === LegStatus.FULLY_QUOTED ? LegEvent.RETURN_FULL : LegEvent.RETURN_PARTIAL,
      { queryId, actorId: user.userId, reason: input.reason },
    );

    // Decision write UNCHANGED — straight to DRAFT carrying the reason (design §9.5). The
    // "REJECTED" moment is audit intent on the event log, not a persisted decision state.
    return this.prisma.$transaction(async (tx) => {
      /* … existing body, unchanged … */
    });
  }
```

`requireDecidable` already returns the leg; its `leg` field is now unused by `approve` — drop it from the return type rather than leaving a dead read.

- [ ] **Step 6: Run the suite**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- --runInBand
```

Expected: all four new tests PASS, whole suite green.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm run typecheck
git branch --show-current
git add apps/api/src apps/api/test
git commit -m "feat(s5.9): approve/reject drive leg and quote status; reject restores the rollup (D4)"
```

---

## Task 5: Negotiation — refuse under review, stop rotating the token

**Files:**
- Modify: `prisma/schema.prisma` (`model Rfq`)
- Create: `prisma/migrations/<timestamp>_s59_rfq_access_token/migration.sql`
- Modify: `apps/api/src/modules/rfq/rfq.service.ts:159-178` (`reissueToken`) and `:425-435` (distribution mint)
- Modify: `apps/api/src/modules/award/negotiation.service.ts:70-175`
- Modify: `apps/api/src/seed/message-templates.seed.ts:80-84`
- Modify: `apps/api/test/negotiation.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2's `QuoteStatus.PENDING_APPROVAL` edge for `REQUEST_REQUOTE`.
- Produces: `Rfq.accessToken: string | null` — the raw portal token, so any email can render the current link without minting a new one.

**Why (D7/D8):** the forwarder's bookmarked link must keep working — especially for a forwarder holding several legs across rounds. Rotation on re-quote protected nothing (the same token already survives the whole first round, and `resolveByToken` has no expiry), so it is removed; the Stage-4 **Regenerate** button remains the only rotation. Persisting the raw token is what makes that possible, and creates no new exposure class because `MessageLog.bodyRendered`/`tokens` already store the fully rendered email including the link.

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/negotiation.e2e-spec.ts`:

```ts
it("refuses a re-quote while the leg is pending approval (B1)", async () => {
  await sendForApproval(legId, quoteId);
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/request-requote`)
    .set("Cookie", execCookie)
    .send({ quoteId, comment: "Can you do better?" })
    .expect(409);

  // Nothing moved — the decision survives intact for the checker.
  const decision = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId } });
  expect(decision.status).toBe("PENDING_APPROVAL");
  expect(decision.shortlistedQuoteId).toBe(quoteId);
});

it("keeps the forwarder's existing portal link working across a re-quote (D7)", async () => {
  const before = await prisma.rfq.findUniqueOrThrow({ where: { id: rfqId } });

  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/request-requote`)
    .set("Cookie", execCookie)
    .send({ quoteId, comment: "Please revise" })
    .expect(201);

  const after = await prisma.rfq.findUniqueOrThrow({ where: { id: rfqId } });
  expect(after.accessTokenHash).toBe(before.accessTokenHash);

  // The old link still resolves.
  await request(app.getHttpServer())
    .get(`/api/ff/rfq/${before.accessToken}`)
    .expect(200);
});

it("puts that same link in the re-quote email", async () => {
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/request-requote`)
    .set("Cookie", execCookie)
    .send({ quoteId, comment: "Please revise" })
    .expect(201);

  const log = await prisma.messageLog.findFirstOrThrow({
    where: { eventKey: "rfq.requote_requested", entityId: rfqId },
    orderBy: { createdAt: "desc" },
  });
  const rfq = await prisma.rfq.findUniqueOrThrow({ where: { id: rfqId } });
  expect(log.bodyRendered).toContain(rfq.accessToken!);
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- negotiation.e2e-spec.ts --runInBand
```

Expected: FAIL — the re-quote returns 201 and wipes the decision; `accessTokenHash` changes; `Rfq.accessToken` does not exist.

- [ ] **Step 3: Persist the raw token**

In `prisma/schema.prisma`, add to `model Rfq` immediately below `accessTokenHash`:

```prisma
  /// The raw portal token. Persisted (S5.9 D8) so a re-quote email can render the CURRENT link
  /// without minting a new one — rotation would break the forwarder's bookmark (D7). Nullable
  /// for rows created before S5.9. `accessTokenHash` remains the lookup index.
  accessToken        String?
```

```bash
set -a; . apps/api/.env; set +a; pnpm exec prisma migrate dev --name s59_rfq_access_token --schema prisma/schema.prisma
```

**Strip the unrelated `ALTER COLUMN "id" DROP DEFAULT` statements** from the generated SQL (Global Constraints). Only the `ADD COLUMN "accessToken" TEXT` should remain.

- [ ] **Step 4: Write the token at every mint**

In `apps/api/src/modules/rfq/rfq.service.ts`, `reissueToken` (line ~172):

```ts
      await tx.rfq.update({
        where: { id: rfq.id },
        data: { accessTokenHash: hash, accessToken: token },
      });
```

And in the distribution path (line ~431), alongside `accessTokenHash: t.hash`, add `accessToken: t.token`.

- [ ] **Step 5: Guard the re-quote and stop rotating**

In `apps/api/src/modules/award/negotiation.service.ts`:

Add the B1 guard **before** any fire, so a refusal leaves nothing half-done:

```ts
    // B1 / D5 — the compare screen has disabled Negotiate at PENDING_APPROVAL since S5.7 while
    // this endpoint still accepted it, silently wiping a decision a checker was reviewing. Worse
    // now that leg status moves: an accepted call would park the leg at PENDING_APPROVAL with a
    // DRAFT decision, which no screen can act on. Reject first, then re-negotiate (design §9).
    const existing = await this.prisma.legAwardDecision.findUnique({ where: { legId } });
    if (existing?.status === AwardDecisionStatus.PENDING_APPROVAL) {
      throw new ConflictException(
        "This leg is pending approval — it must be rejected before a re-quote can be requested",
      );
    }
```

Then **delete step 4 entirely** (the `reissueToken` call) and read the stored token instead when composing the email:

```ts
    // D7 — the token is NOT rotated. The forwarder's existing link keeps working, which matters
    // most for a forwarder holding several legs on this query. The Stage-4 Regenerate button
    // (RegeneratePortalLink.tsx) remains the only way to rotate.
    const base = process.env.PORTAL_BASE_URL ?? "";
    const link = rfqRow?.accessToken
      ? `${base}/ff/rfq/${rfqRow.accessToken}`
      : "the portal link in your original RFQ email";
```

Widen the `rfqRow` select to `{ rfqNumber: true, accessToken: true }` and pass `Access_Link: link`. The fallback covers RFQs created before this migration, which have no stored token; a backfill from `MessageLog.tokens` is possible and deliberately out of scope.

- [ ] **Step 6: Update the email copy**

In `apps/api/src/seed/message-templates.seed.ts`, the `rfq.requote_requested.email` body — the link is now the forwarder's existing one, so say so:

```ts
    body: "We would like to request a revised quote for RFQ {{RFQ_Number}}.\nComment: {{Comment}}\n\nYour earlier submission remains on file. Please submit your updated price via your usual secure portal link — it has not changed: {{Access_Link}}",
```

Reseed (idempotent): `set -a; . apps/api/.env; set +a; pnpm exec prisma db seed`.

- [ ] **Step 7: Run the suite**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- --runInBand
```

Expected: the three new tests PASS. Any existing spec asserting that a re-quote **changes** the token hash is asserting the behaviour D7 deliberately removes — update it to assert the opposite.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm run typecheck
git branch --show-current
git add prisma apps/api/src apps/api/test
git commit -m "feat(s5.9): refuse re-quote under review (B1); stop rotating the portal token (D7/D8)"
```

---

## Task 6: The forwarder can answer a re-quote again

**Files:**
- Modify: `apps/web/src/features/ff-portal/LegSection.tsx:120-178`
- Modify: `apps/web/src/features/ff-portal/LegSection.test.tsx`

**Interfaces:**
- Consumes: `QuoteStatus.PENDING_APPROVAL` (Task 1).
- Produces: nothing downstream.

**This is the Critical.** `ff-portal.service.ts:260` accepts a submit from a `REQUOTED` quote, and `ff-portal-requote-submit.e2e-spec.ts` proves the retained draft comes back so "the FF sees their earlier bid to revise, not a blank form". But `LegSection.tsx` branches `QUOTED` → summary, **anything not `RFQ_SENT`** → "This leg is not open for quoting", `RFQ_SENT` → form. `REQUOTED` lands in the middle branch, so the whole negotiate feature dead-ends at the forwarder. There is no frontend test covering it, which is why nothing caught it.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/features/ff-portal/LegSection.test.tsx`:

```ts
it("lets the forwarder revise a price on a REQUOTED leg", async () => {
  renderLegSection({ status: "REQUOTED", draft: draftWithPrices });
  await userEvent.click(screen.getByRole("button", { name: /L-1/ }));

  expect(screen.queryByText(/not open for quoting/i)).not.toBeInTheDocument();
  expect(await screen.findByRole("button", { name: /submit/i })).toBeEnabled();
});

it("shows the forwarder their retained draft rather than a blank form", async () => {
  renderLegSection({ status: "REQUOTED", draft: draftWithPrices });
  await userEvent.click(screen.getByRole("button", { name: /L-1/ }));

  expect(await screen.findByDisplayValue("1250")).toBeInTheDocument();
});

it("never tells the forwarder a commercial outcome", async () => {
  for (const status of ["PENDING_APPROVAL", "APPROVED"] as const) {
    const { unmount } = renderLegSection({ status });
    expect(screen.getByText("Under review")).toBeInTheDocument();
    expect(screen.queryByText(/approved/i)).not.toBeInTheDocument();
    unmount();
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @svyft/web test -- src/features/ff-portal/LegSection.test.tsx
```

Expected: FAIL — the REQUOTED body renders "This leg is not open for quoting"; `PENDING_APPROVAL` renders the raw enum string via the badge fallback; `APPROVED` renders "Approved".

- [ ] **Step 3: Open the editable branch to `REQUOTED`**

In `LegSectionBody`:

```tsx
  // ── Status branch: QUOTED (submitted, awaiting our decision) ───────────
  if (leg.status === "QUOTED") {
    return <AlreadySubmittedSummary leg={leg} rfq={rfq} />;
  }

  // ── Status branch: not open ────────────────────────────────────────────
  // REQUOTED belongs with RFQ_SENT, not here: ff-portal.service.ts's submit guard accepts both,
  // and a re-quote request exists precisely so the forwarder can revise. Omitting it dead-ended
  // the whole negotiate flow — the forwarder was told the leg was closed (S5.9 §1).
  if (leg.status !== "RFQ_SENT" && leg.status !== "REQUOTED") {
    return (
      <div className="space-y-4">
        <CargoManifestTable cargo={leg.manifest.cargo} />
        <p className="text-sm text-muted-foreground">This leg is not open for quoting.</p>
      </div>
    );
  }

  // ── Editable form (RFQ_SENT | REQUOTED) ────────────────────────────────
```

- [ ] **Step 4: Make the outcome statuses neutral (D9)**

In `LEG_STATUS_BADGE`, replace the `APPROVED` entry and add the new one. Both render identically on purpose:

```ts
  // D9 — the forwarder must never learn a commercial outcome from this screen. Approval selects
  // a forwarder with NO forwarder notification and stays reversible until the client accepts
  // (design D5), and a leading forwarder who knows they are leading has no reason to sharpen.
  // Both internal states therefore read as one neutral label.
  PENDING_APPROVAL: { label: "Under review", variant: "secondary" },
  APPROVED: { label: "Under review", variant: "secondary" },
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @svyft/web test -- src/features/ff-portal/
```

Expected: PASS. **Mutation-prove the third test**: revert the `APPROVED` label to `"Approved"`, confirm it goes red, restore it.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm run typecheck
git branch --show-current
git add apps/web/src/features/ff-portal
git commit -m "fix(s5.9): a REQUOTED leg is quotable again; forwarder outcomes read 'Under review'"
```

---

## Task 7: Stale-page guard on the portal submit

**Files:**
- Modify: `packages/shared/src/ff-portal.ts:57-67`
- Modify: `apps/api/src/modules/ff-portal/ff-portal.service.ts` (`get`, `submit`)
- Modify: `apps/api/src/modules/ff-portal/ff-portal.controller.ts:31-34`
- Modify: `apps/web/src/features/ff-portal/portalClient.ts`, `LegSection.tsx`
- Test: `apps/api/test/ff-portal-stale-submit.e2e-spec.ts` *(create)*

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FfPortalLegDto.version: string`; `submitQuoteSchema = z.object({ version: z.string().min(1) })`; `POST …/quotes/:legId/submit` now takes that body.

**Why not `Quote.updatedAt` (D10):** the portal autosaves drafts, and `@updatedAt` bumps on every save — the forwarder's own typing would invalidate their own page. The version is derived instead from exactly what a stale page gets wrong: quote status, submission deadline, manifest snapshot, charge-config snapshot.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/ff-portal-stale-submit.e2e-spec.ts` (`const PFX = "S59STALE";`, same conventions as `ff-portal-requote-submit.e2e-spec.ts`):

```ts
it("refuses a submit carrying a stale version", async () => {
  const before = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
  const staleVersion = before.body.legs[0].version as string;

  // The basis changes underneath the open page — a re-quote request on this very leg.
  await prisma.quote.update({ where: { id: quoteId }, data: { status: "REQUOTED" } });

  const res = await request(app.getHttpServer())
    .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
    .send({ version: staleVersion })
    .expect(409);
  expect(res.body.message).toMatch(/refresh/i);
});

it("accepts a submit carrying the current version", async () => {
  const fresh = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
  await request(app.getHttpServer())
    .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
    .send({ version: fresh.body.legs[0].version })
    .expect(201);
});

it("a forwarder's own draft save does not invalidate their page", async () => {
  const before = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
  const version = before.body.legs[0].version as string;

  await request(app.getHttpServer())
    .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
    .send(validDraft)
    .expect(200);

  const after = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
  expect(after.body.legs[0].version).toBe(version);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- ff-portal-stale-submit.e2e-spec.ts --runInBand
```

Expected: FAIL — `version` is `undefined` on the DTO and the submit ignores the body.

- [ ] **Step 3: Add the version to the shared DTO**

In `packages/shared/src/ff-portal.ts`, add to `FfPortalLegDto`:

```ts
  /** Opaque fingerprint of everything a submit is priced against — quote status, submission
   *  deadline, manifest snapshot, charge-config snapshot. Echoed back on submit so an open page
   *  whose basis moved fails loudly instead of pricing against a stale one (S5.9 D10).
   *  Deliberately NOT derived from `Quote.updatedAt`: drafts autosave, so that would let the
   *  forwarder's own typing invalidate their page. */
  version: string;
```

And export the submit body schema:

```ts
export const submitQuoteSchema = z.object({ version: z.string().min(1) });
export type SubmitQuoteInput = z.infer<typeof submitQuoteSchema>;
```

Rebuild: `pnpm --filter @svyft/shared build`.

- [ ] **Step 4: Derive and emit it**

In `ff-portal.service.ts`, add the helper and set `version` on every leg the `get` path builds (near line 191, where `status: q.status as …` is assigned):

```ts
import { createHash } from "node:crypto";

  /** Deterministic across processes — plain sha256 over a stable field order. */
  private legVersion(q: {
    status: string;
    manifestSnapshot: unknown;
    chargeConfigSnapshot: unknown;
  }, submissionDeadline: Date): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          q.status,
          submissionDeadline.toISOString(),
          q.manifestSnapshot,
          q.chargeConfigSnapshot,
        ]),
      )
      .digest("hex")
      .slice(0, 16);
  }
```

- [ ] **Step 5: Guard the submit**

In `submit(scope, legId, input)`, immediately after `quoteForLeg` and **before** the existing status guard:

```ts
    if (this.legVersion(q, scope.rfq.submissionDeadline) !== input.version) {
      throw new ConflictException(
        "This RFQ has been updated — please refresh the page before submitting.",
      );
    }
```

Order matters: the version check runs first so a genuinely stale page gets the actionable message rather than the existing generic "already been submitted or is not open".

In `ff-portal.controller.ts`:

```ts
  @Post("quotes/:legId/submit")
  @HttpCode(201)
  submit(
    @FfScope() scope: FfScopeType,
    @Param("legId") legId: string,
    @Body(new ZodValidationPipe(submitQuoteSchema)) body: SubmitQuoteInput,
  ) {
    return this.portal.submit(scope, legId, body);
  }
```

- [ ] **Step 6: Send it from the portal**

In `portalClient.ts`, have the submit helper take and post `{ version }`. In `LegSection.tsx`, pass `leg.version` from the same DTO the form is rendering — never a value cached elsewhere, or the guard checks the wrong thing. The 409 surfaces through the existing `PortalError` path; add a case so the message renders inline rather than as a generic failure.

- [ ] **Step 7: Run both suites**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- --runInBand
pnpm --filter @svyft/web test -- src/features/ff-portal/
```

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm run typecheck
git branch --show-current
git add packages/shared/src/ff-portal.ts apps/api/src apps/api/test apps/web/src/features/ff-portal
git commit -m "feat(s5.9): portal submit is guarded by a derived leg version (D10)"
```

---

## Task 8: The comparison grid — column order, `★`, forwarder band

**Files:**
- Modify: `apps/web/src/features/compare/comparisonRowModel.ts:105-160`
- Modify: `apps/web/src/features/compare/ComparisonGridRows.tsx`
- Modify: `apps/web/src/features/compare/ComparisonGridColumns.tsx`
- Modify: `apps/web/src/features/compare/ComparisonGrid.test.tsx`, `comparisonRowModel.test.ts`

**Interfaces:**
- Consumes: `ComparisonRowModel`, `OfferCell`, `METRICS` (existing).
- Produces: `METRICS` in the new order; `RECOMMENDED_MARK = "★"`; `RECOMMENDATION_FOOTNOTE = "★ Recommended by the comparison engine."`

Covers product items 1, 2 and 5. Both orientations are retained; because `METRICS` is single-sourced, the order applies to the rows view's columns **and** the columns view's row labels automatically.

- [ ] **Step 1: Write the failing tests**

In `comparisonRowModel.test.ts`:

```ts
it("orders the metrics as the product owner specified", () => {
  expect(METRICS.map((m) => m.label)).toEqual([
    "Total (native)",
    "Rate (per USD)",
    "Total (USD)",
    "Transit",
    "Valid until",
  ]);
});
```

In `ComparisonGrid.test.tsx`, for **both** orientations:

```ts
it.each(["columns", "rows"] as const)(
  "marks the recommendation with a star carrying its reason (%s)",
  async (viewMode) => {
    renderGrid({ viewMode });
    const mark = screen.getByTestId(`offer-recommended-${recommendedKey}`);
    expect(mark).toHaveTextContent("★");
    expect(mark).toHaveAccessibleName(/cheapest landed cost/i);
    expect(screen.getByText(/★ Recommended by the comparison engine/)).toBeInTheDocument();
  },
);

it.each(["columns", "rows"] as const)(
  "keeps the recommended offer visually tinted (%s)",
  async (viewMode) => {
    renderGrid({ viewMode });
    expect(screen.getByTestId(`offer-usd-${recommendedKey}`).className).toContain("emerald");
  },
);

it("prints each forwarder's name once, on its own full-width band row", () => {
  renderGrid({ viewMode: "rows" });
  const band = screen.getByTestId("forwarder-band-ff-1");
  expect(band).toHaveTextContent("Bridge Logistics");
  expect(band.querySelector("td")).toHaveAttribute("colspan");
  // The name is no longer repeated in a per-row column.
  expect(screen.queryByRole("columnheader", { name: /forwarder/i })).not.toBeInTheDocument();
});

it("no longer renders a Recommended badge in the status cell", () => {
  renderGrid({ viewMode: "rows" });
  expect(screen.queryByText(/^★ Recommended$/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @svyft/web test -- src/features/compare/
```

Expected: FAIL on all five — the order differs, no star element exists, no band row, the badge is still present.

- [ ] **Step 3: Reorder the metrics and add the marker constants**

In `comparisonRowModel.ts`, reorder the `METRICS` entries to `nativeTotal`, `rate`, `usdTotal`, `transit`, `validUntil` — **move the objects, do not retype them**; `id`, `render` and the two lookup maps stay exactly as they are. The `as const satisfies` is load-bearing and must survive. Add below `RECOMMENDED_TINT`:

```ts
/** The recommendation marker (product item 2). Replaces the status-cell badge: a `★` beside the
 *  variant costs no column width, and the reason rides on its accessible name so the information
 *  is not lost with the badge. The footnote below the table explains it once per leg. */
export const RECOMMENDED_MARK = "★";
export const RECOMMENDATION_FOOTNOTE = "★ Recommended by the comparison engine.";
```

- [ ] **Step 4: Rework the rows view**

In `ComparisonGridRows.tsx`:

1. Delete the `Forwarder / variant` `<TableHead>` and replace it with `Variant`.
2. Emit a band row before each group, instead of printing the name inside the first cell:

```tsx
{groups.map((group, groupIndex) => (
  <Fragment key={group.freightForwarderId}>
    <TableRow
      data-testid={`forwarder-band-${group.freightForwarderId}`}
      className={cn("bg-muted/60", groupIndex > 0 && GROUP_TOP_RULE)}
    >
      <TableCell
        colSpan={METRICS.length + 2}
        className="py-1.5 text-xs font-semibold text-foreground"
      >
        {group.freightForwarderName}
      </TableCell>
    </TableRow>
    {group.cells.map((cell) => ( /* … the existing per-cell row … */ ))}
  </Fragment>
))}
```

`colSpan` is `METRICS.length + 2` — the metrics, plus Variant and Status. It must be derived, never hard-coded, or a future metric silently breaks the band.

3. In the variant cell, drop the `isFirstInGroup` name block and the indentation, and append the marker:

```tsx
{cell.recommended && leg.recommendation && (
  <span
    data-testid={`offer-recommended-${cell.key}`}
    aria-label={`Recommended — ${leg.recommendation.reason}`}
    title={leg.recommendation.reason}
    className="ml-1 text-emerald-600"
  >
    {RECOMMENDED_MARK}
  </span>
)}
```

4. Delete the `★ Recommended` `<Badge>` from the status cell. The stale badge stays.

- [ ] **Step 5: Mirror it in the columns view**

In `ComparisonGridColumns.tsx`, append the same marker element to the variant header cell (the forwarder name already sits in its own `colSpan` header, so no band row is needed here) and delete the `★ Recommended` `<Badge>` from the Status row.

- [ ] **Step 6: Add the footnote**

In `ComparisonGrid.tsx`, immediately after the orientation dispatch, render it once per leg — only when there is a recommendation to explain:

```tsx
{model.recommendedKey && (
  <p className="text-xs text-muted-foreground">{RECOMMENDATION_FOOTNOTE}</p>
)}
```

- [ ] **Step 7: Run the tests**

```bash
pnpm --filter @svyft/web test -- src/features/compare/
```

Expected: PASS. **Mutation-prove the tint test** — remove `RECOMMENDED_TINT` from the metric cell, confirm red, restore.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm run typecheck
git branch --show-current
git add apps/web/src/features/compare
git commit -m "feat(s5.9): grid column order, star recommendation marker, forwarder band row"
```

---

## Task 9: Actions below the table

**Files:**
- Create: `apps/web/src/features/compare/SendForApprovalDialog.tsx`, `SendForApprovalDialog.test.tsx`
- Delete: `apps/web/src/features/compare/ShortlistDialog.tsx`, `ShortlistDialog.test.tsx`, `ShortlistSelectCell.tsx`
- Modify: `apps/web/src/features/compare/CompareLegPanel.tsx`, `useAwardActions.ts`, `ComparisonGridRows.tsx`, `ComparisonGridColumns.tsx`, `ComparisonGrid.tsx`

**Interfaces:**
- Consumes: Task 3's merged endpoint; Task 8's row model.
- Produces: `useSendForApproval(queryId, legId)` now takes `SendForApprovalInput` (offer identity included). `useShortlist` is deleted. `ComparisonGrid`/`ComparisonGridRows`/`ComparisonGridColumns` lose their `onShortlistOffer` prop and the Shortlist row/column entirely.

**Port these regression tests, do not delete them.** `ShortlistDialog.test.tsx`'s *"the offer submitted is the offer whose Select was clicked"* block exists because of the S5.6 Critical. The dialog changes shape; the guarantee does not. Move them into `SendForApprovalDialog.test.tsx` as *"submits the offer that is selected in the dialog"*.

- [ ] **Step 1: Write the failing tests**

`SendForApprovalDialog.test.tsx`:

```ts
it("lists every priced offer with its forwarder, variant and USD total", async () => {
  renderDialog();
  const options = screen.getAllByRole("radio");
  expect(options).toHaveLength(3);
  expect(screen.getByLabelText(/Bridge Logistics — Dedicated/)).toBeInTheDocument();
  expect(screen.getByText("$12,400.00")).toBeInTheDocument();
});

it("omits unpriced offers rather than showing a fake $0", () => {
  renderDialog();
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
});

it("allows exactly one selection", async () => {
  renderDialog();
  await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/));
  await userEvent.click(screen.getByLabelText(/Oceanic — Groupage/));
  expect(screen.getByLabelText(/Bridge Logistics — Dedicated/)).not.toBeChecked();
  expect(screen.getByLabelText(/Oceanic — Groupage/)).toBeChecked();
});

it("requires a reason only when the pick is not the recommendation", async () => {
  renderDialog();
  await userEvent.click(screen.getByLabelText(/Oceanic — Groupage/)); // not recommended
  await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/reason is required/i);
  expect(postJson).not.toHaveBeenCalled();
});

it("sends the recommended offer with the reason box never touched", async () => {
  renderDialog();
  await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/)); // recommended
  await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
  await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
  expect(postJson.mock.calls[0][1]).toEqual({
    quoteId: recommendedQuoteId,
    variant: "DEDICATED",
  });
});

// Ported from ShortlistDialog.test.tsx — the S5.6 Critical must stay dead.
it("submits the offer that is selected in the dialog, not one merely read elsewhere", async () => {
  renderDialog();
  await userEvent.click(screen.getByLabelText(/Oceanic — Groupage/));
  await userEvent.type(screen.getByLabelText(/reason/i), "Better transit time");
  await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
  await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
  expect(postJson.mock.calls[0][1]).toMatchObject({ quoteId: oceanicQuoteId, variant: "GROUPAGE" });
});
```

In `ComparisonGrid.test.tsx`:

```ts
it.each(["columns", "rows"] as const)("no longer renders a Shortlist affordance (%s)", (viewMode) => {
  renderGrid({ viewMode });
  expect(screen.queryByRole("button", { name: /^Select/ })).not.toBeInTheDocument();
  expect(screen.queryByText("Shortlist")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @svyft/web test -- src/features/compare/
```

Expected: FAIL — `SendForApprovalDialog` does not exist; the grid still renders Select buttons.

- [ ] **Step 3: Build `SendForApprovalDialog.tsx`**

A `Dialog` containing a `RadioGroup` over `buildComparisonRowModel(leg, false).cells.filter((c) => c.offer.priced)`, one row per offer showing `freightForwarderName — variantLabel` and `fmtUsd(offer.usdTotal)`, grouped under the same forwarder headings the grid uses. Requirements:

- Radio value is the cell's `offer.quoteId` + `variant`, keyed by `offerKey` — the same helper the grid keys cells by, so "is this the recommendation?" cannot disagree with the tint the maker just looked at.
- `overrideRequired = selectedKey !== recommendedKey`. Render the reason textarea only when true, labelled *"Required — this offer differs from the recommended one."*
- `overrideReason` uses `setValueAs: (v: string) => (v === "" ? undefined : v)`. **`shortlistSchema`'s successor accepts `undefined`, not `""`** — a `""` default makes zodResolver reject every submit of the recommended offer, which is the common path and the one case that renders no textarea at all, so nothing on screen explains the dead button. This bug shipped once in S5.6 Task 4; the fifth test above exists to keep it dead.
- Stale (`REQUOTED`) offers stay selectable but carry the `STALE_OFFER_LABEL` warning.
- The A9 block (`leg.awaitingReQuote` → "Proceed without waiting" checkbox + reason) carries over from `ShortlistDialog` unchanged.
- **One mutation call.** No save-then-send chain — Task 3 made it a single endpoint.

- [ ] **Step 4: Rewire the hooks**

In `useAwardActions.ts`, delete `useShortlist` entirely and widen `useSendForApproval`'s body type to `SendForApprovalInput`. Keep the existing invalidation of both `["comparison", queryId]` and `["query", queryId]`.

- [ ] **Step 5: Strip the Shortlist affordance from the grid**

Delete `ShortlistSelectCell.tsx`. Remove the `onShortlistOffer` prop, the `shortlistHandler` derivation, and the Shortlist row/column from `ComparisonGrid.tsx`, `ComparisonGridColumns.tsx` and `ComparisonGridRows.tsx`. The grid becomes purely read-only again.

- [ ] **Step 6: Move the actions below the grid**

In `CompareLegPanel.tsx`: delete `shortlistKey`, `shortlistCell`, and the `useEffect` that cleared the key (all three existed only to serve the in-grid Select). Keep `canShortlist` — renamed `canSend` — and `negotiateDisabledReason`. Below `<ComparisonGrid …/>`, render the action bar:

```tsx
{!locked && (
  <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
    {negotiateDisabledReason && (
      <span className="text-xs text-muted-foreground">{negotiateDisabledReason}</span>
    )}
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={negotiateDisabledReason != null}
      onClick={() => setNegotiateOpen(true)}
    >
      Negotiate…
    </Button>
    {canSend && (
      <Button type="button" size="sm" onClick={() => setSendOpen(true)}>
        Send for approval…
      </Button>
    )}
  </div>
)}
```

Remove the Negotiate button from the "N offers received" line, leaving the offer count and the view toggle there.

- [ ] **Step 7: Run the tests**

```bash
pnpm --filter @svyft/web test -- src/features/compare/
```

Expected: PASS, including all ported regression tests. **Mutation-prove the "no Shortlist affordance" test** — re-add a Select button, confirm red, revert.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm run typecheck
git branch --show-current
git add apps/web/src/features/compare
git commit -m "feat(s5.9): one send-for-approval dialog below the grid; in-grid Select retired"
```

---

## Task 10: Locked-state messaging on hover, and the full gate

**Files:**
- Modify: `apps/web/src/features/compare/MakerPanel.tsx`, `MakerPanel.test.tsx`
- Modify: `apps/web/src/features/compare/CompareLegPanel.tsx`
- Modify: `docs/Stage 5 - Session Handoff.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing downstream. `MakerPanel` renders only the rejection alert or `null`.

Product item 7. Both locked-state paragraphs move onto the leg header's decision chip as a tooltip (`components/ui/tooltip.tsx` already exists). **The rejection alert stays visible** — it is the maker's only cue that rework is needed, and burying it was a defect the S5.6 review already caught once (finding I2).

- [ ] **Step 1: Write the failing tests**

```ts
it("no longer renders the approved-state paragraph as a block", () => {
  renderPanel({ decision: { status: "APPROVED" } });
  expect(screen.queryByText(/its shortlist is final here/i)).not.toBeInTheDocument();
  expect(screen.queryByTestId("maker-panel")).not.toBeInTheDocument();
});

it("explains an approved leg on hover of its decision chip instead", async () => {
  renderLegPanel({ decision: { status: "APPROVED" } });
  await userEvent.hover(screen.getByTestId("decision-chip"));
  expect(await screen.findByRole("tooltip")).toHaveTextContent(/shortlist is final/i);
});

it("keeps a rejection reason visible without hovering", () => {
  renderPanel({ decision: { status: "DRAFT", rejectionReason: "Transit too long" } });
  expect(screen.getByRole("alert")).toHaveTextContent("Transit too long");
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @svyft/web test -- src/features/compare/MakerPanel.test.tsx
```

Expected: FAIL — the paragraph and its bordered card still render; there is no tooltip.

- [ ] **Step 3: Reduce `MakerPanel`**

Delete both `status === "PENDING_APPROVAL"` and `status === "APPROVED"` paragraph blocks and the `isLocked` derivation. The early return becomes simply:

```tsx
  if (!returnedReason) return null;
```

- [ ] **Step 4: Put the copy on the chip**

In `CompareLegPanel.tsx`, extend `decisionBadge` to return a `hint` alongside `label`/`variant`:

```ts
    case "PENDING_APPROVAL":
      return {
        label: "Pending approval",
        variant: "warning",
        hint: "Locked while this leg is pending approval — a checker has to reject it (which returns it to draft) before the selection can change.",
      };
    case "APPROVED":
      return {
        label: "Approved",
        variant: "success",
        hint: "This leg is approved — its selection is final here. Revising it needs a change request or a fresh negotiation with the forwarder.",
      };
```

Wrap the chip in the existing `Tooltip`/`TooltipTrigger`/`TooltipContent` primitives, rendering the tooltip only when `hint` is set, and add `data-testid="decision-chip"` to the trigger. The header button is already interactive, so the trigger must use `asChild` on the badge rather than nesting a second button.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @svyft/web test -- src/features/compare/
```

**Mutation-prove the first test** — restore the paragraph, confirm red, remove it again.

- [ ] **Step 6: Run the full gate**

```bash
pnpm --filter @svyft/shared build
set -a; . apps/api/.env; set +a; pnpm run ci
```

Expected: lint + typecheck + test + build green across all three workspaces. If `award-generate.e2e-spec.ts` ("combinedUsd is re-rounded") or `ff-portal-v3.e2e-spec.ts` fails once and passes on re-run, that is the known intermittent flake (register C5) — re-run to confirm, and report it rather than "fixing" it.

- [ ] **Step 7: Update the handoff**

In `docs/Stage 5 - Session Handoff.md`:
- Add an S5.9 row to the sub-build table.
- Move register items **B1, B2, B3** from open to closed, naming S5.9.
- Record the REQUOTED portal defect (Task 6) in section D as **found and fixed**, with the note that it had no frontend coverage — a shipped feature that dead-ended at the forwarder.
- Record D7/D8 (token no longer rotates; raw token persisted) and the **`MessageLog` plaintext finding** as a new open item, since it is real and out of scope here.
- Note that **A5** remains open by choice.

- [ ] **Step 8: Commit**

```bash
git branch --show-current
git add apps/web/src/features/compare "docs/Stage 5 - Session Handoff.md"
git commit -m "feat(s5.9): locked-state copy moves to a tooltip; handoff updated"
```

---

## Self-review notes

Checked against the design doc, 2026-08-21:

- **Every product item is covered:** 1/2/5 → Task 8; 3/4/6 → Task 9 (item 6 is satisfied by D2's status, delivered in Tasks 1–3); 7 → Task 10; 8 → Tasks 1–4; 9 → Task 4.
- **Every design decision has a task:** D1/D2 → 1; D3/D6 → 3; D4 → 4; D5 → 5; D7/D8 → 5; D9 → 6; D10 → 7.
- **Type consistency verified:** `rollupLegTarget` is defined in Task 1 and consumed by Tasks 2 and 4 under the same name and signature. `LegEvent.RETURN_FULL`/`RETURN_PARTIAL` are declared in Task 1, contributed in Task 2, fired in Task 4. `sendForApprovalSchema`'s shape is declared once in Task 3 and consumed by Task 9's dialog.
- **The `RETURN` split is load-bearing, not stylistic.** `findTransition` returns the first `(from, on)` match, so a single `RETURN` event could never resolve to both `FULLY_QUOTED` and `PARTIALLY_QUOTED`. Any attempt to "simplify" the two events back into one silently makes `PARTIALLY_QUOTED` unreachable and quietly breaks D4.
- **Ordering constraint:** Tasks 1 → 2 → 3 → 4 are strictly sequential (each consumes the previous). Task 5 depends on 2. Tasks 6, 7 and 8 are independent of one another. Task 9 depends on 3 and 8. Task 10 runs last because it holds the full `ci` gate.
