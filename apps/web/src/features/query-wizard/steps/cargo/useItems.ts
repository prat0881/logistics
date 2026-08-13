import { useQueryClient } from "@tanstack/react-query";
import type { ItemCreateInput, ItemUpdateInput, ItemDto } from "@svyft/shared";
import { postJson, patchJson, del } from "@/lib/api";

export function useItems(queryId: string, cargoId: string, packageId: string) {
  const qc = useQueryClient();
  const bust = () => qc.invalidateQueries({ queryKey: ["query", queryId] });

  const base = `/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items`;

  return {
    add: async (input: ItemCreateInput): Promise<ItemDto> => {
      const r = await postJson<ItemDto>(base, input);
      await bust();
      return r;
    },

    update: async (iid: string, input: ItemUpdateInput): Promise<ItemDto> => {
      const r = await patchJson<ItemDto>(`${base}/${iid}`, input);
      await bust();
      return r;
    },

    remove: async (iid: string): Promise<void> => {
      await del(`${base}/${iid}`);
      await bust();
    },
  };
}
