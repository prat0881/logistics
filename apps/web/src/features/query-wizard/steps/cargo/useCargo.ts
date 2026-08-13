import { useQueryClient } from "@tanstack/react-query";
import type { CargoCreateInput, CargoUpdateInput, CargoDto } from "@svyft/shared";
import { postJson, patchJson, del, ApiError } from "@/lib/api";

export function useCargo(queryId: string) {
  const qc = useQueryClient();
  const bust = () => qc.invalidateQueries({ queryKey: ["query", queryId] });

  return {
    add: async (input: CargoCreateInput): Promise<CargoDto> => {
      const r = await postJson<CargoDto>(`/api/queries/${queryId}/cargo`, input);
      await bust();
      return r;
    },

    update: async (cid: string, input: CargoUpdateInput): Promise<CargoDto> => {
      const r = await patchJson<CargoDto>(`/api/queries/${queryId}/cargo/${cid}`, input);
      await bust();
      return r;
    },

    remove: async (cid: string): Promise<void> => {
      await del(`/api/queries/${queryId}/cargo/${cid}`);
      await bust();
    },

    // MSDS is a package concern now (Unit W1) — see usePackages().uploadMsds. Cargo no longer
    // carries productName/qty/isDangerous/dims/msdsFileId.
    exportXlsx: async (): Promise<void> => {
      const res = await fetch(`/api/queries/${queryId}/cargo/export`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new ApiError(res.status, "Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `query-${queryId}-cargo.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  };
}
