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
