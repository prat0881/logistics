// apps/web/src/lib/zones.ts
// Which IANA zone anchors each datetime field (Issue 3 anchor rules). Pure.
type PointLike = { id: string; type?: string | null; timezone?: string | null };
type LegLike = { originPointId?: string | null; destinationPointId?: string | null };
type GraphLike = {
  points: PointLike[];
  legs: LegLike[];
  readyDateTimezone?: string | null;
  targetDeliveryTimezone?: string | null;
};

export type QueryZonedField =
  | "queryDate"
  | "responseDeadline"
  | "readyDate"
  | "targetDelivery"
  | "eta"
  | "etb"
  | "etd";

const viewer = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const zoneOf = (p?: PointLike, org?: string) => p?.timezone || org || "UTC"; // || (not ??): empty-string timezone is invalid → fall through to org

export function resolveQueryFieldZone(
  field: QueryZonedField,
  graph: GraphLike,
  orgZone: string,
): string {
  const pts = graph.points ?? [];
  switch (field) {
    case "queryDate":
      return viewer(); // system/audit time
    case "responseDeadline":
      return orgZone; // internal SLA
    case "readyDate":
      return graph.readyDateTimezone || orgZone;
    case "targetDelivery":
      return graph.targetDeliveryTimezone || orgZone;
    case "eta":
    case "etb":
    case "etd": {
      const seaport = pts.find((p) => p.type === "SEAPORT");
      return seaport ? zoneOf(seaport, orgZone) : orgZone;
    }
  }
}

export function resolveLegFieldZone(
  field: "readyDate" | "targetDelivery",
  leg: LegLike,
  points: PointLike[],
  orgZone: string,
): string {
  const id = field === "readyDate" ? leg.originPointId : leg.destinationPointId;
  const pt = points.find((p) => p.id === id);
  return zoneOf(pt, orgZone);
}
