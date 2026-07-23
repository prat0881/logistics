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
 * `RouteGraph` shape consumed by `validateRoute` (browser-safe engine).
 *
 * Field mapping is 1:1 with the shared `RouteGraph` contract:
 *   - `query`      ← id / readyDate / targetDelivery
 *   - `points`     ← every point endpoint field (types/codes/contacts)
 *   - `legs`       ← legCode / mode / endpoints / dates
 *   - `cargo`      ← poReference / isDangerous / msdsFileId / grossWt / volumeCbm
 *   - `legCargo`   ← flat-mapped from each leg's `assignedCargoIds`
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

  const cargo: RouteCargo[] = detail.cargo.map((c) => ({
    id: c.id,
    poReference: c.poReference,
    isDangerous: c.isDangerous,
    msdsFileId: c.msdsFileId,
    grossWt: c.grossWt,
    volumeCbm: c.volumeCbm,
  }));

  const legCargo = detail.legs.flatMap((l) =>
    l.assignedCargoIds.map((cid) => ({ legId: l.id, cargoItemId: cid })),
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
