import { useQueryClient } from "@tanstack/react-query";
import type { PackageCreateInput, PackageUpdateInput, PackageDto, Finding } from "@svyft/shared";
import { postJson, patchJson, del, ApiError } from "@/lib/api";

export function usePackages(queryId: string, cargoId: string) {
  const qc = useQueryClient();
  const bust = () => qc.invalidateQueries({ queryKey: ["query", queryId] });

  return {
    add: async (input: PackageCreateInput): Promise<PackageDto> => {
      const r = await postJson<PackageDto>(
        `/api/queries/${queryId}/cargo/${cargoId}/packages`,
        input,
      );
      await bust();
      return r;
    },

    update: async (pid: string, input: PackageUpdateInput): Promise<PackageDto> => {
      const r = await patchJson<PackageDto>(
        `/api/queries/${queryId}/cargo/${cargoId}/packages/${pid}`,
        input,
      );
      await bust();
      return r;
    },

    remove: async (pid: string): Promise<void> => {
      await del(`/api/queries/${queryId}/cargo/${cargoId}/packages/${pid}`);
      await bust();
    },

    uploadMsds: async (pid: string, file: File): Promise<PackageDto> => {
      const fd = new FormData();
      fd.append("file", file); // field name MUST be "file"; do NOT set Content-Type
      const res = await fetch(`/api/queries/${queryId}/cargo/${cargoId}/packages/${pid}/msds`, {
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
      return res.json() as Promise<PackageDto>;
    },

    copy: async (pid: string, count: number): Promise<PackageDto[]> => {
      const r = await postJson<PackageDto[]>(
        `/api/queries/${queryId}/cargo/${cargoId}/packages/${pid}/copies`,
        { count },
      );
      await bust();
      return r;
    },
  };
}
