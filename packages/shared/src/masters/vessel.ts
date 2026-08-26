import { z } from "zod";
import { MASTER_STATUSES, type MasterStatus } from "./contacts";

const statusField = z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional();

export const vesselCreateSchema = z.object({
  name: z.string().min(1).max(200),
  imoNumber: z.string().regex(/^\d{7}$/, "IMO must be 7 digits"),
  shippingLine: z.string().min(1).max(160),
  vesselType: z.string().min(1).max(120),
  status: statusField,
});
export const vesselUpdateSchema = vesselCreateSchema.partial();
export type VesselCreateInput = z.infer<typeof vesselCreateSchema>;
export type VesselUpdateInput = z.infer<typeof vesselUpdateSchema>;

export interface VesselDto {
  id: string;
  vesselCode: string;
  name: string;
  imoNumber: string;
  shippingLine: string;
  vesselType: string;
  status: MasterStatus;
}
