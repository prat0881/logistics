import { z } from "zod";

export const FreightMode = { ROAD: "ROAD", AIR: "AIR", SEA: "SEA" } as const;
export type FreightMode = (typeof FreightMode)[keyof typeof FreightMode];
export const FREIGHT_MODES = Object.values(FreightMode) as [FreightMode, ...FreightMode[]];

export const densityFactorUpdateSchema = z.object({ kgPerCbm: z.number().int().positive() });
export type DensityFactorUpdateInput = z.infer<typeof densityFactorUpdateSchema>;

export const checklistItemUpdateSchema = z
  .object({
    label: z.string().min(1).max(200),
    order: z.number().int().min(0),
    dgConditional: z.boolean(),
  })
  .partial();
export type ChecklistItemUpdateInput = z.infer<typeof checklistItemUpdateSchema>;

export interface DensityFactorDto {
  mode: FreightMode;
  kgPerCbm: number;
}
export interface ChecklistItemDto {
  itemKey: string;
  label: string;
  order: number;
  dgConditional: boolean;
}
