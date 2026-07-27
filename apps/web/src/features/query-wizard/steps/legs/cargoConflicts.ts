import type { QueryLegDto } from "@svyft/shared";

/**
 * A cargo row must form a single Pickup→Delivery chain (D5 atomic cargo / rule R1):
 * it can ride several legs only *sequentially*, never leaving OR entering the same
 * point on two different legs. So when assigning cargo to the leg being edited
 * (origin O, destination D), any cargo already carried by ANOTHER leg that shares O
 * (a parallel departure — the "parallel drop" fork) or shares D (a parallel arrival —
 * merge) would break that rule. Returns a map of the offending cargoId → the
 * conflicting leg's code, so the editor can disable that cargo with an "already on L#"
 * note instead of letting the user build a route that only fails later at Create.
 *
 * A valid sequential chain (leg A's destination = leg B's origin) is NOT flagged: the
 * shared point is A's *destination* and B's *origin*, so it matches neither O nor D.
 */
export function computeCargoConflicts(
  legs: QueryLegDto[],
  current: {
    id?: string;
    originPointId?: string | null;
    destinationPointId?: string | null;
  },
): Map<string, string> {
  const conflicts = new Map<string, string>();
  const origin = current.originPointId ?? null;
  const dest = current.destinationPointId ?? null;
  if (!origin && !dest) return conflicts;

  for (const other of legs) {
    if (current.id && other.id === current.id) continue; // skip the leg being edited
    const sharesOrigin = origin != null && other.originPointId === origin;
    const sharesDest = dest != null && other.destinationPointId === dest;
    if (!sharesOrigin && !sharesDest) continue;
    for (const cid of other.assignedCargoIds) {
      if (!conflicts.has(cid)) conflicts.set(cid, other.legCode);
    }
  }
  return conflicts;
}
