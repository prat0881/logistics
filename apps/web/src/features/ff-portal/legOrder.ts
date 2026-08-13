import type { FfPortalLegDto } from "@svyft/shared";
import { computeLongestPathDepth } from "@/lib/routeLayering";
import { buildScopedGraph } from "./ScopedRouteDiagram";

/**
 * orderLegsByRoute — sorts legs into route-diagram TOPOLOGY order (left-to-right, matching
 * `ScopedRouteDiagram`'s node layout / the executive `RouteDiagram`), instead of the Prisma
 * ASSIGNMENT order `rfq.legs` arrives in (which tracks WHEN a leg was distributed to this FF, not
 * WHERE it sits on the route — design §4.8 finding #2).
 *
 * Reuses the SAME graph-construction (`buildScopedGraph`) + depth primitive
 * (`computeLongestPathDepth`) `ScopedRouteDiagram` itself uses for its node x-positions, so leg
 * render order and diagram layout can never silently drift apart the way finding #1 (single-row,
 * assignment-ordered diagram) once did. Deliberately stops at raw depth (not the full
 * `computeRouteLayout` grid — no pixel math, no row-stacking, no component-splitting) because
 * only RELATIVE order is needed here, and column RANK (what `computeRouteLayout` produces) is a
 * strictly increasing function of raw depth — so sorting by depth directly yields the same
 * relative order as sorting by rank, without laying out a grid.
 *
 * Sort key: a leg's ORIGIN node's topological depth (`endpoints[0]`), tie-broken by its
 * DESTINATION node's depth (`endpoints[1]`), then by original array position (stable) — so legs
 * that fork from a shared origin, or are otherwise indistinguishable by depth, keep their
 * relative assignment order instead of reordering arbitrarily.
 *
 * A leg missing one or both endpoints (defensive — `buildScopedGraph` tolerates this too, per its
 * own doc) falls back to depth 0 for the missing side, so it sorts alongside the route's start
 * rather than throwing.
 */
export function orderLegsByRoute(legs: FfPortalLegDto[]): FfPortalLegDto[] {
  const graph = buildScopedGraph(legs);
  const depth = computeLongestPathDepth(
    graph.nodes.map((n) => n.pointId),
    graph.edges.map((e) => ({ originId: e.fromPointId, destinationId: e.toPointId })),
  );

  return legs
    .map((leg, index) => {
      const originId = leg.endpoints[0]?.pointId ?? null;
      const destId = leg.endpoints[1]?.pointId ?? null;
      const originDepth = originId != null ? (depth.get(originId) ?? 0) : 0;
      const destDepth = destId != null ? (depth.get(destId) ?? originDepth) : originDepth;
      return { leg, index, originDepth, destDepth };
    })
    .sort((a, b) => a.originDepth - b.originDepth || a.destDepth - b.destDepth || a.index - b.index)
    .map((k) => k.leg);
}
