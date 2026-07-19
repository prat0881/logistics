import { useQueryClient } from "@tanstack/react-query";
import type { PointSaveInput, PointUpdateInput } from "@svyft/shared";
import { postJson, patchJson, del } from "@/lib/api";

/** Minimal shape of a persisted Point row returned by the API. */
export interface PointDto {
  id: string;
  queryId: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Point CRUD hook — mirrors useCargo but for the /points endpoint.
 * Every write invalidates ["query", queryId] so detail.points refreshes.
 */
export function usePoints(queryId: string) {
  const qc = useQueryClient();
  const bust = () => qc.invalidateQueries({ queryKey: ["query", queryId] });

  return {
    add: async (input: PointSaveInput): Promise<PointDto> => {
      const r = await postJson<PointDto>(
        `/api/queries/${queryId}/points`,
        input,
      );
      await bust();
      return r;
    },

    update: async (
      pointId: string,
      input: PointUpdateInput,
    ): Promise<PointDto> => {
      const r = await patchJson<PointDto>(
        `/api/queries/${queryId}/points/${pointId}`,
        input,
      );
      await bust();
      return r;
    },

    remove: async (pointId: string): Promise<void> => {
      await del(`/api/queries/${queryId}/points/${pointId}`);
      await bust();
    },
  };
}
