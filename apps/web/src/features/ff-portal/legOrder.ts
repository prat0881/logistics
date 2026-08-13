import type { FfPortalLegDto } from "@svyft/shared";
import { computeRouteLayout } from "@/lib/routeLayering";
import { buildScopedGraph } from "./ScopedRouteDiagram";

/**
 * orderLegsByRoute — sorts legs into route-diagram TOPOLOGY order (left-to-right, matching
 * `ScopedRouteDiagram`'s node layout / the executive `RouteDiagram`), instead of the Prisma
 * ASSIGNMENT order `rfq.legs` arrives in (which tracks WHEN a leg was distributed to this FF, not
 * WHERE it sits on the route — design §4.8 finding #2).
 *
 * Reuses the SAME graph-construction (`buildScopedGraph`) + the SAME layout call
 * `ScopedRouteDiagram.computeLayout` itself makes — `computeRouteLayout(pointIds, edges, {
 * splitComponents: true })` — so leg render order and diagram layout can never silently drift
 * apart. This MUST stay `computeRouteLayout` (the full column-assignment grid), not a bare
 * `computeLongestPathDepth` call: `ScopedRouteDiagram` doesn't render by flat global depth — with
 * `splitComponents: true`, each weakly-connected component (e.g. a first-mile + last-mile
 * assignment where a middle leg went to a different forwarder — exactly the non-contiguous case
 * `splitComponents`/`breakCols` exists for) is laid out as its OWN contiguous block, separated by
 * a break column, ordered by the component's leftmost global column. Sorting by raw depth alone
 * loses that block structure — two 2+-hop components can tie at every depth level (e.g. both
 * starting at depth 0, both ending at depth 1) and get INTERLEAVED instead of rendered as
 * contiguous blocks, silently diverging from what the diagram actually draws (fix round 1 — a
 * single-edge-per-component fixture can't catch this: a lone edge's origin is trivially both
 * min-depth and first-encountered, so a depth sort and a column sort coincide only in that
 * degenerate case).
 *
 * Sort key: a leg's ORIGIN node's diagram COLUMN (`endpoints[0]`, `layout.nodes.get(id).col` —
 * already component-block-aware and break-column-offset), tie-broken by its DESTINATION node's
 * column (`endpoints[1]`), then by original array position (stable) — so legs that fork from a
 * shared origin, or are otherwise indistinguishable by column, keep their relative assignment
 * order instead of reordering arbitrarily.
 *
 * A leg missing one or both endpoints (defensive — `buildScopedGraph` tolerates this too, per its
 * own doc) falls back to column 0 for the missing side, so it sorts alongside the route's start
 * rather than throwing.
 */
export function orderLegsByRoute(legs: FfPortalLegDto[]): FfPortalLegDto[] {
  const graph = buildScopedGraph(legs);
  const pointIds = graph.nodes.map((n) => n.pointId);
  const edges = graph.edges.map((e) => ({ originId: e.fromPointId, destinationId: e.toPointId }));
  const layout = computeRouteLayout(pointIds, edges, { splitComponents: true });

  return legs
    .map((leg, index) => {
      const originId = leg.endpoints[0]?.pointId ?? null;
      const destId = leg.endpoints[1]?.pointId ?? null;
      const originCol = originId != null ? (layout.nodes.get(originId)?.col ?? 0) : 0;
      const destCol = destId != null ? (layout.nodes.get(destId)?.col ?? originCol) : originCol;
      return { leg, index, originCol, destCol };
    })
    .sort((a, b) => a.originCol - b.originCol || a.destCol - b.destCol || a.index - b.index)
    .map((k) => k.leg);
}
