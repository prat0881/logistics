import { useQueryClient } from "@tanstack/react-query";
import type { CargoCreateInput, CargoUpdateInput, CargoDto, Finding } from "@svyft/shared";
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

    uploadMsds: async (cid: string, file: File): Promise<CargoDto> => {
      const fd = new FormData();
      fd.append("file", file); // field name MUST be "file"; do NOT set Content-Type
      const res = await fetch(`/api/queries/${queryId}/cargo/${cid}/msds`, {
        method: "POST",
        credentials: "include",
        body: fd,
        // deliberately no Content-Type header — browser sets multipart boundary
      });
      if (!res.ok) {
        let b: Record<string, unknown> | undefined;
        try {
          b = await res.json();
        } catch {
          // ignore parse errors
        }
        throw new ApiError(
          res.status,
          (b?.message as string) ?? "Upload failed",
          b?.findings as Finding[] | undefined,
          b?.issues as unknown[] | undefined,
          b,
        );
      }
      await bust();
      return res.json() as Promise<CargoDto>;
    },

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
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
