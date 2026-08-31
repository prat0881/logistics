/**
 * routeLayering — re-exports the shared route-topology layout engine.
 *
 * The pure algorithm (`computeLongestPathDepth`/`computeRouteLayout`) lived here originally, used
 * by the executive `RouteDiagram` (query-wizard/steps/legs) and the FF-portal
 * `ScopedRouteDiagram`. S5.9.3 Task 2 (P4) lifted it into `packages/shared/src/route-layering.ts`
 * so a third, non-React consumer (the api's award/quotation leg-ordering) could reuse the exact
 * same engine instead of a second, subtly different one. This file now just re-exports it under
 * its original path so every existing `@/lib/routeLayering` import keeps working unchanged.
 */
export {
  computeLongestPathDepth,
  computeRouteLayout,
  type LayeringEdge,
  type RouteLayout,
  type RouteLayoutNode,
} from "@svyft/shared";
