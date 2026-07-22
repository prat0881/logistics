# Plan 6b — Req & Issues Round 1 — Route Canvas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Step-4 **route diagram THE surface** (Issue 1): remove the Point/Leg list cards; render every point as a box + every leg as a line **including standalone points before any leg exists**; **click a point box → Point editor, click a leg line → Leg editor**; a thin **`+ Add point` / `+ Add leg` toolbar**; **Delete inside the editor dialog**; and a **rich hover tooltip** (point full address / leg rollup + red validation issues).

**Architecture:** Web-only (`apps/web`), no shared/api/migration. All change is in the Step-4 subtree: `RouteDiagram.tsx` (the signature SVG — gets standalone-point rendering, click-to-edit callbacks, and a controlled hover-tooltip overlay), `PointEditor.tsx`/`LegEditor.tsx` (Delete button), and `LegsStep.tsx` (drop the lists → toolbar + canvas + mint-first-add). RouteDiagram changes are **additive** (new props alongside the existing `onSelect`) so each task's typecheck stays green until the final LegsStep task switches the wiring.

**Tech Stack:** React 18 + Vite + Tailwind + shadcn/ui + TanStack Query + RHF · bespoke SVG (no charting lib) · Vitest + `renderWithProviders`/`mockFetch`.

## Global Constraints

- **`pnpm run ci` MUST be green before finishing.** Baseline on `main` after increment 2: **shared 146 · web 182 · api 105**. No shared/api change here → shared 146 + api 105 unchanged; web grows.
- **Local gate:** `pnpm --filter @svyft/shared build && pnpm run ci` (web vitest reads `@svyft/shared` from dist; build it first). GitHub CI builds shared first (authoritative). No new shared code this increment, so the pre-built dist from `main` suffices — but still build it once to be safe.
- **Web CI gotcha:** run `pnpm --filter @svyft/web typecheck` (esbuild hides type errors). Per-task vitest does NOT lint → run `pnpm --filter @svyft/web lint` before finishing (catches unused vars from the list-removal).
- **Web tests:** Vitest + `renderWithProviders` + `mockFetch`; `afterEach(vi.unstubAllGlobals())`. **Radix Select is jsdom-flaky** (LegEditor/PointEditor drive hidden native `<select>` — mirror the existing editor tests). SVG `getBoundingClientRect` returns zeros in jsdom → **do NOT assert tooltip pixel position; assert tooltip CONTENT** (it renders via React state on `mouseEnter`/`focus`, no Radix portal).
- **Preserve** (design "Keep"): the `RouteNoticesStrip` top summary strip; the mint flow (first persist mints the query); keyboard focus (`route-focusable`, `tabIndex`, Enter/Space) + `aria-label`s on nodes/edges; the existing `data-point-id`/`data-leg-id`/`data-mode`/`data-type`/`data-finding`/`data-orphan` test hooks.
- **Commit per task** (`feat(web)…`/`refactor(web)…`). **Branch:** `feat/plan-6b-req-issues-round1-route-canvas` off `main`.
- **Out of scope / deferred:** Timezone + migration + zone labels (increment 4); MSDS hold-&-send + delete endpoint; Shipment-step merge; G6; D2/D4. The server-authoritative checklist gate (increment 2's deferral). The `validateOnServer` "Validate route" button was already removed in a prior round — do not re-add.

---

## Design decisions (read before implementing)

- **Click = edit (replaces cross-highlight).** With the Point/Leg lists gone there is no findings panel to cross-highlight, so a node/edge click opens its editor. RouteDiagram gains `onEditPoint?(id)` / `onEditLeg?(id)`; a node/edge click prefers them and falls back to the legacy `onSelect` when they're absent (keeps Tasks 1-4 green before Task 5 rewires). The `selectedPointId`/`selectedLegId` accent props stay (used for a subtle "hovered/active" accent) but are no longer driven by a list selection.
- **Standalone points.** The `if (!hasLegs) return <placeholder>` guard becomes `if (points.length === 0 && legs.length === 0) return <placeholder>`. With points-but-no-legs, render the nodes (the layout already stacks them in column 0); no edges. The placeholder text when truly empty: "Add a point or leg to start the route."
- **Rich hover tooltip = controlled HTML overlay** (NOT SVG `<title>`, NOT Radix). RouteDiagram owns `hovered: {kind, id} | null`, set on a node/edge `onMouseEnter`/`onFocus` and cleared on `onMouseLeave`/`onBlur`; a positioned `<div role="tooltip">` inside the `relative` `<figure>` renders rich content: **point** → type · name · full street address (street, city+postal, country, code) · contact · then red finding messages; **leg** → legCode · mode · status · origin→dest · cargo count · rollup (pkg / CBM / kg) · then red finding messages. Position is approximate (from the layout `pos` for a node / edge-midpoint for a leg); tests assert content only. Keep the SVG `<title>` too (screen-reader parity) — additive.
- **Toolbar + mint-first-add.** LegsStepBody (post-mint) shows a thin toolbar `+ Add point` · `+ Add leg` opening the editors in add mode. The pre-mint wrapper (`LegsStep`, no `detail`) shows the SAME toolbar; its buttons `create({})` then `navigate("/queries/:id?step=3&add=point|leg", {replace:true})`; LegsStepBody reads the `add` search-param on mount and opens the matching editor in add mode (then clears the param). This is the "mint first on a brand-new query" flow.
- **Delete-in-editor.** PointEditor + LegEditor, in EDIT mode only, render a `Delete` button (destructive, left of the footer) that `window.confirm`s, calls `usePoints(queryId).remove(point.id)` / `useLegs(queryId).remove(leg.id)`, then `onSaved()` + `onClose()`. (Deleting a point still referenced by a leg is allowed — the route findings then flag the dangling leg, same as today's list "Remove".)

---

## File Structure

**`apps/web/src/features/query-wizard/steps/legs/`**
- `RouteDiagram.tsx` — MODIFY: standalone-point guard (T1); `onEditPoint`/`onEditLeg` (T2); hover-tooltip overlay + `RouteTooltip` sub-component (T3).
- `PointEditor.tsx` — MODIFY: Delete button (T4).
- `LegEditor.tsx` — MODIFY: Delete button (T4).
- `LegsStep.tsx` — MODIFY: drop Point/Leg lists → toolbar + canvas; wire edit callbacks; mint-first-add via `?add=` param (T5).
- `RouteDiagram.test.tsx`, `PointEditor.test.tsx`, `LegEditor.test.tsx`, `LegsStep.test.tsx` — MODIFY.

---

## Task 1: RouteDiagram — render standalone points (before any leg)

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/RouteDiagram.tsx` (the `if (!hasLegs)` guard, ~lines 101-122)
- Modify: `apps/web/src/features/query-wizard/steps/legs/RouteDiagram.test.tsx`

**Change:** render point nodes whenever there is ≥1 point OR ≥1 leg; only show the dashed placeholder when the graph is entirely empty. Edges still only render for legs (unchanged). Orphan styling already only kicks in once a leg exists (`resolveHighlights` gates orphans on `graph.legs.length > 0`), so points-with-no-legs render as plain (non-orphan) boxes.

- [ ] **Step 1: Write the failing test**

In `RouteDiagram.test.tsx` add (mirror the file's existing `detail` fixture builder):
```tsx
it("renders point boxes even when there are no legs yet", () => {
  // detail: 2 points (e.g. a PICKUP + a DELIVERY), legs: []
  render(<RouteDiagram detail={detailPointsNoLegs} findings={[]} />);
  // both point boxes are drawn (data-point-id present), and the "add a leg" placeholder is NOT the whole surface
  expect(document.querySelectorAll("[data-point-id]").length).toBe(2);
  expect(screen.queryByText(/add the first leg to build the route/i)).not.toBeInTheDocument();
});
it("shows the empty placeholder only when there are no points and no legs", () => {
  render(<RouteDiagram detail={detailEmpty} findings={[]} />);
  expect(screen.getByText(/add a point or leg to start the route/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/web test RouteDiagram`
Expected: FAIL — the current `if (!hasLegs)` returns the placeholder whenever there are no legs, so points-no-legs draws zero `[data-point-id]`.

- [ ] **Step 3: Implement**

In `RouteDiagram.tsx`, replace the `const hasLegs = …` guard block:
```tsx
  const hasLegs = graph.legs.length > 0;
  const hasPoints = graph.points.length > 0;

  // Render the canvas whenever there is anything to draw. A points-only graph
  // (added points, no legs yet) draws the boxes so the user can wire them.
  if (!hasLegs && !hasPoints) {
    return (
      <div
        data-slot="route-diagram"
        className={cn(
          "rounded-md border border-dashed bg-card p-8 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        Add a point or leg to start the route.
      </div>
    );
  }
```
The `computeLayout` already handles a legs-empty graph (all points land in column 0 via `orphanDepth = 0`), and the edges `.map` renders nothing when `graph.legs` is empty — no other change needed.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @svyft/web test RouteDiagram && pnpm --filter @svyft/web typecheck`
Expected: PASS. Update any existing RouteDiagram test that asserted the old "Add the first leg…" placeholder for a points-only graph.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/legs/RouteDiagram.tsx apps/web/src/features/query-wizard/steps/legs/RouteDiagram.test.tsx
git commit -m "feat(web): RouteDiagram renders standalone points before any leg"
```

---

## Task 2: RouteDiagram — click a box/line to edit

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/RouteDiagram.tsx` (props + Node/Edge onClick/onKeyDown)
- Modify: `apps/web/src/features/query-wizard/steps/legs/RouteDiagram.test.tsx`

**Interfaces — Produces:** `RouteDiagramProps` gains `onEditPoint?: (pointId: string) => void;` and `onEditLeg?: (legId: string) => void;`. A node click prefers `onEditPoint` (falls back to `onSelect({type:"point",id})`); an edge click prefers `onEditLeg` (falls back to `onSelect({type:"leg",id})`). Consumed by Task 5.

- [ ] **Step 1: Write the failing test**
```tsx
it("clicking a point box calls onEditPoint with the point id", async () => {
  const onEditPoint = vi.fn();
  render(<RouteDiagram detail={detailWithRoute} findings={[]} onEditPoint={onEditPoint} onEditLeg={() => {}} />);
  const node = document.querySelector('[data-point-id]') as SVGGElement;
  await userEvent.click(node);
  expect(onEditPoint).toHaveBeenCalledWith(node.getAttribute("data-point-id"));
});
it("clicking a leg line calls onEditLeg with the leg id", async () => {
  const onEditLeg = vi.fn();
  render(<RouteDiagram detail={detailWithRoute} findings={[]} onEditPoint={() => {}} onEditLeg={onEditLeg} />);
  const edge = document.querySelector('[data-leg-id]') as SVGGElement;
  await userEvent.click(edge);
  expect(onEditLeg).toHaveBeenCalledWith(edge.getAttribute("data-leg-id"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/web test RouteDiagram`
Expected: FAIL (`onEditPoint`/`onEditLeg` not props; click still fires `onSelect`).

- [ ] **Step 3: Implement**

`RouteDiagram.tsx`:
- Add to `RouteDiagramProps`: `onEditPoint?: (pointId: string) => void; onEditLeg?: (legId: string) => void;` and destructure them in the component + thread them into the `<Node>` / `<Edge>` render (pass `onEditPoint`/`onEditLeg` down, or pass a pre-bound `onActivate` callback).
- In `Edge`, add prop `onEditLeg?: (id: string) => void;`. Change `interactive`/handlers: `const activate = () => onEditLeg ? onEditLeg(leg.id) : onSelect?.({ type: "leg", id: leg.id });` and `const interactive = !!onEditLeg || !!onSelect;`. Use `activate` in `onClick` and in the Enter/Space `onKeyDown`.
- In `Node`, symmetric: prop `onEditPoint?: (id: string) => void;`, `const activate = () => onEditPoint ? onEditPoint(point.id) : onSelect?.({ type: "point", id: point.id });`, `const interactive = !!onEditPoint || !!onSelect;`, use `activate` in onClick + onKeyDown.
- Update the parent `.map`s to pass `onEditPoint`/`onEditLeg` to `Node`/`Edge` (alongside the still-present `onSelect`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @svyft/web test RouteDiagram && pnpm --filter @svyft/web typecheck`
Expected: PASS. (Existing `onSelect` tests still pass — the fallback preserves them.)

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/legs/RouteDiagram.tsx apps/web/src/features/query-wizard/steps/legs/RouteDiagram.test.tsx
git commit -m "feat(web): RouteDiagram click a box/line to edit (onEditPoint/onEditLeg)"
```

---

## Task 3: RouteDiagram — rich hover tooltip (address / rollup + red issues)

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/RouteDiagram.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/legs/RouteDiagram.test.tsx`

**Change:** add a controlled hover tooltip. RouteDiagram tracks `hovered: { kind: "point" | "leg"; id: string } | null`; `Node`/`Edge` fire `onHover`/`onLeave` (on `onMouseEnter`/`onFocus` and `onMouseLeave`/`onBlur`); a `RouteTooltip` overlay renders inside the `relative` `<figure>` with rich content + red finding messages. Keep the existing `<title>` (screen-reader parity).

- [ ] **Step 1: Write the failing test**
```tsx
it("hovering a point box shows its full address in a tooltip", async () => {
  render(<RouteDiagram detail={detailWithRoute} findings={[]} onEditPoint={() => {}} onEditLeg={() => {}} />);
  const node = document.querySelector('[data-point-id]') as SVGGElement;
  await userEvent.hover(node);
  const tip = await screen.findByRole("tooltip");
  expect(tip).toHaveTextContent(/123 Main St|London|Pickup/i); // fields from the fixture point
});
it("hovering a leg line shows its rollup + any red issue", async () => {
  // detailWithRoute leg has a rollup (pkg/CBM/kg) and (optionally) a blocking finding
  render(<RouteDiagram detail={detailWithRoute} findings={legBlockingFindings} onEditPoint={() => {}} onEditLeg={() => {}} />);
  const edge = document.querySelector('[data-leg-id]') as SVGGElement;
  await userEvent.hover(edge);
  const tip = await screen.findByRole("tooltip");
  expect(tip).toHaveTextContent(/pkg|CBM|kg/i);
});
```
> Note: `userEvent.hover` dispatches `mouseover`/`mouseenter`. The `<g>` `onMouseEnter` sets state synchronously → the tooltip renders. No Radix/portal, so `findByRole("tooltip")` resolves without a delay. If `onMouseEnter` on the `<g>` proves unreliable in jsdom, use `fireEvent.mouseEnter(node)` — keep the content assertion.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/web test RouteDiagram`
Expected: FAIL (no `role="tooltip"` element).

- [ ] **Step 3: Implement**

`RouteDiagram.tsx`:
- Add `const [hovered, setHovered] = useState<{ kind: "point" | "leg"; id: string } | null>(null);` (import `useState`).
- `Node`: add props `onHover?: () => void; onLeave?: () => void;`; on the `<g>` add `onMouseEnter={onHover} onMouseLeave={onLeave} onFocus={onHover} onBlur={onLeave}` (merge with the existing handlers — the `<g>` already has onFocus? it has onKeyDown; add these). Parent passes `onHover={() => setHovered({ kind: "point", id: p.id })} onLeave={() => setHovered(null)}`.
- `Edge`: symmetric with `kind: "leg"`.
- After the `</svg>`, inside the `<figure>`, render the tooltip:
```tsx
        {hovered && (
          <RouteTooltip
            detail={detail}
            hovered={hovered}
            pos={pos}
            pointMsgs={highlights.pointMsgs}
            legMsgs={highlights.legMsgs}
          />
        )}
```
- Add the `RouteTooltip` sub-component (a positioned `<div role="tooltip">`). For a **point** (`detail.points.find`): render type label, name, address lines (`streetAddress`; `[city, postalCode].filter(Boolean).join(" ")`; `country`; code `unLocode ?? iataCode ?? icaoCode ?? terminal`), contact (`contactName` / `contactPhone` / `contactEmail` when present), then each `pointMsgs.get(id)` message in `text-destructive`. For a **leg** (`detail.legs.find`): `legCode`, `mode ?? "no mode"`, `status`, origin→dest names (look up in `detail.points`), `assignedCargoIds.length` cargo, and the rollup `${rollup.totalPackages} pkg · ${Number(rollup.totalCbm).toFixed(4)} CBM · ${Number(rollup.totalGrossWt).toFixed(2)} kg`, then each `legMsgs.get(id)` message in `text-destructive`. Position via `pos.get(id)` (node) / the edge midpoint (average of origin+dest `pos`) → `style={{ position: "absolute", left, top }}` (clamp to ≥0; offset by the figure padding); `className="pointer-events-none z-10 rounded-md border bg-popover px-3 py-2 text-xs shadow-md max-w-[240px] space-y-1"`. Keep it `pointer-events-none` so it never blocks the underlying box's click.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @svyft/web test RouteDiagram && pnpm --filter @svyft/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/legs/RouteDiagram.tsx apps/web/src/features/query-wizard/steps/legs/RouteDiagram.test.tsx
git commit -m "feat(web): RouteDiagram rich hover tooltip (address/rollup + red issues)"
```

---

## Task 4: Delete-in-editor — PointEditor + LegEditor

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx`
- Modify: `PointEditor.test.tsx`, `LegEditor.test.tsx`

**Change:** in EDIT mode only, add a destructive `Delete` button to each editor's `DialogFooter` (before Cancel/Save) that `window.confirm`s, calls the hook's `remove`, then `onSaved()` + `onClose()`. PointEditor already uses `usePoints(queryId)` (add `remove`); LegEditor already uses `useLegs(queryId)` (add `remove`).

- [ ] **Step 1: Write the failing tests**

PointEditor.test.tsx:
```tsx
it("edit mode shows a Delete button that removes the point after confirm", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const remove = vi.fn().mockResolvedValue(undefined);
  // render PointEditor in edit mode (point prop set) with usePoints.remove mocked to `remove`
  await userEvent.click(screen.getByRole("button", { name: /delete/i }));
  expect(remove).toHaveBeenCalledWith(EDIT_POINT_ID);
});
it("add mode shows no Delete button", () => {
  // render PointEditor with no point prop
  expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
});
```
LegEditor.test.tsx: symmetric (`useLegs.remove`, `EDIT_LEG_ID`).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @svyft/web test PointEditor LegEditor`
Expected: FAIL (no Delete button).

- [ ] **Step 3: Implement**

`PointEditor.tsx`: destructure `remove` from `usePoints(queryId)`; add a handler:
```tsx
  const handleDelete = async () => {
    if (!point || !window.confirm("Delete this point?")) return;
    await remove(point.id);
    onSaved(point as unknown as Record<string, unknown>);
    onClose();
  };
```
In the `DialogFooter`, before the Cancel button, add (edit mode only):
```tsx
              {isEdit && (
                <Button type="button" variant="destructive" onClick={handleDelete} className="mr-auto">
                  Delete
                </Button>
              )}
```
`LegEditor.tsx`: symmetric — destructure `remove` from `useLegs(queryId)`; `handleDelete` calls `await remove(leg!.id); onSaved(); onClose();` (confirm "Delete this leg?"); add the `Delete` button (edit mode only, `mr-auto`) to its `DialogFooter`. (`onSaved` for LegEditor takes no arg — check its signature and match it.)

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @svyft/web test PointEditor LegEditor && pnpm --filter @svyft/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx apps/web/src/features/query-wizard/steps/legs/PointEditor.test.tsx apps/web/src/features/query-wizard/steps/legs/LegEditor.test.tsx
git commit -m "feat(web): Delete button inside Point/Leg editor dialogs"
```

---

## Task 5: LegsStep — the canvas is the surface (remove lists · toolbar · mint-first-add)

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegsStep.test.tsx`

**Interfaces — Consumes:** `RouteDiagram` `onEditPoint`/`onEditLeg` (Task 2), the standalone-point render (Task 1), the editor Delete buttons (Task 4).

**Change (the integration):**
- **Delete the entire "Points" `<section>` and "Legs" `<section>`** (the two list blocks) from `LegsStepBody`, plus the now-unused helpers (`pointName`, `fmtNum`, `pointAddress`, `WarningBadge`) and the `Badge` import if unused, and the `selected`/`setSelected` cross-highlight state + `handleRemove`/`handleRemovePoint` (delete now lives in the editors) + `handleEdit` (replaced by the diagram callbacks). Keep `RouteNoticesStrip`, the editors, `handleAddLeg`/`handleAddPoint`/`handleEditPoint`/`closeLegEditor`/`closePointEditor`, and `useRouteFindings`.
- **Add the toolbar** above the canvas: `notices strip → toolbar (+ Add point · + Add leg) → RouteDiagram`. Example body:
```tsx
  return (
    <div className="space-y-4 p-4">
      <h2 className="text-base font-semibold">Leg & Route</h2>
      <RouteNoticesStrip grouped={grouped} />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={handleAddPoint}>+ Add point</Button>
        <Button size="sm" onClick={handleAddLeg}>+ Add leg</Button>
      </div>
      <RouteDiagram
        detail={detail}
        findings={all}
        onEditPoint={(id) => { const pt = detail.points.find((p) => p.id === id); if (pt) handleEditPoint(pt); }}
        onEditLeg={(id) => { const leg = detail.legs.find((l) => l.id === id); if (leg) handleEdit(leg); }}
      />
      <LegEditor open={editorOpen} leg={editingLeg} detail={detail} queryId={queryId} onSaved={closeLegEditor} onClose={closeLegEditor} />
      <PointEditor key={editingPoint?.id ?? "new-point"} queryId={queryId} open={pointEditorOpen}
        point={editingPoint as unknown as ComponentProps<typeof PointEditor>["point"]}
        onSaved={closePointEditor} onClose={closePointEditor} />
    </div>
  );
```
  (Re-add a minimal `handleEdit(leg)` that sets `editingLeg` + opens the editor — same as today's, just no longer wired to a list Edit button.)
- **Mint-first-add** (pre-mint wrapper `LegsStep`): replace the single "+ Add leg" mint button with the same toolbar, where each button mints then navigates with intent:
```tsx
  const handleMintAdd = async (what: "point" | "leg") => {
    setMinting(true);
    try {
      const d = await create({});
      navigate(`/queries/${d.id}?step=${LEGS_STEP_INDEX}&add=${what}`, { replace: true });
    } finally { setMinting(false); }
  };
```
  Toolbar buttons call `handleMintAdd("point")` / `handleMintAdd("leg")`; the placeholder text below stays.
- **Consume the `add` param** in `LegsStepBody`: read `useSearchParams()`; on mount, if `?add=point` open the PointEditor (add mode) / `?add=leg` open the LegEditor (add mode), then delete the `add` param (`setSearchParams`, replace) so it doesn't re-open on refresh:
```tsx
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const add = searchParams.get("add");
    if (add === "point") handleAddPoint();
    else if (add === "leg") handleAddLeg();
    if (add) {
      const next = new URLSearchParams(searchParams);
      next.delete("add");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 1: Write/adjust the failing tests**

`LegsStep.test.tsx` — the file currently drives the Points/Legs lists (edit/remove buttons) + the "Legs / Route" nav. Rewrite those to the canvas model:
```tsx
it("shows the + Add point / + Add leg toolbar and the route canvas (no list cards)", async () => {
  // render LegsStepBody with detailWithRoute
  expect(screen.getByRole("button", { name: /\+ add point/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /\+ add leg/i })).toBeInTheDocument();
  expect(document.querySelector('[data-slot="route-diagram"]')).toBeInTheDocument();
  // the old list "Edit"/"Remove" cards are gone
  expect(screen.queryByText(/^Points$/)).not.toBeInTheDocument();
});
it("clicking a point box in the canvas opens the Point editor in edit mode", async () => {
  // render, click a [data-point-id] node → the PointEditor dialog opens with that point
  await userEvent.click(document.querySelector('[data-point-id]') as SVGGElement);
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});
```
Keep/adjust the mint tests: a NEW-query "+ Add leg" mints + navigates with `?add=leg` (assert the create POST fired + the URL carries `add=leg`, mirroring the existing mint test's assertions).

- [ ] **Step 2: Run to verify (RED)**

Run: `pnpm --filter @svyft/web test LegsStep`
Expected: FAIL (lists still present; no toolbar/canvas-edit wiring).

- [ ] **Step 3: Implement** per the change above. Remove the dead helpers/imports; run lint locally to catch unused symbols.

- [ ] **Step 4: Run the FULL web suite + typecheck + lint**

Run: `pnpm --filter @svyft/web test && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint`
Expected: all green (this touches shared Step-4 wiring — run the whole suite; a Radix Select test may flake once → re-run).

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx apps/web/src/features/query-wizard/steps/legs/LegsStep.test.tsx
git commit -m "refactor(web): Step-4 route canvas is the surface (drop Point/Leg lists; toolbar + click-to-edit)"
```

---

## Definition of Done

- [ ] All 5 tasks committed on `feat/plan-6b-req-issues-round1-route-canvas`.
- [ ] **`pnpm --filter @svyft/shared build && pnpm run ci` green** (shared 146 · api 105 unchanged; web grows). `pnpm --filter @svyft/web lint` clean (the list-removal drops several helpers/imports — confirm none dangle).
- [ ] Opus **whole-branch review** — expect it to probe: click-to-edit end-to-end (canvas → editor → save/delete → re-GET refresh), standalone-point rendering + the empty placeholder, the hover-tooltip content (address/rollup + red findings) + it never blocking clicks (`pointer-events-none`), the mint-first-add `?add=` flow (no re-open on refresh), and that no dead list code / unused imports remain.
- [ ] Finish via `superpowers:finishing-a-development-branch` → PR to `main`; update `docs/Stage 3 - Session Handoff.md` (increment 3 done; next = `timezone`, and note its 4 open sub-decisions to resolve first).

## Self-Review notes (spec coverage — Issue 1)

- Diagram IS the surface; Point/Leg list items removed → Task 5.
- Render every point as a box + every leg as a line, incl. standalone points before any leg → Task 1 (+ existing edge render).
- Click a point box → Point editor; click a leg line → Leg editor → Task 2 (callbacks) + Task 5 (wiring).
- `+ Add point` / `+ Add leg` toolbar; mint-first on a brand-new query → Task 5.
- Delete via a button inside the editor dialog → Task 4.
- Hover → tooltip with details + full street address (points) + validation issues (red); per-leg rollup in the leg hover → Task 3.
- Keep: notices strip, editors, mint flow, keyboard-focus + aria-labels → preserved across Tasks 1-5 (Global Constraints).
- **Deferred:** Timezone/zone-labels (increment 4); MSDS hold-&-send; Shipment merge; G6; D2/D4.
