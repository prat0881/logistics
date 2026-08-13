# FF Scoped Route Diagram — match-executive rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the FF-portal "Route overview" (`ScopedRouteDiagram`) so it renders on the **same layout engine** as the executive `RouteDiagram` — matching positioning when a single FF holds a connected route, splitting a disconnected (non-contiguous) leg set into one diagram with a **visible break marker**, showing **code + name** node labels like the executive, and being strictly **read-only** (no click-to-open panel).

**Architecture:** The executive `RouteDiagram.computeLayout` (depth→column-rank + row-stacking + orphan-trailing) is extracted into the web-shared `apps/web/src/lib/routeLayering.ts` as a dimension-agnostic `computeRouteLayout` that returns a per-node `{col,row}` grid plus **connected-component** grouping. The executive refactors onto it (behavior-preserving; components-not-split). The FF diagram consumes the same engine with `splitComponents:true` (break markers between components) and the executive's node dimensions, so the two views are structurally identical. The FF endpoint DTO gains a non-sensitive `code` field (IATA/UN-LOCODE) resolved live from the point.

**Tech Stack:** React + TS + SVG (apps/web), Vitest; `@svyft/shared` Zod/TS DTOs; NestJS/Prisma (apps/api).

## Global Constraints

- **Branch `feat/stage-3-cargo-packing-list` (PR #51).** 🔴 GIT PROTOCOL: implementers **NEVER touch git**. The **controller commits**: `git checkout feat/stage-3-cargo-packing-list`, `git add <specific files>`, commit, verify parent. **Never stage `CLAUDE.md` / `docs/README.md`.** This folds into the go-live-gated PR #51 (do NOT merge).
- **Masking is inviolable (design §4.8).** `ScopedRouteDiagram` may render only the whitelist `type / code / name / city / country`. It must NEVER read or forward a street address or contact field. `code` = IATA/UN-LOCODE only (public). Do not import the executive `RouteDiagram` (its hover surfaces address/contact) — share only the pure layout engine.
- **The executive `RouteDiagram` refactor (Task 2) must be behavior-preserving** — its existing `RouteDiagram.test.tsx` must stay green with no assertion changes (except any that were asserting the *internal* layout function shape, which move to the engine's test).
- After any `packages/shared` edit: `pnpm --filter @svyft/shared build`.
- api e2e needs Postgres `:5433` + `set -a; . apps/api/.env; set +a`.
- **The gate is `pnpm run ci` GREEN** (lint + typecheck + test + build). The ~815 KB web-chunk advisory is not a failure.
- **Design decisions (confirmed with the user 2026-08-08):** (D1) FF view uses the executive layout engine, scoped to the FF's `rfq.legs`. (D2) A disconnected leg set renders as **one diagram with a visible break marker** between components (NOT separate blocks). (D3) Node labels = **code + name** mirroring the executive. (D4) FF view is **read-only** — remove the click-toggle + `NodeDetail` panel; masked info shows inline (as today) with an optional hover `<title>`.

---

## File Structure

- `apps/web/src/lib/routeLayering.ts` — **add** `computeRouteLayout` + connected-components beside the existing `computeLongestPathDepth`.
- `apps/web/src/lib/routeLayering.test.ts` — engine tests (create if absent).
- `apps/web/src/features/query-wizard/steps/legs/RouteDiagram.tsx` — **refactor** `computeLayout` onto the engine (behavior-preserving).
- `packages/shared/src/ff-portal.ts` — `FfPortalEndpoint` gains `code: string | null`.
- `apps/api/src/modules/ff-portal/ff-portal.service.ts` — `resolveScope` populates endpoint `code`.
- `apps/web/src/features/ff-portal/ScopedRouteDiagram.tsx` — rebuild render onto the engine (+ break marker, code+name, read-only).
- Tests: `ScopedRouteDiagram.test.tsx`, an `apps/api/test` ff-portal spec assertion for `code`.

---

### Task 1: Shared route-layout engine (`computeRouteLayout` + components)

**Files:**
- Modify: `apps/web/src/lib/routeLayering.ts`
- Test: `apps/web/src/lib/routeLayering.test.ts`

**Interfaces (Produces):**
```ts
export interface RouteLayoutNode { id: string; col: number; row: number; component: number; }
export interface RouteLayout {
  nodes: Map<string, RouteLayoutNode>; // col = 0-based column RANK (not raw depth), row = 0-based within column
  colCount: number;                    // total columns incl. break-gap columns when split
  maxRows: number;
  componentCount: number;
  breakCols: number[];                 // column indices that are break-gap spacers (empty), for the FF marker; [] when !split
}
// Pure. Reproduces RouteDiagram.computeLayout's depth→column-rank + row-stack + orphan-trailing,
// then (when split) orders connected components and lays them out left-to-right separated by ONE
// empty break column each. splitComponents=false → single continuous grid (executive behavior).
export function computeRouteLayout(
  pointIds: string[],
  edges: { originId: string | null; destinationId: string | null }[],
  opts?: { splitComponents?: boolean },
): RouteLayout
```

- [ ] **Step 1 — failing tests.** In `routeLayering.test.ts`: (a) a linear A→B→C → cols 0,1,2 all row 0, one component. (b) a fork A→B, A→C (B,C share depth 1) → B row 0, C row 1 same col (stack), maxRows 2. (c) an orphan node O (no edge) trails to the last column. (d) `splitComponents:true` on two disjoint chains A→B and C→D → component 0 = {A col0,B col1}, component 1 = {C,D} at higher cols with a `breakCols` spacer between; `componentCount===2`. (e) `splitComponents:false` on the same disjoint input → both chains packed by depth with `breakCols:[]`, `componentCount` still reported.
- [ ] **Step 2 — run, expect fail** (`pnpm --filter @svyft/web test -- src/lib/routeLayering.test.ts`).
- [ ] **Step 3 — implement.** Reuse `computeLongestPathDepth` for depth; group by depth → columns; rank columns 0..n-1 (mirror RouteDiagram's "column RANK not raw depth" cycle-safety comment); stack ids within a column as rows; trail orphans (nodes untouched by any edge) to `maxDepth+1`. Connected components via union-find over edges (isolated node = own component). When `splitComponents`, order components by their min column, re-base each component's columns after the previous component + 1 break column; record the break column indices. When not, keep the single global depth grid (executive-identical) but still compute `componentCount`.
- [ ] **Step 4 — green + typecheck** (`pnpm --filter @svyft/web test -- src/lib/routeLayering.test.ts && pnpm --filter @svyft/web typecheck`). Commit `feat(web): shared route-layout engine (grid + components)`.

---

### Task 2: Refactor executive `RouteDiagram` onto the engine (behavior-preserving)

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/RouteDiagram.tsx`
- Test: `apps/web/src/features/query-wizard/steps/legs/RouteDiagram.test.tsx` (must stay green)

**Interfaces (Consumes):** `computeRouteLayout` (Task 1).

- [ ] **Step 1 — read** `RouteDiagram.computeLayout` fully (it does depth→columns→rank→pos + orphan-trailing + `vBulge`). Note the pixel constants (`NODE_W 168`, `NODE_H 64`, `COL_GAP 96`, `ROW_GAP 28`, `PAD`).
- [ ] **Step 2 — refactor** `computeLayout` to call `computeRouteLayout(pointIds, edges, { splitComponents: false })` for the `{col,row}` grid, then apply the EXISTING pixel math (`x = PAD + col*(NODE_W+COL_GAP)`, `y = PAD + vBulge + row*(NODE_H+ROW_GAP)`), keeping `vBulge`, `width`/`height`, and the `Math.max(width,320)` floor exactly as they are. The engine replaces only the depth-group/rank/orphan bookkeeping — the renderer, edges, highlight, orphan visuals, and dimensions are untouched.
- [ ] **Step 3 — run the FULL RouteDiagram suite** (`pnpm --filter @svyft/web test -- RouteDiagram`). Every existing test must pass unchanged. If a test asserted the private `computeLayout` output shape, move that assertion to `routeLayering.test.ts` and delete it here (note in the report).
- [ ] **Step 4 — typecheck + commit** `refactor(web): RouteDiagram uses shared route-layout engine`.

---

### Task 3: FF endpoint `code` (DTO + live resolve)

**Files:**
- Modify: `packages/shared/src/ff-portal.ts` (`FfPortalEndpoint`)
- Modify: `apps/api/src/modules/ff-portal/ff-portal.service.ts` (`resolveScope` endpoint map)
- Test: an existing `apps/api/test/ff-portal*.e2e-spec.ts` (add a `code` round-trip assertion)

**Interfaces (Produces):** `FfPortalEndpoint.code: string | null`.

- [ ] **Step 1 — failing api assertion.** In an ff-portal e2e (e.g. `ff-portal-v3.e2e-spec.ts`), seed an AIRPORT origin point with `iataCode: "PVG"`; GET the portal; assert `leg.endpoints[0].code === "PVG"`.
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.** In `ff-portal.ts` add `code: string | null` to `FfPortalEndpoint` (+ its Zod mirror if one exists). In `resolveScope`'s endpoint map (ff-portal.service.ts ~:164) set `code: p.iataCode ?? p.unLocode ?? p.icaoCode ?? p.terminal ?? null` (the same precedence the executive uses; live point, no re-freeze). Ensure the point `select`/include carries those columns.
- [ ] **Step 4 — build shared, run api spec green + typecheck.** Commit `feat(ff-portal): expose non-sensitive point code to the FF endpoint`.

---

### Task 4: Rebuild `ScopedRouteDiagram` (match-executive layout, break marker, code+name, read-only)

**Files:**
- Modify: `apps/web/src/features/ff-portal/ScopedRouteDiagram.tsx`
- Test: `apps/web/src/features/ff-portal/ScopedRouteDiagram.test.tsx`

**Interfaces (Consumes):** `computeRouteLayout` (Task 1); `FfPortalEndpoint.code` (Task 3).

- [ ] **Step 1 — failing tests.** (a) A branched scoped graph (two legs sharing an origin) renders nodes on **two rows** (assert distinct `y`/transform), proving multi-row layout (not the old single row). (b) A disconnected scoped set (two legs with no shared point) renders a **break marker** element (`data-testid="route-break"`) between the components. (c) A node box shows the endpoint `code` AND `name` (e.g. both "PVG" and the name text). (d) Read-only: a node has **no** `role="button"` / `onClick` toggling a panel, and clicking a node does **not** render `scoped-route-node-detail` (that element/branch is removed).
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement.**
  - Build the graph as today (`buildScopedGraph`), but carry `code` onto `ScopedNode` (from `endpoint.code`).
  - Replace `orderNodesByTopology` + single-row `computeLayout` with `computeRouteLayout(nodeIds, edges, { splitComponents: true })`; position with the **executive's** dimensions (`NODE_W 168`, `NODE_H 64`, `COL_GAP 96`, `ROW_GAP 28`) so the view matches the executive; size the SVG from `colCount`/`maxRows`.
  - For each index in `breakCols`, draw a subtle vertical **break marker** (dashed rule + a small "break" glyph/label) in that spacer column so a non-contiguous assignment reads as one diagram with a gap.
  - `Node`: render the type glyph + label, the **code** (when present) and **name** on the two text rows (mirror the executive's code+name treatment), plus city/country. Keep `truncate`.
  - **Read-only:** remove `onClick`, `role="button"`, `tabIndex`, `aria-pressed`, `cursor-pointer`, the `selectedId` state, the `toggle`, and the `<NodeDetail>` render + component. Add a hover `<title>` inside the node `<g>` with the masked `type · code · name · city, country` for parity with the edge tooltip.
  - Keep the masking whitelist comment accurate (now `type/code/name/city/country`).
- [ ] **Step 4 — green + typecheck** (`pnpm --filter @svyft/web test -- ScopedRouteDiagram && pnpm --filter @svyft/web typecheck`). Commit `feat(ff-portal): scoped route diagram matches executive (multi-row, break marker, code+name, read-only)`.

---

## Self-Review

- **Spec coverage:** D1 layout-match → Tasks 1+4 (+2 keeps executive identical); D2 break marker → Task 1 `splitComponents`/`breakCols` + Task 4 render; D3 code+name → Tasks 3+4; D4 read-only → Task 4. ✓
- **Type consistency:** `computeRouteLayout` grid `{col,row,component}` consumed by Task 2 (exec) and Task 4 (FF); `FfPortalEndpoint.code` (Task 3) consumed by Task 4's node. ✓
- **Masking:** Task 4 only ever reads `type/code/name/city/country`; never imports `RouteDiagram`; `code` is IATA/UN-LOCODE only. ✓
- **Risk:** Task 2 is the only refactor of working code — gated by `RouteDiagram.test.tsx` staying green with `splitComponents:false` (executive layout unchanged).
