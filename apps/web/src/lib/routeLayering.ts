/**
 * routeLayering — pure longest-path layering over a directed point graph.
 *
 * Shared by the executive `RouteDiagram` (query-wizard/steps/legs) and the
 * FF-portal `ScopedRouteDiagram`: both draw a route as nodes wired by leg
 * edges and need the SAME left-to-right topological ordering so the FF sees
 * the route in the same order the executive does. The algorithm only reads
 * point ids + each edge's origin/destination id — pure topology, no masked
 * or sensitive fields — so it works identically on the executive's full
 * route graph and the FF's masked, assignment-scoped subgraph.
 *
 * `computeLongestPathDepth` is the depth primitive; `computeRouteLayout`
 * builds the full grid (columns, row-stacking, orphan-trailing, and
 * optionally connected-component splitting) on top of it. Both stay pure
 * topology — no pixel math, no React, no DOM — so renderers (the executive
 * multi-row SVG, the FF-portal scoped diagram) own their own coordinate
 * conversion from the same `col`/`row` grid.
 */

export interface LayeringEdge {
  originId: string | null;
  destinationId: string | null;
}

/**
 * Depth 0 = points that are never a destination (sources, or isolated
 * points touched by no edge). Each edge pushes its destination to
 * `max(existing, depth[origin] + 1)`, relaxed to a fixpoint over multiple
 * passes so the result is independent of edge input order.
 *
 * A cycle has no fixpoint, so relaxation is capped at `edges.length + 2`
 * iterations rather than run to convergence — callers that care about
 * cycles as a data problem (e.g. `validateRoute`) flag them separately;
 * this just guarantees termination and a usable (if not meaningful) depth
 * assignment so rendering never hangs or blanks out.
 */
export function computeLongestPathDepth(
  pointIds: Iterable<string>,
  edges: readonly LayeringEdge[],
): Map<string, number> {
  const depth = new Map<string, number>();
  for (const id of pointIds) depth.set(id, 0);

  const maxIter = edges.length + 2;
  for (let i = 0; i < maxIter; i++) {
    let changed = false;
    for (const e of edges) {
      if (!e.originId || !e.destinationId) continue;
      const originDepth = depth.get(e.originId) ?? 0;
      const currentDepth = depth.get(e.destinationId) ?? 0;
      const nextDepth = originDepth + 1;
      if (nextDepth > currentDepth) {
        depth.set(e.destinationId, nextDepth);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return depth;
}

export interface RouteLayoutNode {
  id: string;
  /** 0-based column RANK — the index of this id's depth in the sorted list
   * of distinct depths, not the raw depth value (see `computeRouteLayout`). */
  col: number;
  /** 0-based row — this id's index within the ids stacked in its column. */
  row: number;
  /** 0-based connected-component index, ordered by the component's
   * leftmost (minimum) column. Always populated, even when the nodes were
   * not laid out per-component (`splitComponents: false`). */
  component: number;
}

export interface RouteLayout {
  /** One entry per input point id. */
  nodes: Map<string, RouteLayoutNode>;
  /** Total column count, including empty break-gap spacer columns when split. */
  colCount: number;
  /** The largest number of ids stacked in any single column. */
  maxRows: number;
  /** Number of weakly-connected components (edge-connected groups, plus one
   * singleton per point untouched by any edge). */
  componentCount: number;
  /** Column indices that are empty break-gap spacers between components.
   * Always `[]` when `splitComponents` is false. */
  breakCols: number[];
}

/**
 * computeRouteLayout — shared grid layout for both the executive
 * `RouteDiagram` and the FF-portal `ScopedRouteDiagram`.
 *
 * With `splitComponents: false` (the default) this reproduces
 * `RouteDiagram.computeLayout`'s grid exactly: points are layered into
 * columns by `computeLongestPathDepth`, orphans (points untouched by any
 * edge) trail one column past the deepest touched point (or column 0 when
 * there are no edges at all), and each column's ids are stacked as rows in
 * their input order (stable). Placement uses COLUMN RANK — the index of a
 * point's depth in the sorted list of distinct depths, not the raw depth —
 * so a cycle-inflated depth (see `computeLongestPathDepth`'s doc) still
 * collapses to a compact, gap-free `0..colCount-1` range instead of
 * spilling nodes far outside a renderer's viewBox.
 *
 * With `splitComponents: true`, points are additionally grouped into
 * weakly-connected components — union-find over the edges; a point touched
 * by no edge is its own singleton component — ordered left-to-right by each
 * component's leftmost (minimum) column. Each component then gets its OWN
 * column-rank grid (computed the same way, but scoped to just that
 * component's points), re-based to start one empty "break" column after the
 * previous component's last column. `breakCols` records those spacer column
 * indices so a renderer can draw a visual gap (e.g. the FF-portal's
 * masked-subgraph marker) without hardcoding positions.
 *
 * `component`/`componentCount` are always computed, regardless of
 * `splitComponents` — so callers can inspect connectivity even when the
 * grid itself stays the single global depth grid.
 *
 * Pure topology (point ids + edge origin/destination ids) — no React, no
 * DOM, no pixel math. Converting `col`/`row` (and `breakCols`) into actual
 * coordinates — node size, gaps, viewBox — is the renderer's job.
 */
export function computeRouteLayout(
  pointIds: string[],
  edges: LayeringEdge[],
  opts?: { splitComponents?: boolean },
): RouteLayout {
  const splitComponents = opts?.splitComponents ?? false;

  // Points touched by at least one edge end (origin or destination) — the
  // rest are "orphans" and get trailed into their own column, exactly as
  // RouteDiagram.computeLayout does.
  const touched = new Set<string>();
  for (const e of edges) {
    if (e.originId) touched.add(e.originId);
    if (e.destinationId) touched.add(e.destinationId);
  }

  // Longest-path depth, then trail orphans one column past the deepest
  // touched point (column 0 if there are no edges at all).
  const depth = computeLongestPathDepth(pointIds, edges);
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  const orphanDepth = edges.length > 0 ? maxDepth + 1 : 0;
  for (const id of pointIds) {
    if (!touched.has(id)) depth.set(id, orphanDepth);
  }

  // Group ids by depth, preserving input order within each group (stable).
  const columns = new Map<number, string[]>();
  for (const id of pointIds) {
    const d = depth.get(id) ?? 0;
    const arr = columns.get(d);
    if (arr) arr.push(id);
    else columns.set(d, [id]);
  }

  // Column RANK (index into the sorted distinct depths), not raw depth.
  // Computed once up front: the non-split grid uses it directly, and the
  // split grid uses it only to order components by their leftmost column.
  const sortedDepths = [...columns.keys()].sort((a, b) => a - b);
  const globalCol = new Map<string, number>();
  const globalRow = new Map<string, number>();
  sortedDepths.forEach((d, col) => {
    columns.get(d)!.forEach((id, row) => {
      globalCol.set(id, col);
      globalRow.set(id, row);
    });
  });

  // Connected components — union-find over the edges. A point untouched by
  // any edge is never union'd with anything, so it naturally ends up its
  // own singleton component.
  const parent = new Map<string, string>();
  for (const id of pointIds) parent.set(id, id);
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const e of edges) {
    if (!e.originId || !e.destinationId) continue;
    if (!parent.has(e.originId) || !parent.has(e.destinationId)) continue;
    const ra = find(e.originId);
    const rb = find(e.destinationId);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Group ids by component root, preserving input order (stable) — same
  // discipline as the column grouping above.
  const compGroups = new Map<string, string[]>();
  for (const id of pointIds) {
    const root = find(id);
    const arr = compGroups.get(root);
    if (arr) arr.push(id);
    else compGroups.set(root, [id]);
  }

  // Number components by their leftmost (minimum) global column, leftmost
  // first; ties keep the components' first-encountered order (stable sort).
  const orderedComponents = [...compGroups.values()].sort((a, b) => {
    const minA = Math.min(...a.map((id) => globalCol.get(id) ?? 0));
    const minB = Math.min(...b.map((id) => globalCol.get(id) ?? 0));
    return minA - minB;
  });
  const componentCount = orderedComponents.length;
  const componentIndex = new Map<string, number>();
  orderedComponents.forEach((ids, idx) => {
    for (const id of ids) componentIndex.set(id, idx);
  });

  const nodes = new Map<string, RouteLayoutNode>();
  const breakCols: number[] = [];
  let colCount: number;
  let maxRows = 0;

  if (!splitComponents) {
    // Single global depth grid — identical to RouteDiagram.computeLayout.
    for (const d of sortedDepths) maxRows = Math.max(maxRows, columns.get(d)!.length);
    for (const id of pointIds) {
      nodes.set(id, {
        id,
        col: globalCol.get(id) ?? 0,
        row: globalRow.get(id) ?? 0,
        component: componentIndex.get(id) ?? 0,
      });
    }
    colCount = sortedDepths.length;
  } else {
    // Each component gets its own column-rank grid, laid out left-to-right,
    // re-based to start one empty break column after the previous
    // component's last column.
    let nextCol = 0;
    orderedComponents.forEach((ids, idx) => {
      if (idx > 0) {
        breakCols.push(nextCol);
        nextCol += 1;
      }
      const localColumns = new Map<number, string[]>();
      for (const id of ids) {
        const d = depth.get(id) ?? 0;
        const arr = localColumns.get(d);
        if (arr) arr.push(id);
        else localColumns.set(d, [id]);
      }
      const localSortedDepths = [...localColumns.keys()].sort((a, b) => a - b);
      localSortedDepths.forEach((d, localCol) => {
        const localIds = localColumns.get(d)!;
        maxRows = Math.max(maxRows, localIds.length);
        localIds.forEach((id, row) => {
          nodes.set(id, { id, col: nextCol + localCol, row, component: idx });
        });
      });
      nextCol += localSortedDepths.length;
    });
    colCount = nextCol;
  }

  return { nodes, colCount, maxRows, componentCount, breakCols };
}
