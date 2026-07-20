import { useQueryClient } from "@tanstack/react-query";
import type { LegSaveInput } from "@svyft/shared";
import { postJson, patchJson, del } from "@/lib/api";

/** Minimal shape of a persisted Leg row returned by the API (raw write response). */
export interface LegDto {
  id: string;
  queryId: string;
  legCode?: string;
  mode?: string | null;
  originPointId?: string | null;
  destinationPointId?: string | null;
  [key: string]: unknown;
}

/**
 * Leg CRUD hook — POST/PATCH/DELETE /api/queries/:id/legs[/:legId].
 *
 * Important: the write response is the raw Leg row and does NOT include
 * `assignedCargoIds` or `rollup`. Those fields only appear on `detail.legs[]`
 * after a re-GET (triggered by invalidating ["query", queryId]).
 *
 * A 422 from the server (V-M1 mode↔endpoint violation) propagates as an
 * ApiError with `.findings` — the postJson/patchJson helpers in @/lib/api
 * already handle this.
 */
export function useLegs(queryId: string) {
  const qc = useQueryClient();
  const bust = () => qc.invalidateQueries({ queryKey: ["query", queryId] });

  return {
    add: async (input: LegSaveInput): Promise<LegDto> => {
      const r = await postJson<LegDto>(
        `/api/queries/${queryId}/legs`,
        input,
      );
      await bust();
      return r;
    },

    update: async (legId: string, input: LegSaveInput): Promise<LegDto> => {
      const r = await patchJson<LegDto>(
        `/api/queries/${queryId}/legs/${legId}`,
        input,
      );
      await bust();
      return r;
    },

    remove: async (legId: string): Promise<void> => {
      await del(`/api/queries/${queryId}/legs/${legId}`);
      await bust();
    },
  };
}
