# Stage 5 · S5.9.1 — Compare-Screen Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Parent design: [`docs/Stage 5 - Approval Flow & Compare Screen Rework - Design.md`](../../Stage%205%20-%20Approval%20Flow%20%26%20Compare%20Screen%20Rework%20-%20Design.md).

**Goal:** Close nine review points the product owner raised against the delivered S5.9 screen — restore the recommendation marker, give the checker their own action bar with confirmations, collapse two leg statuses into one, compact the columnar table, and tell an executive when a leg is rejected.

**Architecture:** Frontend-only except for one notification dispatch. The recommendation marker moves from the *live* server ranking to the decision's **snapshotted** recommendation, which is already on the DTO — that is what makes it survive a send instead of needing suppression.

**Tech Stack:** React 18 + Vite + TanStack Query v5 + RHF + Zod + shadcn/Radix (`apps/web`); NestJS (`apps/api`, one dispatch); no schema change, no migration.

## Global Constraints

- **Vocabulary (D5, binding):** user-visible strings say **Approved / Quotation / Issue / Quoting client / Pending approval** — never "Awarded" or "Won". Nothing forwarder-facing may reveal a commercial outcome (`PENDING_APPROVAL` and `APPROVED` both render to a forwarder as "Under review").
- **RBAC unchanged in the API.** Maker writes stay auth-only; approve/reject stay Manager+ with four-eyes (`decision.sentByUserId === user.id` → 403). This plan changes only what the *UI* offers to whom.
- **No schema change, no migration.** If a task appears to need one, STOP and report.
- **Every owned status change goes through `StatusService.fire`.** Do not add bare Prisma writes to `leg.status` / `quote.status`.
- **New `@OnEvent` listeners and all comms dispatches MUST be wrapped in try/catch + log** — `fire()` awaits `emitAsync`, so a throwing listener fails the caller. Follow `ff-portal.service.ts`'s post-submit comms block.
- **No toast system.** Surface `ApiError` inline: `<p role="alert" className="text-sm text-destructive">{message}</p>` via the existing `errorMessage(error, fallback)` in `apps/web/src/features/compare/errorMessage.ts`.
- **After a mutation** invalidate `["comparison", queryId]` (+ `["query", queryId]` where query status changes). No optimistic writes.
- **Async-auth test trap:** `renderWithProviders`' `/api/auth/me` stub resolves asynchronously, so an assertion made synchronously after `render()` fires while `user` is `null` and proves nothing. Await a positive control first — the `AuthProbe` pattern in `CheckerPanel.test.tsx` (~lines 85-92). **Every absence assertion must be mutation-proven** (break it → red → revert → green) and the evidence reported.
- **Radix tooltips/dialogs have open delays.** Never assert absence by querying immediately after `userEvent.hover()` — that passes whether or not the trigger is wired. Assert structural signals (`data-state`, `tabindex`) instead. This exact vacuous test shipped once.
- `packages/shared` is CommonJS; rebuild (`pnpm --filter @svyft/shared build`) after editing or consumers see stale `dist/`.
- vitest and jest do NOT type-check — `pnpm run typecheck` is a separate required gate.
- API e2e: `set -a; . apps/api/.env; set +a`, Postgres on **port 5433**, `--runInBand`. Known flake (register C5): `award-generate.e2e-spec.ts`'s float test, occasionally `ff-portal-v3.e2e-spec.ts` and `charge-catalogue.e2e-spec.ts` — confirm any failure is that flake before treating it as a regression.
- `pnpm run ci` is green at branch tip (shared 390 · web 785 · api 443 / 93 suites) and must stay green.
- Commit per task. **Verify `git branch --show-current` before every commit** — expected `feat/stage-5-fx-master`.

## Decisions

| # | Decision | Why |
| :-- | :-- | :-- |
| **R1** | The `★` reads the decision's **snapshotted** recommendation (`decision.recommendedQuoteId` / `recommendedVariant`) when a decision exists, and the live `leg.recommendation` only when it does not. | S5.9 suppressed the marker entirely once a leg left `DRAFT`, because the server's live ranking covers only `QUOTED` quotes and would drift to a different forwarder after a send. The snapshot is the correct source and was already on the DTO — suppression treated the symptom. |
| **R2** | Recommended and sent-for-approval are **two independent signals**: `★` marks the recommendation, and the offer's own status cell reads "Pending Approval". | The product owner asked to tell them apart. Both are now always visible, and the pair reads correctly whether they are the same offer or different ones. |
| **R3** | **Negotiate is hidden for Manager/Admin.** Their path is Reject with a reason. | Product owner's call. Send for approval stays available to Manager+ so the four-eyes flow (one manager sends, another approves) survives. |
| **R4** | **The decision chip is removed entirely** from the leg header; `LegStatusBadge` is the single status. | Product owner's call — the two badges duplicated each other once leg status began carrying the approval flow. Accepted consequence: a rejected leg's row looks identical to one never sent; the reason stays inside the leg body and R7's notification is what surfaces it. |
| **R5** | Approve confirms in a dialog naming the forwarder; Reject collects its reason in a dialog. Both live in the action bar below the table. | Product owner's call. Approve is currently a single irreversible click with no confirmation. |
| **R6** | The columnar view's numeric cells align to match their header. | Alignment is shared between orientations, so values render right-aligned under centred offer headers — the "data not under the header" complaint. |
| **R7** | A new `award.rejected` **in-app** notification to all active Executives. | There is no assignment concept, so a rejected leg already returns to the general maker pool — but nothing announces it. Every other significant event has a notification; this one did not. |

## File Structure

| File | Responsibility | Task |
| :-- | :-- | :-- |
| `apps/web/src/features/compare/comparisonRowModel.ts` | Recommendation from the snapshot (R1); alignment split (R6). | 1, 3 |
| `apps/web/src/features/compare/CompareLegPanel.tsx` | Decision chip removed (R4); action bar gains checker controls, loses Negotiate for Manager+ (R3, R5). | 1, 2 |
| `apps/web/src/features/compare/CheckerPanel.tsx` → `ApproveDialog.tsx` / `RejectDialog.tsx` | Approve confirmation + reject-reason dialogs (R5). | 2 |
| `apps/web/src/features/compare/ComparisonGridColumns.tsx` | Density + alignment (R6). | 3 |
| `apps/api/src/modules/award/award.service.ts` | Dispatch `award.rejected` after a successful reject (R7). | 4 |
| `apps/api/src/seed/message-templates.seed.ts` + a data migration | The `award.rejected.inapp` template (R7). | 4 |

---

## Task 1: The recommendation marker survives a send; the duplicate leg status goes

**Files:**
- Modify: `apps/web/src/features/compare/comparisonRowModel.ts` (`buildComparisonRowModel`)
- Modify: `apps/web/src/features/compare/CompareLegPanel.tsx` (header badges, `DecisionChip`)
- Test: `apps/web/src/features/compare/comparisonRowModel.test.ts`, `ComparisonGrid.test.tsx`

**Interfaces:**
- Consumes: `LegComparisonDto.decision` — already carries `recommendedQuoteId`, `recommendedVariant`, `shortlistedQuoteId`, `shortlistedVariant`, `status` (`packages/shared/src/award.ts:52-60`).
- Produces: `buildComparisonRowModel` keeps its signature. `OfferCell.recommended` now means "this is the recommendation of record", true both before and after a send.

**Why (R1).** S5.9 set `recKey = null` whenever `decision.status !== "DRAFT"`, killing the `★`, the tint and the footnote together — so a checker reviewing a leg saw no recommendation at all. The reason for that suppression was real: the server's `buildRecommendation` ranks only `QUOTED` quotes, so after a send the live `leg.recommendation` can name a *different* forwarder. But the decision snapshots the recommendation at send time, which is both stable and correct. Read that instead.

- [ ] **Step 1: Write the failing tests**

In `comparisonRowModel.test.ts`:

```ts
it("marks the SNAPSHOTTED recommendation once a leg has been sent for approval", () => {
  const leg = legWith({
    offers: [offer("q1", "DEDICATED"), offer("q2", "DEDICATED")],
    // The live ranking has moved on — q1 left QUOTED when it was sent.
    recommendation: { quoteId: "q2", variant: "DEDICATED", reason: "cheapest now" },
    decision: {
      status: "PENDING_APPROVAL",
      recommendedQuoteId: "q1",
      recommendedVariant: "DEDICATED",
      shortlistedQuoteId: "q1",
      shortlistedVariant: "DEDICATED",
    },
  });
  const model = buildComparisonRowModel(leg, false);
  expect(model.recommendedKey).toBe(offerKey("q1", "DEDICATED"));
  expect(model.cells.find((c) => c.key === offerKey("q2", "DEDICATED"))!.recommended).toBe(false);
});

it("falls back to the live recommendation when no decision exists yet", () => {
  const leg = legWith({
    offers: [offer("q1", "DEDICATED"), offer("q2", "DEDICATED")],
    recommendation: { quoteId: "q2", variant: "DEDICATED", reason: "cheapest" },
    decision: null,
  });
  expect(buildComparisonRowModel(leg, false).recommendedKey).toBe(offerKey("q2", "DEDICATED"));
});

it("prefers the snapshot even on a DRAFT decision, so a returned leg keeps the mark it was judged against", () => {
  const leg = legWith({
    offers: [offer("q1", "DEDICATED"), offer("q2", "DEDICATED")],
    recommendation: { quoteId: "q2", variant: "DEDICATED", reason: "cheapest now" },
    decision: {
      status: "DRAFT",
      rejectionReason: "too slow",
      recommendedQuoteId: "q1",
      recommendedVariant: "DEDICATED",
      shortlistedQuoteId: null,
      shortlistedVariant: null,
    },
  });
  expect(buildComparisonRowModel(leg, false).recommendedKey).toBe(offerKey("q1", "DEDICATED"));
});

it("still suppresses the recommendation entirely once the award is locked", () => {
  const leg = legWith({
    offers: [offer("q1", "DEDICATED")],
    recommendation: { quoteId: "q1", variant: "DEDICATED", reason: "cheapest" },
    decision: { status: "APPROVED", recommendedQuoteId: "q1", recommendedVariant: "DEDICATED" },
  });
  expect(buildComparisonRowModel(leg, true).recommendedKey).toBeNull();
});

it("says nothing when a decision exists but snapshotted no recommendation", () => {
  const leg = legWith({
    offers: [offer("q1", "DEDICATED")],
    recommendation: { quoteId: "q1", variant: "DEDICATED", reason: "cheapest" },
    decision: { status: "PENDING_APPROVAL", recommendedQuoteId: null, recommendedVariant: null },
  });
  expect(buildComparisonRowModel(leg, false).recommendedKey).toBeNull();
});
```

Adapt `legWith` / `offer` to whatever fixture helpers the file already uses — read it first; do not invent new ones if equivalents exist.

In `ComparisonGrid.test.tsx`, for **both** orientations:

```ts
it.each(["columns", "rows"] as const)(
  "shows the recommendation AND the pending-approval status as separate signals (%s)",
  (viewMode) => {
    renderGrid({ viewMode, leg: legSentForApproval });
    expect(screen.getByTestId(`offer-recommended-${recommendedKey}`)).toHaveTextContent("★");
    expect(screen.getByTestId(`offer-status-${sentKey}`)).toHaveTextContent(/pending approval/i);
  },
);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @svyft/web test -- src/features/compare/
```

Expected: FAIL — `recommendedKey` is `null` for every case with a non-DRAFT decision, and the grid renders no `★`.

- [ ] **Step 3: Read the recommendation of record**

In `buildComparisonRowModel`, replace the `decisionLeftDraft` suppression with a snapshot-first resolution. Keep `locked` suppressing everything — that rule is unchanged and still correct (post-generate the winning quote is `APPROVED` and excluded from `offers` entirely).

```ts
export function buildComparisonRowModel(leg: LegComparisonDto, locked: boolean): ComparisonRowModel {
  // The recommendation OF RECORD (S5.9.1 R1). Once a decision exists it owns the answer: it
  // snapshotted `recommendedQuoteId` at send time, and that is both stable and what the maker
  // was actually judged against. The live `leg.recommendation` is only consulted before any
  // decision exists, because the server ranks `QUOTED` quotes only — so the moment an offer is
  // sent for approval it drops out of the ranking and the live value can name a DIFFERENT
  // forwarder. S5.9 handled that by suppressing the mark entirely, which left a checker with no
  // recommendation on screen at all; reading the snapshot is the fix that keeps it visible.
  const snapshot = leg.decision?.recommendedQuoteId
    ? offerKey(leg.decision.recommendedQuoteId, leg.decision.recommendedVariant)
    : null;
  const live = leg.recommendation
    ? offerKey(leg.recommendation.quoteId, leg.recommendation.variant)
    : null;
  const recKey = locked ? null : leg.decision != null ? snapshot : live;
  // …rest unchanged…
}
```

Note the deliberate shape: when a decision exists but snapshotted no recommendation, the answer is `null`, **not** a fall-back to the live value — the maker chose with no recommendation on offer, and inventing one after the fact would misrepresent the record.

- [ ] **Step 4: Check what the `★`'s tooltip says**

The mark's accessible name is built from `leg.recommendation.reason`, which is the *live* reason and may no longer correspond to the snapshotted offer. Read both grid components and make the mark render from whatever source `recommendedKey` came from — if the snapshot is in play and no stored reason exists, the mark must still render with a sensible accessible name rather than silently disappearing. Say in your report what you chose.

- [ ] **Step 5: Remove the decision chip (R4)**

In `CompareLegPanel.tsx`, delete `DecisionChip` and its `decisionBadge` helper, and drop it from the header — `LegStatusBadge` becomes the single status. The two duplicated each other ("Pending approval" beside "Pending Approval") once leg status began carrying the approval flow.

Keep the header's split structure from S5.9 T10 (a toggle `<button>` plus a trailing non-toggling badge area). If `LegStatusBadge` is now the only thing in that trailing area and it carries no tooltip, the area no longer needs to sit outside the button — but **do not** move it back inside without checking it introduces no focusable element there. Simplest correct outcome is preferred; say which you chose and why.

Delete the now-orphaned tooltip tests for the chip, and any `decision-chip` testids. **Do not** delete `MakerPanel`'s rejection alert — it is the executive's only on-screen cue and stays visible.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @svyft/web test -- src/features/compare/
```

Mutation-prove the two absence assertions (no decision chip; the `q2` cell is not recommended).

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm run typecheck
git branch --show-current
git add apps/web/src/features/compare
git commit -m "fix(s5.9.1): star reads the snapshotted recommendation; leg carries one status"
```

---

## Task 2: The checker gets an action bar, with confirmations

**Files:**
- Create: `apps/web/src/features/compare/ApproveDialog.tsx`, `RejectDialog.tsx` (+ tests)
- Modify: `apps/web/src/features/compare/CheckerPanel.tsx` (or delete it if the action bar absorbs it entirely)
- Modify: `apps/web/src/features/compare/CompareLegPanel.tsx`
- Test: `ComparisonGrid.test.tsx`, `CheckerPanel.test.tsx`

**Interfaces:**
- Consumes: `useApprove(queryId, legId)` and `useReject(queryId, legId)` from `useAwardActions.ts` — unchanged; `leg.decision.shortlistedQuoteId` / `shortlistedVariant` to name the forwarder.
- Produces: no API change.

**Requirements (R3, R5):**
1. **Approve and Reject move into the action bar below the grid**, beside Send for approval — the same row the maker's actions occupy, not a separate card in the body.
2. **Negotiate is hidden for `MANAGER` and `ADMINISTRATOR`.** Their path to a revised price is Reject with a reason. `Send for approval` stays available to them so the four-eyes flow survives.
3. **Approve opens a confirmation dialog** naming the forwarder: derive it from the shortlisted offer, e.g. "Approve **Bridge Logistics — Dedicated** for LEG-2?" with confirm and cancel. Never fire the mutation from the bar directly.
4. **Reject opens a dialog** collecting the reason (`rejectSchema`, `reason` required), replacing today's inline form.
5. Four-eyes stays: when `decision.sentByUserId === user.id`, both controls are **disabled with the visible hint**, not hidden — that rule is unchanged from S5.6 and its reasoning still holds (show the hint, don't hide the control).
6. Both controls appear only when there is something to check — `decision.status === "PENDING_APPROVAL"` — and only for Manager/Admin, exactly as `CheckerPanel` self-gates today.

- [ ] **Step 1: Write the failing tests**

```ts
it("offers Approve and Reject in the action bar for a manager, on a leg pending approval", async () => {
  renderPanel({ role: "MANAGER", leg: legPendingApproval });
  await screen.findByText("MANAGER"); // async-auth positive control
  const bar = screen.getByTestId("leg-action-bar");
  expect(within(bar).getByRole("button", { name: /approve/i })).toBeEnabled();
  expect(within(bar).getByRole("button", { name: /reject/i })).toBeEnabled();
});

it("does not offer Negotiate to a manager", async () => {
  renderPanel({ role: "MANAGER", leg: legPendingApproval });
  await screen.findByText("MANAGER");
  expect(screen.queryByRole("button", { name: /negotiate/i })).not.toBeInTheDocument();
});

it("still offers Negotiate to an executive", async () => {
  renderPanel({ role: "EXECUTIVE", leg: legDraft });
  await screen.findByText("EXECUTIVE");
  expect(screen.getByRole("button", { name: /negotiate/i })).toBeInTheDocument();
});

it("confirms the forwarder by name before approving", async () => {
  renderPanel({ role: "MANAGER", leg: legPendingApproval });
  await screen.findByText("MANAGER");
  await userEvent.click(screen.getByRole("button", { name: /approve/i }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent(/Bridge Logistics/);
  expect(approveMutate).not.toHaveBeenCalled();      // not fired by opening
  await userEvent.click(within(dialog).getByRole("button", { name: /^ok$/i }));
  await waitFor(() => expect(approveMutate).toHaveBeenCalledTimes(1));
});

it("cancelling the confirmation approves nothing", async () => {
  renderPanel({ role: "MANAGER", leg: legPendingApproval });
  await screen.findByText("MANAGER");
  await userEvent.click(screen.getByRole("button", { name: /approve/i }));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /cancel/i }));
  expect(approveMutate).not.toHaveBeenCalled();
});

it("collects a reason in a dialog before rejecting, and requires it", async () => {
  renderPanel({ role: "MANAGER", leg: legPendingApproval });
  await screen.findByText("MANAGER");
  await userEvent.click(screen.getByRole("button", { name: /reject/i }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: /reject/i }));
  expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
  expect(rejectMutate).not.toHaveBeenCalled();

  await userEvent.type(within(dialog).getByRole("textbox"), "Transit too long");
  await userEvent.click(within(dialog).getByRole("button", { name: /reject/i }));
  await waitFor(() => expect(rejectMutate).toHaveBeenCalledWith({ reason: "Transit too long" }));
});

it("disables both controls with a hint when the checker is the sender (four-eyes)", async () => {
  renderPanel({ role: "MANAGER", userId: SENDER_ID, leg: legPendingApprovalSentBy(SENDER_ID) });
  await screen.findByText("MANAGER");
  expect(screen.getByRole("button", { name: /approve/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /reject/i })).toBeDisabled();
  expect(screen.getByText(/another manager must decide/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @svyft/web test -- src/features/compare/
```

- [ ] **Step 3: Build the two dialogs**

`ApproveDialog` is a confirmation: title naming the leg, body naming the forwarder and variant resolved from `decision.shortlistedQuoteId`/`shortlistedVariant` against `leg.offers`, `OK` and `Cancel`. If the shortlisted offer cannot be resolved from the read model, say so plainly in the dialog and disable `OK` rather than approving something you cannot name.

`RejectDialog` uses `react-hook-form` + `zodResolver(rejectSchema)` with a required `reason` textarea, mirroring the field handling in `SendForApprovalDialog`. Both surface `ApiError` inline via `errorMessage(...)`, and neither closes while its mutation is in flight.

- [ ] **Step 4: Wire the action bar**

In `CompareLegPanel.tsx`, give the action bar `data-testid="leg-action-bar"` and compose it by role:

```tsx
const isChecker = user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER;
const canCheck = isChecker && leg.decision?.status === "PENDING_APPROVAL";
```

Negotiate renders only when `!isChecker` (R3). Send for approval keeps its existing `canSend` gate for everyone (R3 — four-eyes needs Manager+ to be able to send). Approve/Reject render when `canCheck`, disabled with the four-eyes hint when `decision.sentByUserId === user.id`.

Then either reduce `CheckerPanel` to nothing and delete it, or keep it solely as the four-eyes hint — whichever leaves less dead code. State which and why. Port `CheckerPanel.test.tsx`'s four-eyes and role-gating coverage; **do not delete it** — that rule has been load-bearing since S5.6.

- [ ] **Step 5: Run the tests, mutation-proving each absence assertion**

```bash
pnpm --filter @svyft/web test -- src/features/compare/
```

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm run typecheck
git branch --show-current
git add apps/web/src/features/compare
git commit -m "feat(s5.9.1): checker actions move into the action bar, behind confirmations"
```

---

## Task 3: Compact the columnar table and align it under its headers

**Files:**
- Modify: `apps/web/src/features/compare/comparisonRowModel.ts` (`METRIC_CELL_CLASS`)
- Modify: `apps/web/src/features/compare/ComparisonGridColumns.tsx`, `ComparisonGridRows.tsx`
- Test: `apps/web/src/features/compare/ComparisonGrid.test.tsx`

**The diagnosis (R6), so you fix the cause and not the symptom.** `METRIC_CELL_CLASS` is a single map shared by both orientations, and every metric is `text-right`. That is correct in the **rows** view, where each metric is a column with a right-aligned header above it. It is wrong in the **columns** view, where a metric is a *row* and the header above each value is the centred offer/variant — so the numbers hug the right edge of a centred column and read as detached from their heading. Compounding it, `table.tsx`'s header cell is `h-12 px-4`, and the table is `w-full`, so with a handful of offers every column stretches and the whitespace the product owner is describing appears between the data and its header.

Fix both: make alignment orientation-aware, and tighten the density. Do **not** simply centre everything in the shared map — that would break the rows view, which is currently correct.

- [ ] **Step 1: Write the failing tests**

```ts
it("aligns metric values under their offer header in the columns view", () => {
  renderGrid({ viewMode: "columns" });
  expect(screen.getByTestId(`offer-usd-${cellKey}`).className).toContain("text-center");
});

it("keeps metric values right-aligned in the rows view, under right-aligned headers", () => {
  renderGrid({ viewMode: "rows" });
  expect(screen.getByTestId(`offer-usd-${cellKey}`).className).toContain("text-right");
});

it("keeps the numeric font in both orientations", () => {
  for (const viewMode of ["columns", "rows"] as const) {
    const { unmount } = renderGrid({ viewMode });
    expect(screen.getByTestId(`offer-usd-${cellKey}`).className).toContain("tabular-nums");
    unmount();
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @svyft/web test -- src/features/compare/ComparisonGrid.test.tsx
```

- [ ] **Step 3: Split alignment from the rest of the cell class**

Keep one source of truth. Separate the *alignment* from the type treatment so the shared map keeps everything the two orientations must agree on (font, tabular numerals, muting) and only alignment varies:

```ts
/** Type treatment every orientation shares — font, numerals, muting. Alignment is deliberately
 *  NOT here: a metric is a column in the rows view (right-aligned under a right-aligned header)
 *  and a row in the columns view (centred under a centred offer header), and forcing one
 *  alignment on both is what left values reading as detached from their heading (S5.9.1 R6). */
export const METRIC_CELL_CLASS: Record<MetricId, string> = {
  usdTotal: "font-mono tabular-nums",
  nativeTotal: "font-mono tabular-nums",
  rate: "font-mono tabular-nums text-muted-foreground",
  transit: "text-muted-foreground",
  validUntil: "text-muted-foreground",
};

/** Alignment by orientation — applied alongside `METRIC_CELL_CLASS` by each grid component. */
export const METRIC_ALIGN = { columns: "text-center", rows: "text-right" } as const;
```

Apply `METRIC_ALIGN.columns` in `ComparisonGridColumns` and `METRIC_ALIGN.rows` in `ComparisonGridRows`. The metric **label** column in the columns view stays left-aligned.

- [ ] **Step 4: Tighten the density**

Reduce the vertical and horizontal weight of the comparison table specifically — **do not change `components/ui/table.tsx`**, which is shared with every other table in the app. Apply the tightening via className on the comparison grid's own cells and headers (e.g. a shorter row height and `px-2`/`px-3` in place of `px-4`), and stop the table stretching where it has few columns.

Judge the result by eye as well as by test: run the dev server, open a leg in the columnar view, and confirm the numbers sit under their headings with no dead space between them. Report what you changed and what it looks like.

- [ ] **Step 5: Run the tests, then verify visually**

```bash
pnpm --filter @svyft/web test -- src/features/compare/
pnpm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add apps/web/src/features/compare
git commit -m "fix(s5.9.1): comparison table aligns under its headers and reads denser"
```

---

## Task 4: Tell an executive when a leg is rejected, then run the gate

**Files:**
- Modify: `apps/api/src/modules/award/award.service.ts` (`reject`)
- Modify: `apps/api/src/seed/message-templates.seed.ts`
- Create: `prisma/migrations/<timestamp>_s591_award_rejected_template/migration.sql`
- Test: `apps/api/test/award-workflow-checker.e2e-spec.ts`
- Modify: `docs/Stage 5 - Session Handoff.md`

**Why (R7).** There is no assignment concept in the schema, and `reject` already clears `sentByUserId` and returns the decision to `DRAFT` — so a rejected leg genuinely returns to the general maker pool rather than sitting with whoever sent it. That is the routing the product owner asked for and it already works. What is missing is that **nothing announces it**: every other significant event has a notification (`quote.received.inapp`, `rfq.expiry.inapp`, `rfq.requote_requested.inapp`) and a rejected leg goes silent.

**The precedent to follow exactly** is `ff-portal.service.ts`'s post-submit comms block: resolve `user.findMany({ where: { role: Role.EXECUTIVE, isActive: true }, select: { id: true } })`, dispatch with `recipients: { IN_APP: execIds }`, and wrap the whole comms section in `try/catch` + `logger.error` so a comms failure can never fail the reject itself.

- [ ] **Step 1: Write the failing test**

In `award-workflow-checker.e2e-spec.ts`:

```ts
it("notifies executives in-app when a leg is rejected", async () => {
  await sendForApproval(legId, recommendedQuoteId);
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId}/reject`)
    .set("Cookie", managerCookie)
    .send({ reason: "Transit too long" })
    .expect(201);

  const notes = await prisma.notification.findMany({
    where: { type: "award.rejected", entityId: queryId },
  });
  expect(notes.length).toBeGreaterThan(0);
  expect(notes.every((n) => n.recipientUserId != null)).toBe(true);
});

it("still rejects successfully when the notification dispatch fails", async () => {
  // Prove the comms block cannot fail the reject: delete the template so lookup returns null.
  await prisma.messageTemplate.deleteMany({ where: { key: "award.rejected.inapp" } });
  await sendForApproval(legId2, quoteId2);
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/legs/${legId2}/reject`)
    .set("Cookie", managerCookie)
    .send({ reason: "Price too high" })
    .expect(201);
  const decision = await prisma.legAwardDecision.findUniqueOrThrow({ where: { legId: legId2 } });
  expect(decision.status).toBe("DRAFT");
});
```

Reseed the template in this file's `afterAll` if you delete it, so the suite is order-independent.

- [ ] **Step 2: Run it to verify it fails**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- award-workflow-checker.e2e-spec.ts --runInBand
```

- [ ] **Step 3: Seed the template**

In `message-templates.seed.ts`:

```ts
  // S5.9.1 (R7) — a rejected leg returns to the general maker pool (reject clears sentByUserId
  // and writes the decision back to DRAFT), but nothing announced it. IN_APP only: the executive
  // is inside the app, and there is no forwarder-facing side to this event.
  {
    key: "award.rejected.inapp", eventKey: "award.rejected", channel: "IN_APP",
    subject: null,
    body: "{{Leg_Code}} on {{Query_Code}} was rejected — {{Reason}}",
  },
```

- [ ] **Step 4: Deliver it to already-seeded databases**

The seed's upsert is **create-only** (`update: {}`), so a new template row reaches a fresh database but an existing one keeps whatever it has — and a brand-new key is created, so this case is fine for the row itself. Verify that by reading the seed before assuming. If a deployed database would not receive the new row, add a targeted data migration as S5.9 did for the re-quote copy.

**`prisma migrate dev` does not work in this shell.** Derive with `prisma migrate diff --shadow-database-url <scratch-db>`, hand-write the `migration.sql`, apply with `prisma migrate deploy`, and **strip the ~10 unrelated `ALTER COLUMN "id" DROP DEFAULT` statements** the repo's pre-existing drift (register C3) will put in any derived diff.

- [ ] **Step 5: Dispatch after a successful reject**

In `reject()`, after the decision transaction commits and the status fires have completed, add the comms block. It must be the **last** thing the method does and must not run if any earlier step threw.

- [ ] **Step 6: Run the api suite**

```bash
set -a; . apps/api/.env; set +a; pnpm --filter @svyft/api test -- --runInBand
```

- [ ] **Step 7: Run the full gate**

```bash
pnpm --filter @svyft/shared build
set -a; . apps/api/.env; set +a; pnpm run ci
```

Expected green. Known flakes (register C5): `award-generate.e2e-spec.ts`'s float test, `ff-portal-v3.e2e-spec.ts`, `charge-catalogue.e2e-spec.ts` — re-run to confirm and report rather than "fix".

- [ ] **Step 8: Update the handoff**

In `docs/Stage 5 - Session Handoff.md`, add an S5.9.1 entry recording: the nine review points and which are now closed; **R1's correction** — that S5.9 suppressed the recommendation marker rather than reading the snapshot the decision already carried, so a checker saw no recommendation at all; **R4's accepted consequence** — a rejected leg's header row is now indistinguishable from one never sent, with the reason inside the body and the new notification as the surfacing mechanism; and **R7** — that rejection routing already returned a leg to the general maker pool and what was missing was only the announcement.

- [ ] **Step 9: Commit**

```bash
git branch --show-current
git add apps/api prisma "docs/Stage 5 - Session Handoff.md"
git commit -m "feat(s5.9.1): rejecting a leg notifies executives; handoff updated"
```

---

## Task 5: Mark the offer that went for approval, from the decision

**Files:**
- Modify: `apps/web/src/features/compare/comparisonRowModel.ts`
- Modify: `apps/web/src/features/compare/ComparisonGridColumns.tsx`, `ComparisonGridRows.tsx`
- Test: `comparisonRowModel.test.ts`, `ComparisonGrid.test.tsx`

**Interfaces:**
- Consumes: `leg.decision.shortlistedQuoteId` / `shortlistedVariant` — already on the DTO and already used by `ApproveDialog`.
- Produces: `OfferCell` gains a boolean for "this is the offer that went for approval". `buildComparisonRowModel` keeps its signature.

**Why this exists (found by live inspection, not by a test).** The product owner's point 2 was *"how will Manager know which one is shortlisted... need a way to identify difference between Recommended vs came for Approval"*. The answer so far has been indirect: the selected offer's **quote status** reads "Pending Approval" while its rivals read "Quoted". That works only when the quote status and the decision agree — and they can drift. Observed live on `S56VIS-0001`: `decision.status = PENDING_APPROVAL` with `shortlistedQuoteId` set, while that quote's `quoteStatus` was still `QUOTED`, so **nothing on screen identified the offer under review**. That particular row is stale pre-S5.9 seed data rather than a code defect — the real endpoint fires the quote transition and there is e2e proof — but it demonstrates that a second-hand signal is the wrong source for a decision-critical marker.

`decision.shortlistedQuoteId` is the authoritative record, it is already on the payload, and Task 1 has just established exactly this pattern for the recommendation. Use the same source, so the two markers are symmetric and neither can drift.

**Requirements:**
1. The offer named by `decision.shortlistedQuoteId` / `shortlistedVariant` is marked in **both** orientations, whenever a decision exists and names one — independent of that offer's quote status.
2. **Recommended and sent-for-approval remain visually distinct**, and an offer that is both must read as both. Do not overload the `★`.
3. The marker must carry an accessible name, not be colour or glyph alone.
4. `locked` suppresses it, consistently with the recommendation — post-generate the award panel below is the authority.
5. Explain what the marker means, the way the `★` footnote does. Keep the two explanations together rather than adding a second stray line.

**Judgement call to make and justify:** the glyph/treatment for "went for approval", and whether the existing footnote grows a second line or the two share one. Keep it legible next to the `★` and inside a table that Task 3 just made deliberately dense.

- [ ] **Step 1: Write the failing tests** — cover: marked when the decision names it; NOT marked on any other offer; marked even when that offer's `quoteStatus` is still `QUOTED` (the drift case above — this is the test that would have caught the gap); an offer that is both recommended and sent reads as both; nothing marked when `decision` is null or `shortlistedQuoteId` is null; nothing marked when `locked`. Both orientations.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @svyft/web test -- src/features/compare/`
- [ ] **Step 3: Derive the flag in `buildComparisonRowModel`**, beside the recommendation resolution, so both markers read from the decision in one place.
- [ ] **Step 4: Render it in both grid components** with its accessible name, and extend the explanation.
- [ ] **Step 5: Run the tests, mutation-proving every absence assertion** (break the condition → red → revert → green).
- [ ] **Step 6: Typecheck, then commit.** `pnpm run typecheck`; verify `git branch --show-current` first.

---

## Self-review notes

- **Coverage of the nine points:** #1 and #2 → Task 1 (R1/R2); #3 → Task 2 (R3); #4, #5, #6 → Task 2 (R5); #7 → **already delivered in S5.9**, no task — reject restores the status the leg actually left via `legStatusWhenSentForApproval`, including the partially-quoted case a naive fix gets wrong; #8 → Task 3 (R6); #9 → Task 1 (R4). Plus R7's notification in Task 4.
- **Ordering:** Tasks 1 and 2 both edit `CompareLegPanel.tsx` and must run in order. Task 3 is independent of both but touches `comparisonRowModel.ts`, which Task 1 also edits — run it after Task 1. Task 4 is backend-only and independent, but holds the full gate, so it runs last.
- **Type consistency:** `METRIC_CELL_CLASS` keeps its `Record<MetricId, string>` type and its exhaustiveness check; `METRIC_ALIGN` is a new sibling export, not a change to the existing map's shape. `buildComparisonRowModel` keeps its exact signature so no caller changes.
- **The one thing most likely to be got wrong:** Task 1's snapshot resolution has three distinct branches — decision absent (use live), decision present with a snapshot (use it), decision present with a null snapshot (use nothing). The third is deliberate and is pinned by its own test; collapsing it into a fall-back to the live value would misrepresent what the maker actually chose against.
