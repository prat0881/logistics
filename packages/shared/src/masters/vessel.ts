import { z } from "zod";
import { MASTER_STATUSES, type MasterStatus } from "./contacts";

const statusField = z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional();

export const VesselType = {
  CONTAINER: "CONTAINER",
  BULK_CARRIER: "BULK_CARRIER",
  TANKER: "TANKER",
  RORO: "RORO",
  GENERAL_CARGO: "GENERAL_CARGO",
  REEFER: "REEFER",
  OTHER: "OTHER",
} as const;
export type VesselType = (typeof VesselType)[keyof typeof VesselType];
export const VESSEL_TYPES = Object.values(VesselType) as [VesselType, ...VesselType[]];

export const vesselCreateSchema = z.object({
  name: z.string().min(1).max(200),
  imoNumber: z
    .string()
    .regex(/^\d{7}$/, "IMO must be 7 digits")
    .optional(),
  shippingLine: z.string().max(160).optional(),
  vesselType: z.enum(VESSEL_TYPES),
  status: statusField,
});
export const vesselUpdateSchema = vesselCreateSchema.partial();
export type VesselCreateInput = z.infer<typeof vesselCreateSchema>;
export type VesselUpdateInput = z.infer<typeof vesselUpdateSchema>;

export interface VesselDto {
  id: string;
  vesselCode: string;
  name: string;
  imoNumber: string | null;
  shippingLine: string | null;
  vesselType: VesselType;
  status: MasterStatus;
}
