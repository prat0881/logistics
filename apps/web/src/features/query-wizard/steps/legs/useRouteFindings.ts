import { useCallback, useMemo, useState } from "react";
import {
  validateRoute,
  dedupeFindings,
  type Finding,
  type QueryDetail,
} from "@svyft/shared";
import { postJson } from "@/lib/api";
import { toRouteGraph } from "./routeGraph";

export interface UseRouteFindings {
  /** Client-side findings — pure `validateRoute` at "draft" phase, deduped. */
  clientFindings: Finding[];
  /** Findings returned by the last server validation (empty until run). */
  serverFindings: Finding[];
  /** Merged + deduped client ∪ server findings. */
  all: Finding[];
  /** True while a server validation request is in flight. */
  validating: boolean;
  /**
   * Non-null when the last server validation call failed (network/5xx).
   * The client-side `clientFindings` still show; this surfaces a soft
   * fallback message near the "Validate route" button.
   */
  serverError: string | null;
  /** POST /api/queries/:id/validate?phase=draft, store + return the deduped findings. Never throws. */
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
    () => dedupeFindings(validateRoute(toRouteGraph(detail), "draft")),
    [detail],
  );

  const validateOnServer = useCallback(async (): Promise<Finding[]> => {
    setValidating(true);
    setServerError(null);
    try {
      const res = await postJson<{ findings: Finding[] }>(
        `/api/queries/${detail.id}/validate?phase=draft`,
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

  return { clientFindings, serverFindings, all, validating, serverError, validateOnServer };
}
