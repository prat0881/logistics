import { useCallback, useMemo, useState } from "react";
import {
  validateRoute,
  dedupeFindings,
  type Finding,
  type QueryDetail,
} from "@svyft/shared";
import { postJson } from "@/lib/api";
import { toRouteGraph } from "./routeGraph";

export interface GroupedFindings {
  /** Findings for each leg id (leg-scoped + cargo-scoped fanned onto carrying legs). */
  byLeg: Map<string, Finding[]>;
  /** Findings for each point id. */
  byPoint: Map<string, Finding[]>;
  /** Findings not tied to a specific box — rendered in the top strip. */
  queryScoped: Finding[];
  /** All blocking findings (strip count + Next-gate). */
  blocking: Finding[];
}

/**
 * Group findings by the box they belong to. Cargo-scoped findings fan onto the
 * legs carrying that cargo (mirrors the RouteDiagram). A cargo finding with no
 * carrying leg, and any query/field-scoped finding, go to `queryScoped` (the top
 * strip). Pure — exported for tests.
 */
export function groupFindingsByScope(
  findings: Finding[],
  legs: { id: string; assignedCargoIds: string[] }[],
): GroupedFindings {
  const byLeg = new Map<string, Finding[]>();
  const byPoint = new Map<string, Finding[]>();
  const queryScoped: Finding[] = [];
  const push = (map: Map<string, Finding[]>, id: string, f: Finding) => {
    const arr = map.get(id);
    if (arr) arr.push(f);
    else map.set(id, [f]);
  };
  for (const f of findings) {
    const { type, id } = f.scope;
    if (type === "leg" && id) push(byLeg, id, f);
    else if (type === "point" && id) push(byPoint, id, f);
    else if (type === "cargo" && id) {
      const carrying = legs.filter((l) => l.assignedCargoIds.includes(id));
      if (carrying.length) carrying.forEach((l) => push(byLeg, l.id, f));
      else queryScoped.push(f);
    } else {
      queryScoped.push(f);
    }
  }
  return {
    byLeg,
    byPoint,
    queryScoped,
    blocking: findings.filter((f) => f.severity === "blocking"),
  };
}

export interface UseRouteFindings {
  /** Client-side findings — pure `validateRoute` at "create" phase, deduped. */
  clientFindings: Finding[];
  /** Findings returned by the last server validation (empty until run). */
  serverFindings: Finding[];
  /** Merged + deduped client ∪ server findings. */
  all: Finding[];
  /** `all` grouped by box scope (for the top strip + per-box hover). */
  grouped: GroupedFindings;
  /** True while a server validation request is in flight. */
  validating: boolean;
  /**
   * Non-null when the last server validation call failed (network/5xx).
   * The client-side `clientFindings` still show; this surfaces a soft
   * fallback message near the "Validate route" button.
   */
  serverError: string | null;
  /** POST /api/queries/:id/validate?phase=create, store + return the deduped findings. Never throws. */
  validateOnServer: () => Promise<Finding[]>;
}

/**
 * useRouteFindings — the isomorphic route validation feed for the RouteDiagram
 * and FindingsPanel.
 *
 * The engine (`validateRoute`) is pure + browser-safe, so we run it client-side
 * on every `detail` change for instant feedback (`clientFindings`). The server
 * validation is authoritative (it re-reads the persisted graph) and is fetched
 * on demand via the "Validate route" button. `all` merges both, deduped — the
 * engine can emit duplicate findings, so dedupe is applied at every layer.
 */
export function useRouteFindings(detail: QueryDetail): UseRouteFindings {
  const [serverFindings, setServerFindings] = useState<Finding[]>([]);
  const [validating, setValidating] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const clientFindings = useMemo(
    () => dedupeFindings(validateRoute(toRouteGraph(detail), "create")),
    [detail],
  );

  const validateOnServer = useCallback(async (): Promise<Finding[]> => {
    setValidating(true);
    setServerError(null);
    try {
      const res = await postJson<{ findings: Finding[] }>(
        `/api/queries/${detail.id}/validate?phase=create`,
      );
      const deduped = dedupeFindings(res.findings);
      setServerFindings(deduped);
      return deduped;
    } catch {
      setServerError(
        "Couldn't reach the validation service — showing local checks only",
      );
      return [];
    } finally {
      setValidating(false);
    }
  }, [detail.id]);

  const all = useMemo(
    () => dedupeFindings([...clientFindings, ...serverFindings]),
    [clientFindings, serverFindings],
  );

  const grouped = useMemo(() => groupFindingsByScope(all, detail.legs), [all, detail.legs]);

  return { clientFindings, serverFindings, all, grouped, validating, serverError, validateOnServer };
}
