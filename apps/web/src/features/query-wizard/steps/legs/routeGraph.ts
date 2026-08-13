import type {
  QueryDetail,
  RouteGraph,
  RouteLeg,
  RoutePoint,
  RouteCargo,
  PointType,
} from "@svyft/shared";

/**
 * toRouteGraph — pure mapper from the wizard's `QueryDetail` into the shared
 * `RouteGraph` shape consumed by `validateRoute` (browser-safe engine). This is
 * the CLIENT mirror of the API's `routing.service.ts` `buildGraph` — keep the
 * two in sync.
 *
 * Field mapping is 1:1 with the shared `RouteGraph` contract:
 *   - `query`      ← id / readyDate / targetDelivery
 *   - `points`     ← every point endpoint field (types/codes/contacts)
 *   - `legs`       ← legCode / mode / endpoints / dates
 *   - `cargo`      ← one RouteCargo per Package (the atomic unit that rides legs):
 *                    poReference from the parent Cargo grouping, productName/rowIndex/
 *                    msdsFileId/grossWt/volumeCbm from the Package, isDangerous from the
 *                    Package's effectiveTags (own ∪ item tags)
 *   - `legCargo`   ← flat-mapped from each leg's `assignedPackageIds` (packageId rides the
 *                    legacy `cargoItemId` slot — RouteGraph is grain-agnostic, so no shared
 *                    type change is needed for the new grain)
 *
 * Prisma `Decimal` columns arrive as strings in the DTO; they are passed
 * through untouched — `validateRoute` coerces them itself.
 */
export function toRouteGraph(detail: QueryDetail): RouteGraph {
  const points: RoutePoint[] = detail.points.map((p) => ({
    id: p.id,
    type: p.type as PointType,
    name: p.name,
    streetAddress: p.streetAddress,
    city: p.city,
    postalCode: p.postalCode,
    country: p.country,
    contactName: p.contactName,
    contactPhone: p.contactPhone,
    contactEmail: p.contactEmail,
    warehouseType: p.warehouseType,
    iataCode: p.iataCode,
    icaoCode: p.icaoCode,
    unLocode: p.unLocode,
    terminal: p.terminal,
    timezone: p.timezone ?? null,
  }));

  const legs: RouteLeg[] = detail.legs.map((l) => ({
    id: l.id,
    legCode: l.legCode,
    mode: l.mode,
    originPointId: l.originPointId,
    destinationPointId: l.destinationPointId,
    readyDate: l.readyDate,
    targetDelivery: l.targetDelivery,
  }));

  const cargo: RouteCargo[] = detail.cargos.flatMap((c) =>
    c.packages.map((p) => ({
      id: p.id,
      poReference: c.poReference ?? "", // parent cargo's PO; RouteCargo.poReference is `string`
      productName: p.packageNo, // best per-package label (cargoLabel fallback)
      rowIndex: p.rowIndex,
      isDangerous: p.effectiveTags.includes("DG"),
      msdsFileId: p.msdsFileId,
      grossWt: p.grossWt, // string DTO value, passed through (validateRoute coerces)
      volumeCbm: p.volumeCbm,
    })),
  );

  const legCargo = detail.legs.flatMap((l) =>
    l.assignedPackageIds.map((pid) => ({ legId: l.id, cargoItemId: pid })),
  );

  return {
    query: {
      id: detail.id,
      readyDate: detail.readyDate,
      targetDelivery: detail.targetDelivery,
    },
    points,
    legs,
    cargo,
    legCargo,
  };
}
