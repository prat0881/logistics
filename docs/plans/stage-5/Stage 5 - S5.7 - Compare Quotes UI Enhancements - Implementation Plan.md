# Stage 5 · S5.7 — Compare Quotes UI Enhancements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Design of record: [`docs/Stage 5 - Compare Quotes UI Enhancements - Design.md`](../../Stage%205%20-%20Compare%20Quotes%20UI%20Enhancements%20-%20Design.md). Parent design: `docs/Stage 5 - Compare Quotes - Design.md` §9/§11/§12/§4/§13/§16.

**Goal:** Rework the Compare Quotes screen (`/queries/:id/compare`) into a grid-first comparison — two switchable orientations, recommendation by colour, conversion rate on show, charge detail and both maker actions moved into dialogs — with no backend change.

**Architecture:** One pure row-model module derives every display cell from `LegComparisonDto`; two presentation components render that model as columns or rows, so the orientations cannot drift. Three dialogs (charge breakdown, shortlist+send, multi-forwarder negotiate) replace the inline detail block and the two stacked maker sections.

**Tech Stack:** React 18 + Vite + TanStack Query v5 + RHF + Zod + shadcn/Radix + Tailwind (`apps/web` only). Tests: vitest + @testing-library.

## Global Constraints

- **FRONTEND ONLY.** No changes to `apps/api`, `packages/shared`, `prisma/`, or any DTO. If a task appears to need one, STOP and report — do not add it.
- **Read model is the source of truth.** Render decision/shortlist/timeline state from `GET …/comparison`; never infer client-side.
- **No toast system.** Surface `ApiError` inline: `<p role="alert" className="text-sm text-destructive">{message}</p>`. Use the existing `errorMessage(error, fallback)` from `apps/web/src/features/compare/errorMessage.ts` — never re-paste it.
- **After a mutation** invalidate `["comparison", queryId]` (+ `["query", queryId]` where query status changes). No optimistic writes.
- **RBAC unchanged.** Maker Executive+; Approve/Reject Manager+ with four-eyes disable when `decision.sentByUserId === user.id`; **Generate Manager+ with NO four-eyes** (§16 O4); Reopen ungated.
- **`locked` (award frozen) must keep unmounting** `MakerPanel`/`CheckerPanel`/`GenerateGate` and must suppress the recommendation highlight.
- **Unpriced offers never render `$0`** and are never interactive.
- **Async-auth test trap:** `renderWithProviders`' `/api/auth/me` stub resolves asynchronously. Any assertion made synchronously after `render()` fires while `user` is `null` and proves nothing. Await a positive control first — use the `AuthProbe` pattern in `CheckerPanel.test.tsx:85-92`. **Every absence assertion must be mutation-proven** (break the condition → red → revert → green) and the evidence reported.
- Run `pnpm run typecheck` per task (vitest does **not** type-check). Web tests: `pnpm --filter @svyft/web test`. Lint: `pnpm --filter @svyft/web lint`. Full `pnpm run ci` on Task 6 only.
- Commit per task. Verify `git branch --show-current` before every commit.

---

## File Structure

All paths under `apps/web/src/features/compare/`.

| File | Responsibility | Task |
| :-- | :-- | :-- |
| `comparisonRowModel.ts` *(new)* | Pure: `LegComparisonDto` → display cells + metric definitions. Single source for both orientations. | 1 |
| `ComparisonGridColumns.tsx` *(new)* | Renders the model as offers-in-columns. | 1 |
| `ComparisonGridRows.tsx` *(new)* | Renders the model as offers-in-rows. | 2 |
| `ComparisonGrid.tsx` *(modify)* | Thin dispatcher on `viewMode` + the toggle. | 1, 2 |
| `useViewMode.ts` *(new)* | `localStorage`-backed view-mode preference. | 2 |
| `chargeTree.ts` *(new)* | Pure: `OfferChargeLineDto[]` → `ChargeNode[]`. | 3 |
| `ChargeBreakdownDialog.tsx` *(new)* | Tree-shaped charge dialog, one offer. | 3 |
| `OfferDetail.tsx` *(delete)* | Replaced by the dialog. | 3 |
| `ShortlistDialog.tsx` *(new)* | Shortlist + optional send-for-approval, one dialog. | 4 |
| `MakerPanel.tsx` *(shrink)* | Locked-state messaging + rejection alert only. | 4 |
| `NegotiateDialog.tsx` *(rewrite)* | Leg-level multi-forwarder re-quote request. | 5 |
| `RecommendationBanner.tsx` *(delete)* | Superseded by the colour tint. | 1 |
| `CompareLegPanel.tsx` *(modify)* | Offers line (count + toggle + Negotiate), dialog wiring. | 1–5 |
| `useAwardActions.ts` *(modify)* | Add `useRequestRequoteBatch`. | 5 |

---

## Task 1: Row model, conversion rate, recommendation by colour

**Files:**
- Create: `apps/web/src/features/compare/comparisonRowModel.ts`
- Create: `apps/web/src/features/compare/comparisonRowModel.test.ts`
- Create: `apps/web/src/features/compare/ComparisonGridColumns.tsx`
- Modify: `apps/web/src/features/compare/ComparisonGrid.tsx`
- Modify: `apps/web/src/features/compare/CompareLegPanel.tsx`
- Delete: `apps/web/src/features/compare/RecommendationBanner.tsx`
- Test: `apps/web/src/features/compare/ComparisonGrid.test.tsx` (existing — update)

**Interfaces:**
- Consumes: `LegComparisonDto`, `OfferDto` from `@svyft/shared`; `offerKey`, `STALE_OFFER_LABEL` currently exported from `ComparisonGrid.tsx`.
- Produces (Tasks 2–5 depend on these exact names):
  ```ts
  export interface OfferCell {
    key: string;                 // offerKey(quoteId, variant)
    offer: OfferDto;
    recommended: boolean;        // false whenever locked
    stale: boolean;              // quoteStatus === "REQUOTED"
  }
  export interface ForwarderGroup {
    freightForwarderId: string;
    freightForwarderName: string;
    cells: OfferCell[];
  }
  export interface ComparisonRowModel {
    groups: ForwarderGroup[];
    cells: OfferCell[];          // flat, same order as groups flattened
    recommendedKey: string | null;
  }
  export function buildComparisonRowModel(leg: LegComparisonDto, locked: boolean): ComparisonRowModel;
  export interface MetricDef { id: string; label: string; render(cell: OfferCell): string; }
  export const METRICS: MetricDef[];   // usdTotal, nativeTotal, rate, transit, validUntil
  ```
- `offerKey` moves to `comparisonRowModel.ts` and is re-exported from `ComparisonGrid.tsx` so existing importers keep working.

- [ ] **Step 1: Write the failing row-model test**

Create `comparisonRowModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildComparisonRowModel, METRICS, offerKey } from "./comparisonRowModel";
import type { LegComparisonDto, OfferDto } from "@svyft/shared";

const offer = (o: Partial<OfferDto>): OfferDto => ({
  quoteId: "q1", freightForwarderId: "ff1", freightForwarderName: "Bridge",
  variant: "DEDICATED", variantLabel: "Dedicated", priced: true,
  nativeTotal: 6700, currency: "AED", unitsPerUsd: 3.6725, usdTotal: 1824.37,
  transitDays: 3, chargeableWeightKg: 100, validUntil: "2026-09-16T00:00:00.000Z",
  quoteStatus: "QUOTED", charges: [], ...o,
});

const leg = (offers: OfferDto[], recommendation: LegComparisonDto["recommendation"] = null) =>
  ({ legId: "l1", legCode: "L1", mode: "ROAD", origin: "A", destination: "B",
     offers, pendingForwarders: [], awaitingReQuote: false,
     recommendation, decision: null, timeline: [] }) as LegComparisonDto;

describe("buildComparisonRowModel", () => {
  it("groups a forwarder's variants under one group", () => {
    const m = buildComparisonRowModel(
      leg([offer({}), offer({ variant: "GROUPAGE", variantLabel: "Groupage" })]), false);
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0].freightForwarderName).toBe("Bridge");
    expect(m.groups[0].cells).toHaveLength(2);
    expect(m.cells).toHaveLength(2);
  });

  it("marks the recommended cell by (quoteId, variant)", () => {
    const m = buildComparisonRowModel(
      leg([offer({}), offer({ variant: "GROUPAGE", variantLabel: "Groupage" })]),
      false);
    expect(m.recommendedKey).toBeNull();

    const withRec = buildComparisonRowModel(
      leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "fastest" }), false);
    expect(withRec.recommendedKey).toBe(offerKey("q1", "DEDICATED"));
    expect(withRec.cells[0].recommended).toBe(true);
  });

  it("suppresses the recommendation entirely when locked", () => {
    const m = buildComparisonRowModel(
      leg([offer({})], { quoteId: "q1", variant: "DEDICATED", reason: "fastest" }), true);
    expect(m.recommendedKey).toBeNull();
    expect(m.cells[0].recommended).toBe(false);
  });

  it("renders the conversion rate metric, and an em-dash when absent", () => {
    const rate = METRICS.find((x) => x.id === "rate")!;
    const m = buildComparisonRowModel(leg([offer({}), offer({ quoteId: "q2", unitsPerUsd: null, variant: "GROUPAGE" })]), false);
    expect(rate.render(m.cells[0])).toBe("3.67250");
    expect(rate.render(m.cells[1])).toBe("—");
  });

  it("never renders a money figure for an unpriced offer", () => {
    const usd = METRICS.find((x) => x.id === "usdTotal")!;
    const m = buildComparisonRowModel(leg([offer({ priced: false, usdTotal: null, nativeTotal: 0 })]), false);
    expect(usd.render(m.cells[0])).toBe("—");
    expect(usd.render(m.cells[0])).not.toContain("$0");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @svyft/web test -- comparisonRowModel`
Expected: FAIL — cannot resolve `./comparisonRowModel`.

- [ ] **Step 3: Implement the row model**

Create `comparisonRowModel.ts`. Move `offerKey` here from `ComparisonGrid.tsx` verbatim (it is `(quoteId, variant) => \`${quoteId}::${variant ?? ""}\`` — copy the existing implementation exactly; changing the separator breaks persisted nothing but does break in-flight comparisons in tests). Then:

```ts
export function buildComparisonRowModel(leg: LegComparisonDto, locked: boolean): ComparisonRowModel {
  const recKey =
    !locked && leg.recommendation
      ? offerKey(leg.recommendation.quoteId, leg.recommendation.variant)
      : null;

  const groups: ForwarderGroup[] = [];
  for (const offer of leg.offers) {
    const key = offerKey(offer.quoteId, offer.variant);
    const cell: OfferCell = {
      key, offer,
      recommended: recKey != null && key === recKey,
      stale: offer.quoteStatus === "REQUOTED",
    };
    const existing = groups.find((g) => g.freightForwarderId === offer.freightForwarderId);
    if (existing) existing.cells.push(cell);
    else groups.push({
      freightForwarderId: offer.freightForwarderId,
      freightForwarderName: offer.freightForwarderName,
      cells: [cell],
    });
  }
  return { groups, cells: groups.flatMap((g) => g.cells), recommendedKey: recKey };
}

export const METRICS: MetricDef[] = [
  { id: "usdTotal", label: "Total (USD)",
    render: (c) => (c.offer.priced ? fmtUsd(c.offer.usdTotal) : "—") },
  { id: "nativeTotal", label: "Total (native)",
    render: (c) => (c.offer.priced ? fmtNative(c.offer.nativeTotal, c.offer.currency) : "—") },
  { id: "rate", label: "Rate (per USD)",
    render: (c) => (c.offer.unitsPerUsd == null ? "—" : c.offer.unitsPerUsd.toFixed(5)) },
  { id: "transit", label: "Transit",
    render: (c) => (c.offer.transitDays == null ? "—" : `${c.offer.transitDays} d`) },
  { id: "validUntil", label: "Valid until",
    render: (c) => (c.offer.validUntil ? formatDate(c.offer.validUntil) : "—") },
];
```

Import `fmtUsd`/`fmtNative` from `./money` and the existing date helper from `@/lib/dates` (use whichever function `ComparisonGrid.tsx` currently uses for `validUntil` — do not introduce a new one).

- [ ] **Step 4: Run the row-model test to confirm it passes**

Run: `pnpm --filter @svyft/web test -- comparisonRowModel`
Expected: PASS, 5 tests.

- [ ] **Step 5: Rewrite the columns view against the model**

Create `ComparisonGridColumns.tsx` taking `{ model: ComparisonRowModel; leg: LegComparisonDto; onOpenBreakdown(cell): void }`. Render:
- a forwarder header row — one `<th colSpan={group.cells.length}>` per group, carrying `className="border-r-2 border-border"` on the **last** cell of each group (this is the explicit forwarder separator that item 1 asks for and S5.6 T3 deliberately omitted);
- a variant sub-header row;
- one row per `METRICS` entry, plus the existing Status row;
- the recommended column tinted on **every** cell via `cell.recommended && "bg-emerald-500/10"`, and a `★ Recommended` badge on its Status cell whose `title` is `leg.recommendation.reason`;
- unpriced cells greyed and **non-interactive** (no button, no click handler) — carry over the existing guard verbatim.

Reduce `ComparisonGrid.tsx` to: build the model, render `<ComparisonGridColumns/>`, re-export `offerKey` and `STALE_OFFER_LABEL`.

- [ ] **Step 6: Delete the banner**

Delete `RecommendationBanner.tsx`. Remove its import and its `{!locked && <RecommendationBanner …/>}` usage from `CompareLegPanel.tsx`. Confirm nothing else imports it:

Run: `grep -rn "RecommendationBanner" apps/web/src`
Expected: no matches.

- [ ] **Step 7: Update the grid test**

In `ComparisonGrid.test.tsx`: delete assertions that referenced the banner's text; add
- the recommended column carries the tint class on more than one cell (not just the header),
- a `Rate (per USD)` row exists showing `3.67250`,
- the forwarder separator class appears exactly once per forwarder group.

Keep every existing assertion about unpriced `—`, the stale badge, and column identity.

- [ ] **Step 8: Run the full web suite, lint, typecheck**

Run: `pnpm --filter @svyft/web test && pnpm --filter @svyft/web lint && pnpm run typecheck`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/compare
git commit -m "feat(stage5): comparison row model + conversion rate + recommendation by colour (S5.7)"
```

---

## Task 2: Rows orientation and the view toggle

**Files:**
- Create: `apps/web/src/features/compare/ComparisonGridRows.tsx`
- Create: `apps/web/src/features/compare/useViewMode.ts`
- Create: `apps/web/src/features/compare/useViewMode.test.ts`
- Modify: `apps/web/src/features/compare/ComparisonGrid.tsx`
- Modify: `apps/web/src/features/compare/CompareLegPanel.tsx`
- Test: `apps/web/src/features/compare/ComparisonGrid.test.tsx`

**Interfaces:**
- Consumes: `buildComparisonRowModel`, `METRICS`, `OfferCell` (Task 1).
- Produces: `export type ViewMode = "columns" | "rows";` and `export function useViewMode(): [ViewMode, (m: ViewMode) => void];` — Task 4 renders its Select cell in **both** views.

- [ ] **Step 1: Write the failing parity test**

Add to `ComparisonGrid.test.tsx` a `describe.each` that runs the same fixture through both modes:

```ts
describe.each(["columns", "rows"] as const)("ComparisonGrid — %s view", (mode) => {
  it("shows every priced offer's USD total, rate and transit", async () => {
    renderGrid({ viewMode: mode });
    expect(await screen.findByText("$1,824.37")).toBeInTheDocument();
    expect(screen.getByText("3.67250")).toBeInTheDocument();
    expect(screen.getByText("3 d")).toBeInTheDocument();
  });

  it("flags the recommended offer and never prints $0 for an unpriced one", async () => {
    renderGrid({ viewMode: mode });
    expect(await screen.findByText(/recommended/i)).toBeInTheDocument();
    expect(screen.getByTestId("comparison-grid")).not.toHaveTextContent("$0.00");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @svyft/web test -- ComparisonGrid`
Expected: FAIL — `viewMode` prop unknown / rows view renders nothing.

- [ ] **Step 3: Implement `useViewMode`**

```ts
const KEY = "svyft.compare.viewMode";
export type ViewMode = "columns" | "rows";

export function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem(KEY) === "rows" ? "rows" : "columns";
    } catch {
      return "columns"; // private-mode / storage-disabled browsers must not crash the screen
    }
  });
  const set = useCallback((m: ViewMode) => {
    setMode(m);
    try { localStorage.setItem(KEY, m); } catch { /* preference is best-effort */ }
  }, []);
  return [mode, set];
}
```

- [ ] **Step 4: Implement the rows view**

Create `ComparisonGridRows.tsx` — same props as `ComparisonGridColumns`. One `<tr>` per `model.cells` entry; columns are `Forwarder / variant` then one per `METRICS` entry, then Status. Recommended row tinted with the same class. Group rows by forwarder with the forwarder name shown once and subsequent variants indented/muted. Unpriced rows non-interactive, same guard.

Make `ComparisonGrid.tsx` dispatch on a new `viewMode: ViewMode` prop (defaulted so existing tests that omit it still render columns), and render the toggle in `CompareLegPanel`'s offers line using `useViewMode`.

- [ ] **Step 5: Run tests, lint, typecheck**

Run: `pnpm --filter @svyft/web test && pnpm --filter @svyft/web lint && pnpm run typecheck`
Expected: green, including both `describe.each` branches.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/compare
git commit -m "feat(stage5): switchable columns/rows comparison views (S5.7)"
```

---

## Task 3: Charge breakdown dialog

**Files:**
- Create: `apps/web/src/features/compare/chargeTree.ts`
- Create: `apps/web/src/features/compare/chargeTree.test.ts`
- Create: `apps/web/src/features/compare/ChargeBreakdownDialog.tsx`
- Create: `apps/web/src/features/compare/ChargeBreakdownDialog.test.tsx`
- Delete: `apps/web/src/features/compare/OfferDetail.tsx`
- Modify: `apps/web/src/features/compare/CompareLegPanel.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface ChargeNode {
    id: string; label: string;
    nativeAmount: number; usdAmount: number | null;
    children: ChargeNode[];      // always present; empty today
  }
  export function buildChargeTree(lines: OfferChargeLineDto[]): ChargeNode[];
  ```

**⚠ Read the design's C2 before starting.** The API returns at most three flat aggregate lines (`Freight`, `Additional Charges`, `Warehousing`) — `Additional Charges` is a single sum over every origin/destination/ad-hoc charge. **There are no child lines and you cannot invent them.** Build the component tree-shaped so real children slot in later without a rewrite; today every node has `children: []`.

- [ ] **Step 1: Write the failing tree test**

```ts
import { describe, expect, it } from "vitest";
import { buildChargeTree } from "./chargeTree";

const lines = [
  { group: "freight", label: "Freight", nativeAmount: 4200, usdAmount: 1143.63 },
  { group: "additional", label: "Additional Charges", nativeAmount: 2100, usdAmount: 571.82 },
  { group: "warehouse", label: "Warehousing", nativeAmount: 400, usdAmount: 108.92 },
];

describe("buildChargeTree", () => {
  it("maps each flat line to a top-level node with no children", () => {
    const t = buildChargeTree(lines);
    expect(t).toHaveLength(3);
    expect(t[0]).toMatchObject({ label: "Freight", nativeAmount: 4200, usdAmount: 1143.63 });
    expect(t.every((n) => n.children.length === 0)).toBe(true);
  });

  it("keeps API order and gives every node a stable id", () => {
    const t = buildChargeTree(lines);
    expect(t.map((n) => n.label)).toEqual(["Freight", "Additional Charges", "Warehousing"]);
    expect(new Set(t.map((n) => n.id)).size).toBe(3);
  });

  it("returns [] for an offer with no charge lines", () => {
    expect(buildChargeTree([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @svyft/web test -- chargeTree`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `buildChargeTree`**

```ts
export function buildChargeTree(lines: OfferChargeLineDto[]): ChargeNode[] {
  return lines.map((l, i) => ({
    id: `${l.group}-${i}`,
    label: l.label,
    nativeAmount: l.nativeAmount,
    usdAmount: l.usdAmount,
    children: [],
  }));
}
```

- [ ] **Step 4: Write the failing dialog test**

```tsx
it("shows the offer's authoritative usdTotal, not the sum of its lines", async () => {
  // fixture lines deliberately sum to 1_824.36 while usdTotal is 1_824.37
  render(<ChargeBreakdownDialog open offer={OFFER} legLabel="L1 · A → B"
          fxAsOf="2026-08-17T09:00:00.000Z" onOpenChange={() => {}} />);
  expect(await screen.findByTestId("charge-total")).toHaveTextContent("$1,824.37");
});

it("states the conversion rate used", async () => {
  render(<ChargeBreakdownDialog open offer={OFFER} legLabel="L1 · A → B"
          fxAsOf="2026-08-17T09:00:00.000Z" onOpenChange={() => {}} />);
  expect(await screen.findByText(/3\.67250 AED per USD/)).toBeInTheDocument();
});

it("renders a not-priced state instead of any money figure", async () => {
  render(<ChargeBreakdownDialog open offer={{ ...OFFER, priced: false, usdTotal: null }}
          legLabel="L1 · A → B" fxAsOf={null} onOpenChange={() => {}} />);
  expect(await screen.findByText(/not priced/i)).toBeInTheDocument();
  expect(screen.queryByTestId("charge-total")).not.toBeInTheDocument();
});
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `pnpm --filter @svyft/web test -- ChargeBreakdownDialog`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the dialog**

`ChargeBreakdownDialog.tsx`, props `{ open, onOpenChange, offer: OfferDto, legLabel: string, fxAsOf: string | null }`. Use the existing `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription` from `@/components/ui/dialog`.

- Short-circuit `!offer.priced` to a "Not priced by this forwarder" state **before** rendering any total (carry over `OfferDetail`'s existing guard — it is pinned by a regression test).
- Render `buildChargeTree(offer.charges)` as rows; a node with `children.length > 0` gets a caret button toggling its children (no node has children today — the branch exists for the future and must be covered by a unit test on `ChargeNode` rendering with a hand-built child).
- Total row `data-testid="charge-total"` showing `fmtUsd(offer.usdTotal)` — **never** a sum of `usdAmount`.
- Footer: `Converted at {unitsPerUsd.toFixed(5)} {currency} per USD · FX as of {formatDateTime(fxAsOf)}`, omitted when `unitsPerUsd == null`.

Delete `OfferDetail.tsx`; replace its usage in `CompareLegPanel.tsx` with dialog state (`openBreakdownKey`) driven by the grid's `onOpenBreakdown`.

- [ ] **Step 7: Run tests, lint, typecheck**

Run: `pnpm --filter @svyft/web test && pnpm --filter @svyft/web lint && pnpm run typecheck`
Expected: green. Confirm `grep -rn "OfferDetail" apps/web/src` returns no matches.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/compare
git commit -m "feat(stage5): charge breakdown dialog, tree-shaped (S5.7)"
```

---

## Task 4: Shortlist dialog, MakerPanel shrink

**Files:**
- Create: `apps/web/src/features/compare/ShortlistDialog.tsx`
- Create: `apps/web/src/features/compare/ShortlistDialog.test.tsx`
- Modify: `apps/web/src/features/compare/MakerPanel.tsx`
- Modify: `apps/web/src/features/compare/MakerPanel.test.tsx`
- Modify: `ComparisonGridColumns.tsx`, `ComparisonGridRows.tsx`, `CompareLegPanel.tsx`

**Interfaces:**
- Consumes: `useShortlist`, `useSendForApproval` (`useAwardActions.ts`, unchanged); `OfferCell` (Task 1).
- Produces: a `Select` affordance per priced cell in both orientations, opening `ShortlistDialog`.

**⚠ This task removes the `unsavedPick` guard added in `354236e`.** That guard existed because the grid's pick and the persisted shortlist lived in different components and could drift — the Critical the S5.6 whole-sub-build review caught. One dialog acting on one offer removes the second piece of state, so the guard becomes unreachable. **You must replace its three regression tests, not delete them** — the new equivalents assert that the offer submitted is the offer whose Select was clicked. Removing coverage for a previously-shipped Critical without replacing it is a task failure.

- [ ] **Step 1: Write the failing dialog tests**

```tsx
it("requires an override reason when the pick is not the recommendation", async () => {
  const user = userEvent.setup();
  renderDialog({ offer: FALCON_GROUPAGE });               // recommendation is BRIDGE_DEDICATED
  await user.click(await screen.findByRole("button", { name: /save & send for approval/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/reason/i);
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/shortlist"), expect.anything());
});

it("submits the offer whose Select was clicked, not a previously shortlisted one", async () => {
  const user = userEvent.setup();
  renderDialog({ offer: FALCON_GROUPAGE, decision: { shortlistedQuoteId: "q-bridge", shortlistedVariant: "DEDICATED" } });
  await user.type(screen.getByLabelText(/override reason/i), "cheaper");
  await user.click(screen.getByRole("button", { name: /^save shortlist$/i }));
  const body = JSON.parse(lastFetchBody("/shortlist"));
  expect(body).toMatchObject({ quoteId: FALCON_GROUPAGE.quoteId, variant: "GROUPAGE" });
});

it("save & send posts shortlist then send-for-approval, in that order", async () => {
  const user = userEvent.setup();
  renderDialog({ offer: BRIDGE_DEDICATED });               // === the recommendation, no reason needed
  await user.click(screen.getByRole("button", { name: /save & send for approval/i }));
  await waitFor(() => expect(calledPaths()).toEqual([
    expect.stringContaining("/shortlist"),
    expect.stringContaining("/send-for-approval"),
  ]));
});

it("requires the A9 reason once proceed-without-waiting is ticked", async () => {
  const user = userEvent.setup();
  renderDialog({ offer: BRIDGE_DEDICATED, awaitingReQuote: true });
  await user.click(screen.getByRole("button", { name: /save & send for approval/i }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
});

it("surfaces a 409 inline and keeps the dialog open", async () => {
  /* … assert role="alert" text and that onOpenChange was not called with false … */
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter @svyft/web test -- ShortlistDialog`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ShortlistDialog`**

Props: `{ open, onOpenChange, queryId, leg: LegComparisonDto, cell: OfferCell }`.

- RHF + `zodResolver(shortlistSchema)`. **`overrideReason` is `.optional()`** — default it to `undefined`, not `""`, and use `setValueAs: (v) => (v === "" ? undefined : v)`. A `""` default is silently rejected by the resolver with no visible error; this exact bug shipped in S5.6 Task 4 and cost a fix round.
- Show the required override textarea when `cell.key !== model.recommendedKey` (compare with `offerKey` on both sides — never hand-rolled string concatenation).
- Show the A9 checkbox + required reason when `leg.awaitingReQuote`.
- **Save shortlist** → `useShortlist` only, close on success.
- **Save & send for approval** → `useShortlist` then, on success, `useSendForApproval`. If the shortlist call fails, do **not** send; surface the error and stay open.
- Both buttons disabled while either mutation is pending.
- Errors inline via `errorMessage(err, fallback)` + `role="alert"`.

- [ ] **Step 4: Add the Select affordance to both orientations**

In `ComparisonGridColumns.tsx` add a `Shortlist` row beneath Status; in `ComparisonGridRows.tsx` add a `Shortlist` cell. Priced cells render a `Select` button calling `onSelectOffer(cell)`; unpriced cells render a plain non-interactive `—`.

- [ ] **Step 5: Shrink `MakerPanel`**

Delete the shortlist `RadioGroup` block, the `SEND FOR APPROVAL` block, the `unsavedPick`/`savedShortlistKey` computation and the `onSend` guard. Keep: the locked-state copy (both the `PENDING_APPROVAL` and `APPROVED` branches corrected in `354236e`) and the `DRAFT && rejectionReason` alert. In `MakerPanel.test.tsx`, delete the tests for the removed controls and **port the three `unsavedPick` regression tests to `ShortlistDialog.test.tsx`** as the "submits the offer whose Select was clicked" case above.

- [ ] **Step 6: Run tests, lint, typecheck**

Run: `pnpm --filter @svyft/web test && pnpm --filter @svyft/web lint && pnpm run typecheck`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/compare
git commit -m "feat(stage5): merge shortlist + send-for-approval into one dialog (S5.7)"
```

---

## Task 5: Multi-forwarder negotiate

**Files:**
- Rewrite: `apps/web/src/features/compare/NegotiateDialog.tsx`
- Rewrite: `apps/web/src/features/compare/NegotiateDialog.test.tsx`
- Modify: `apps/web/src/features/compare/useAwardActions.ts`
- Modify: `apps/web/src/features/compare/CompareLegPanel.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface RequoteTarget { quoteId: string; freightForwarderName: string; comment: string }
  export interface RequoteResult { quoteId: string; freightForwarderName: string; ok: boolean; error?: string }
  export function useRequestRequoteBatch(queryId: string, legId: string):
    { run(targets: RequoteTarget[]): Promise<RequoteResult[]>; isPending: boolean };
  ```
  The existing per-quote `useRequestRequote` is bound to one `quoteId` at hook level and therefore cannot be looped — hence the batch hook. Keep `useRequestRequote` if anything still imports it; delete it if nothing does.

**Eligibility rule:** one `Quote` covers all of a forwarder's variants, so selection is **per forwarder**, not per offer. Eligible = the forwarder has an offer on this leg with `quoteStatus` of `QUOTED` or `APPROVED`. `REQUOTED` forwarders and `pendingForwarders` are rendered **disabled with their reason**, never hidden.

- [ ] **Step 1: Write the failing tests**

```tsx
it("lists eligible forwarders selectable and ineligible ones disabled with a reason", async () => {
  renderNegotiate();
  expect(await screen.findByRole("checkbox", { name: /bridge/i })).toBeEnabled();
  expect(screen.getByRole("checkbox", { name: /zenith/i })).toBeDisabled();
  expect(screen.getByText(/already awaiting a revised quote/i)).toBeInTheDocument();
  expect(screen.getByText(/hasn't quoted yet/i)).toBeInTheDocument();
});

it("posts one request per selected forwarder with the shared note", async () => {
  const user = userEvent.setup();
  renderNegotiate();
  await user.click(await screen.findByRole("checkbox", { name: /select all/i }));
  await user.type(screen.getByLabelText(/note/i), "budget is $1,500");
  await user.click(screen.getByRole("button", { name: /send to 2 forwarders/i }));
  await waitFor(() => expect(requotePaths()).toHaveLength(2));
  expect(JSON.parse(lastFetchBody("request-requote"))).toEqual({ comment: "budget is $1,500" });
});

it("sends a per-forwarder note when the separate-notes toggle is on", async () => { /* … */ });

it("reports partial success per forwarder and stays open", async () => {
  failNextRequoteFor("q-falcon", 409, "Quote is not in a re-quotable state");
  /* … select both, send … */
  expect(await screen.findByText(/bridge/i, { selector: "[data-result='ok']" })).toBeInTheDocument();
  expect(screen.getByText(/not in a re-quotable state/i)).toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

it("disables the leg's Negotiate button once sent for approval", async () => {
  renderLegPanel({ decision: { status: "PENDING_APPROVAL" } });
  const btn = await screen.findByRole("button", { name: /negotiate/i });
  expect(btn).toBeDisabled();
  expect(screen.getByText(/checker must reject/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter @svyft/web test -- NegotiateDialog`
Expected: FAIL.

- [ ] **Step 3: Implement `useRequestRequoteBatch`**

Sequential `for…of` over targets, `postJson` per target, collecting `RequoteResult[]`; never throws. Invalidate `["comparison", queryId]` **once** after the loop, regardless of outcome (successful calls already changed server state).

- [ ] **Step 4: Implement the dialog**

Derive eligibility from `leg.offers` + `leg.pendingForwarders`, deduplicated by `freightForwarderId`. Select-all toggles only eligible entries. A shared `Textarea`, plus a `Checkbox` that swaps in one `Textarea` per selected forwarder. Submit label `Send to {n} forwarder{s}`; disabled when `n === 0` or any note required is empty. On completion render the per-forwarder result list; close only when every result is `ok`.

- [ ] **Step 5: Wire the leg-level button**

In `CompareLegPanel.tsx` put `Negotiate…` at the right of the `N offers received` line (`ml-auto`). `disabled` when `leg.decision?.status === "PENDING_APPROVAL"`, with the visible reason text beside it. Remove the per-forwarder Negotiate buttons from `MakerPanel`.

- [ ] **Step 6: Run tests, lint, typecheck**

Run: `pnpm --filter @svyft/web test && pnpm --filter @svyft/web lint && pnpm run typecheck`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/compare
git commit -m "feat(stage5): leg-level multi-forwarder negotiate dialog (S5.7)"
```

---

## Task 6: Both-roles coverage, diagram-click verification, full CI

**Files:**
- Modify: `apps/web/src/features/compare/CompareQuotesPage.test.tsx`
- Modify: `apps/web/src/features/compare/CompareLegPanel.tsx` (only if a defect is found)

- [ ] **Step 1: Write the failing both-roles tests**

For each of `EXECUTIVE` and `MANAGER`, assert against the redesigned screen. **Await a positive control before any absence assertion** — reuse the `AuthProbe` pattern from `CheckerPanel.test.tsx:85-92`:

```tsx
describe.each(["EXECUTIVE", "MANAGER"] as const)("compare screen as %s", (role) => {
  it("shows the grid, the Select affordance and Negotiate", async () => {
    renderPage({ role });
    await screen.findByText(role);                       // AuthProbe — auth has settled
    expect(screen.getByTestId("comparison-grid")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /select/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /negotiate/i })).toBeInTheDocument();
  });
});

it("shows checker controls only to a MANAGER", async () => {
  renderPage({ role: "EXECUTIVE" });
  await screen.findByText("EXECUTIVE");                  // MUST await before asserting absence
  expect(screen.queryByTestId("checker-panel")).not.toBeInTheDocument();
  expect(screen.queryByTestId("generate-gate")).not.toBeInTheDocument();
});

it("locks to read-only once the award is generated", async () => {
  renderPage({ role: "MANAGER", awardSnapshot: SNAPSHOT });
  await screen.findByText("MANAGER");
  expect(screen.queryByRole("button", { name: /select/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /negotiate/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/recommended/i)).not.toBeInTheDocument();   // M1: no tint when locked
});
```

- [ ] **Step 2: Run to confirm they fail, then implement any gaps**

Run: `pnpm --filter @svyft/web test -- CompareQuotesPage`
Fix only what these reveal. If the locked state still renders a Select button or the recommendation tint, that is a real regression of S5.6 final-review M1 — fix it.

- [ ] **Step 3: Mutation-prove every absence assertion**

For each `not.toBeInTheDocument()` above: invert the production condition, confirm **only** that test goes red, revert, confirm green. Record the evidence in the task report. An absence assertion that stays green under inversion is vacuous and must be rewritten.

- [ ] **Step 4: Verify the route-diagram click still opens the leg**

This was built in S5.6 Task 2 and is not being rebuilt — confirm it survived. Run the dev server, click a leg edge in the route diagram, confirm that leg's panel opens and scrolls into view. Also confirm `RouteDiagram.test.tsx`'s `onSelectLeg` cases still pass.

Run: `pnpm --filter @svyft/web test -- RouteDiagram`
Expected: PASS.

- [ ] **Step 5: Full CI**

Run: `pnpm run ci`
Expected: GREEN — lint, typecheck, test, build across all three workspaces. API e2e needs Postgres: container `svyft-postgres-task4` on port **5433**; `set -a; . apps/api/.env; set +a` first. **If anything in `apps/api` or `packages/shared` fails, you broke the frontend-only constraint** — report it rather than fixing the backend.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/compare
git commit -m "test(stage5): both-roles + locked-state coverage for the reworked compare screen (S5.7)"
```

---

## S5.7 acceptance

- [ ] `pnpm run ci` green → visual verification against the seeded query (`scratchpad/seed-compare-quotes.ts`, `S56VIS-0001`) in **both** grid orientations, as Executive **and** Manager → opus whole-sub-build review → push to PR #52.
- [ ] Confirm `git diff --stat main..HEAD -- apps/api packages/shared prisma` is **empty** for this sub-build's commits.

## Self-review against the design

- **Item coverage:** 1 → T1 (grouping) + T2 (toggle); 2 → T3; 3 → T1; 4 → T4; 5 → T5 Step 5; 6 → T5; 7 → T6 Step 4 (verification only, by decision); 8 → T6; 9 → T1.
- **Consequences C1–C3** are recorded in the design, not implemented here by decision: C1 (item 5 unenforced server-side), C2 (charge tree has no children), C3 (batch negotiate not atomic). Each is called out in the task that touches it.
- **Type consistency:** `offerKey`, `OfferCell`, `ComparisonRowModel`, `METRICS`, `ViewMode`, `ChargeNode`, `RequoteTarget`/`RequoteResult` are each defined once (T1, T2, T3, T5) and referenced by those exact names thereafter.
- **Regression protection:** the removed `unsavedPick` guard's coverage is explicitly ported in T4 Step 5 rather than dropped; T6 re-pins locked-state behaviour (S5.6 final-review M1) and the four-eyes/Generate RBAC rules.
