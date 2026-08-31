import { orderLegsByRoute as sharedOrderLegsByRoute, type FfPortalLegDto } from "@svyft/shared";

/**
 * orderLegsByRoute — sorts legs into route-diagram TOPOLOGY order (left-to-right, matching
 * `ScopedRouteDiagram`'s node layout / the executive `RouteDiagram`), instead of the Prisma
 * ASSIGNMENT order `rfq.legs` arrives in (which tracks WHEN a leg was distributed to this FF, not
 * WHERE it sits on the route — design §4.8 finding #2).
 *
 * S5.9.3 Task 2 (P4): the topology engine AND the sort-with-tiebreak logic both now live in
 * `@svyft/shared`'s `orderLegsByRoute` (`packages/shared/src/route-layering.ts`) — lifted there so
 * the api's award/quotation snapshot builders, which need this exact same "order by route, not by
 * whatever order the database returned" fix, reuse ONE implementation instead of a second,
 * subtly-different one. This function is now a thin adapter: it hands the shared sorter two
 * accessors reading straight off `FfPortalLegDto.endpoints[0]/[1].pointId` (origin, then
 * destination — the order the api builds `endpoints` in) and returns whatever it sorts back.
 *
 * A leg missing one or both endpoints (defensive) falls back to column 0 for the missing side, so
 * it sorts alongside the route's start rather than throwing — see the shared function's own doc
 * comment for the full algorithm (graph construction, `computeRouteLayout({ splitComponents: true
 * })`, and the origin-column/destination-column/original-index sort key).
 */
export function orderLegsByRoute(legs: FfPortalLegDto[]): FfPortalLegDto[] {
  return sharedOrderLegsByRoute(
    legs,
    (leg) => leg.endpoints[0]?.pointId ?? null,
    (leg) => leg.endpoints[1]?.pointId ?? null,
  );
}
