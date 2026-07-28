// packages/shared/src/route.ts
import type { Finding, Severity } from "./findings";
import type { FreightMode } from "./config";
import { PointType, POINT_REQUIRED_FIELDS } from "./points";

export interface RouteGraphQuery {
  id: string;
  readyDate: Date | string | null;
  targetDelivery: Date | string | null;
}
export interface RoutePoint {
  id: string;
  type: PointType;
  name: string | null;
  streetAddress: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  warehouseType: string | null;
  iataCode: string | null;
  icaoCode: string | null;
  unLocode: string | null;
  terminal: string | null;
  timezone: string | null;
}
export interface RouteLeg {
  id: string;
  legCode: string;
  mode: FreightMode | null;
  originPointId: string | null;
  destinationPointId: string | null;
  readyDate: Date | string | null;
  targetDelivery: Date | string | null;
}
export interface RouteCargo {
  id: string;
  poReference: string;
  isDangerous: boolean;
  msdsFileId: string | null;
  grossWt: number | string | null;
  volumeCbm: number | string | null;
}
export interface RouteGraph {
  query: RouteGraphQuery;
  points: RoutePoint[];
  legs: RouteLeg[];
  cargo: RouteCargo[];
  legCargo: { legId: string; cargoItemId: string }[];
}
export type RoutePhase = "draft" | "create";

// V-M1 predicate (spec §10.4): AIR ⇒ both airports; SEA ⇒ both seaports; ROAD ⇒ any
// (pickup/delivery/warehouse/port-drayage). Reused by LegsService for pre-write rejection.
export function checkModeEndpoints(mode: FreightMode, originType: PointType, destType: PointType): boolean {
  if (mode === "AIR") return originType === PointType.AIRPORT && destType === PointType.AIRPORT;
  if (mode === "SEA") return originType === PointType.SEAPORT && destType === PointType.SEAPORT;
  return true; // ROAD
}

function pushToMap<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}
function toTime(d: Date | string | null): number | null {
  if (d === null || d === undefined) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
}

export function validateRoute(graph: RouteGraph, phase: RoutePhase): Finding[] {
  const findings: Finding[] = [];
  const block = phase === "create";
  const sev = (alwaysBlocking = false): Severity => (block || alwaysBlocking ? "blocking" : "warning");

  const pointById = new Map(graph.points.map((p) => [p.id, p] as const));
  const cargoById = new Map(graph.cargo.map((c) => [c.id, c] as const));
  const legById = new Map(graph.legs.map((l) => [l.id, l] as const));
  const nameOf = (pid: string): string => pointById.get(pid)?.name ?? pid;

  const legsByCargo = new Map<string, string[]>();
  const cargosByLeg = new Map<string, string[]>();
  for (const lc of graph.legCargo) {
    pushToMap(legsByCargo, lc.cargoItemId, lc.legId);
    pushToMap(cargosByLeg, lc.legId, lc.cargoItemId);
  }

  // R5 — minimum route: at least one saved leg, and every leg connects two DIFFERENT
  // points (no self-loop). Relaxed from the old "must have a Pickup and a Delivery point":
  // with R2 allowing any non-Delivery start and any end, the route just needs a real leg.
  // Point typing / continuity stay with R2/R3/R1/R4/R6.
  if (graph.legs.length === 0)
    findings.push({ rule: "R5", severity: sev(), scope: { type: "query", id: graph.query.id }, message: "A route needs at least one leg" });
  for (const leg of graph.legs) {
    if (leg.originPointId && leg.destinationPointId && leg.originPointId === leg.destinationPointId)
      findings.push({ rule: "R5", severity: sev(), scope: { type: "leg", id: leg.id }, message: `Leg ${leg.legCode} must connect two different points (its origin and destination are the same)` });
  }

  // R3 — no orphans.
  for (const leg of graph.legs) {
    if (!(cargosByLeg.get(leg.id)?.length))
      findings.push({ rule: "R3", severity: sev(), scope: { type: "leg", id: leg.id }, message: `Leg ${leg.legCode} carries no cargo` });
  }
  for (const c of graph.cargo) {
    if (!(legsByCargo.get(c.id)?.length))
      findings.push({ rule: "R3", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference} is not assigned to any leg` });
  }
  const usedPoints = new Set<string>();
  for (const leg of graph.legs) {
    if (leg.originPointId) usedPoints.add(leg.originPointId);
    if (leg.destinationPointId) usedPoints.add(leg.destinationPointId);
  }
  for (const p of graph.points) {
    if (!usedPoints.has(p.id))
      findings.push({ rule: "R3", severity: sev(), scope: { type: "point", id: p.id }, message: `Point ${p.name ?? p.id} is not used by any leg` });
  }

  // C1 — leg completeness.
  for (const leg of graph.legs) {
    const missing: string[] = [];
    if (!leg.originPointId) missing.push("origin");
    if (!leg.destinationPointId) missing.push("destination");
    if (!leg.mode) missing.push("mode");
    if (!(cargosByLeg.get(leg.id)?.length)) missing.push("cargo");
    if (!leg.readyDate) missing.push("ready date");
    if (!leg.targetDelivery) missing.push("target delivery");
    if (missing.length)
      findings.push({ rule: "C1", severity: sev(), scope: { type: "leg", id: leg.id }, message: `Leg ${leg.legCode} is missing: ${missing.join(", ")}` });
  }

  // C3 — per-leg CBM + gross roll-up computes.
  for (const leg of graph.legs) {
    const cs = (cargosByLeg.get(leg.id) ?? []).map((id) => cargoById.get(id)).filter((c): c is RouteCargo => !!c);
    if (cs.length && cs.some((c) => c.grossWt == null || c.volumeCbm == null))
      findings.push({ rule: "C3", severity: sev(), scope: { type: "leg", id: leg.id }, message: `Leg ${leg.legCode} cannot compute its weight/volume roll-up` });
  }

  // V-M1 — mode ↔ endpoint (ALWAYS blocking).
  for (const leg of graph.legs) {
    if (!leg.mode || !leg.originPointId || !leg.destinationPointId) continue;
    const o = pointById.get(leg.originPointId);
    const d = pointById.get(leg.destinationPointId);
    if (o && d && !checkModeEndpoints(leg.mode, o.type, d.type))
      findings.push({ rule: "V-M1", severity: sev(true), scope: { type: "leg", id: leg.id }, message: `Leg ${leg.legCode} (${leg.mode}) endpoints are incompatible with its mode` });
  }

  // R7 — both endpoints carry a country.
  for (const leg of graph.legs) {
    for (const [role, pid] of [["origin", leg.originPointId], ["destination", leg.destinationPointId]] as const) {
      if (!pid) continue;
      const p = pointById.get(pid);
      if (p && !p.country)
        findings.push({ rule: "R7", severity: sev(), scope: { type: "point", id: p.id }, message: `Leg ${leg.legCode} ${role} point needs a Country` });
    }
  }

  // R8 — per-type mandatory point fields present.
  for (const p of graph.points) {
    const missing = POINT_REQUIRED_FIELDS[p.type].filter((f) => !p[f as keyof RoutePoint]);
    if (missing.length)
      findings.push({ rule: "R8", severity: sev(), scope: { type: "point", id: p.id }, message: `Point ${p.name ?? p.id} (${p.type}) is missing: ${missing.join(", ")}` });
  }

  // T3 — hub convergence (cross-cargo, §8.5): onward readyDate ≥ MAX feeding targetDelivery.
  const incomingByPoint = new Map<string, RouteLeg[]>();
  const outgoingByPoint = new Map<string, RouteLeg[]>();
  for (const l of graph.legs) {
    if (l.destinationPointId) pushToMap(incomingByPoint, l.destinationPointId, l);
    if (l.originPointId) pushToMap(outgoingByPoint, l.originPointId, l);
  }
  for (const [pid, incoming] of incomingByPoint) {
    const outgoing = outgoingByPoint.get(pid) ?? [];
    if (!outgoing.length) continue;
    const maxIn = incoming.reduce<number | null>((m, l) => {
      const t = toTime(l.targetDelivery);
      return t !== null && (m === null || t > m) ? t : m;
    }, null);
    if (maxIn === null) continue;
    for (const out of outgoing) {
      const rd = toTime(out.readyDate);
      if (rd !== null && rd < maxIn)
        findings.push({ rule: "T3", severity: sev(), scope: { type: "leg", id: out.id }, message: `Leg ${out.legCode} departs ${nameOf(pid)} before all feeding legs arrive (hub effective date)` });
    }
  }

  // Per cargo-row subgraph — R1/R2/R4/R6/C2/T1/R9.
  for (const c of graph.cargo) {
    const legs = (legsByCargo.get(c.id) ?? []).map((id) => legById.get(id)).filter((l): l is RouteLeg => !!l);
    if (legs.length === 0) continue; // R3 already flagged

    // R9 — DG cargo ⇒ MSDS present on every carrying leg.
    if (c.isDangerous && !c.msdsFileId) {
      for (const l of legs)
        findings.push({ rule: "R9", severity: sev(), scope: { type: "leg", id: l.id }, message: `Leg ${l.legCode} carries dangerous cargo ${c.poReference} without an MSDS` });
    }

    const edges = legs.filter((l) => l.originPointId && l.destinationPointId);
    if (edges.length === 0) continue; // C1 flags missing endpoints

    const indeg = new Map<string, number>();
    const outdeg = new Map<string, number>();
    const outEdges = new Map<string, RouteLeg[]>();
    const nodes = new Set<string>();
    for (const e of edges) {
      outdeg.set(e.originPointId!, (outdeg.get(e.originPointId!) ?? 0) + 1);
      indeg.set(e.destinationPointId!, (indeg.get(e.destinationPointId!) ?? 0) + 1);
      pushToMap(outEdges, e.originPointId!, e);
      nodes.add(e.originPointId!);
      nodes.add(e.destinationPointId!);
    }

    // R6 — mass balance: every node in==out except one source (out−in=1) and one sink (in−out=1).
    const sources: string[] = [];
    const sinks: string[] = [];
    let imbalanced = false;
    for (const n of nodes) {
      const di = indeg.get(n) ?? 0;
      const dor = outdeg.get(n) ?? 0;
      if (di === dor) continue;
      if (dor - di === 1) sources.push(n);
      else if (di - dor === 1) sinks.push(n);
      else imbalanced = true;
    }
    if (imbalanced)
      findings.push({ rule: "R6", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: a point does not balance (what enters must leave)` });

    if (sources.length !== 1 || sinks.length !== 1) {
      // Clarify the most common cause: one atomic cargo row (D5) split across parallel
      // legs — it leaves a point on >1 leg (fork / parallel drop) or arrives on >1 leg
      // (merge). Name the point + legs so the fix ("one cargo row per destination") is
      // obvious, instead of the generic "not a single continuous chain".
      const forkPt = [...outdeg.entries()].find(([, d]) => d > 1)?.[0];
      const mergePt = [...indeg.entries()].find(([, d]) => d > 1)?.[0];
      let message: string;
      if (forkPt) {
        const codes = (outEdges.get(forkPt) ?? []).map((e) => e.legCode).join(" & ");
        message = `Cargo ${c.poReference} can't be split across parallel legs — it leaves ${nameOf(forkPt)} on ${codes}. Give each destination its own cargo row.`;
      } else if (mergePt) {
        const codes = edges.filter((e) => e.destinationPointId === mergePt).map((e) => e.legCode).join(" & ");
        message = `Cargo ${c.poReference} can't be built from parallel legs — ${codes} both arrive at ${nameOf(mergePt)}. Give each origin its own cargo row.`;
      } else {
        message = `Cargo ${c.poReference}: its legs do not form a single continuous Pickup→Delivery chain`;
      }
      findings.push({ rule: "R1", severity: sev(), scope: { type: "cargo", id: c.id }, message });
      continue;
    }
    const start = sources[0];
    const end = sinks[0];
    const startP = pointById.get(start);
    // R2 (business rule): a cargo chain may START at any point type EXCEPT a Delivery —
    // a Delivery is where cargo arrives, never where it begins — and may END at any point
    // type (no end-type constraint). The single-unbroken-path requirement stays with
    // R1/R4/R6; R5 still requires the query to hold at least one Pickup and Delivery.
    if (startP && startP.type === PointType.DELIVERY)
      findings.push({ rule: "R2", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: chain can't start at a Delivery point — a Delivery is where cargo arrives, not where it begins` });

    // R1/R4/T1 — walk the unique chain start→end.
    const visited = new Set<string>();
    let cur = start;
    let steps = 0;
    let prevLeg: RouteLeg | null = null;
    let broke = false;
    while (cur !== end) {
      if (visited.has(cur)) {
        findings.push({ rule: "R4", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: route revisits ${nameOf(cur)} (cycle)` });
        broke = true;
        break;
      }
      visited.add(cur);
      const outs = outEdges.get(cur) ?? [];
      if (outs.length !== 1) {
        findings.push({ rule: "R1", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: broken or forking chain at ${nameOf(cur)}` });
        broke = true;
        break;
      }
      const leg = outs[0];
      if (prevLeg) {
        const prevArr = toTime(prevLeg.targetDelivery);
        const dep = toTime(leg.readyDate);
        if (prevArr !== null && dep !== null && dep < prevArr)
          findings.push({ rule: "T1", severity: sev(), scope: { type: "leg", id: leg.id }, message: `Leg ${leg.legCode} departs before the previous leg arrives` });
      }
      prevLeg = leg;
      cur = leg.destinationPointId!;
      steps++;
      if (steps > edges.length) {
        findings.push({ rule: "R4", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: route does not terminate (cycle)` });
        broke = true;
        break;
      }
    }

    // C2 — all of this row's legs consumed by the single chain.
    if (!broke && steps !== edges.length)
      findings.push({ rule: "C2", severity: sev(), scope: { type: "cargo", id: c.id }, message: `Cargo ${c.poReference}: not all its legs form one continuous chain` });
  }

  return findings;
}
