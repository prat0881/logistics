import { z } from "zod";

export const MasterStatus = { ACTIVE: "ACTIVE", INACTIVE: "INACTIVE" } as const;
export type MasterStatus = (typeof MasterStatus)[keyof typeof MasterStatus];
export const MASTER_STATUSES: MasterStatus[] = [MasterStatus.ACTIVE, MasterStatus.INACTIVE];

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

const statusField = z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional();

export const clientCreateSchema = z.object({
  companyName: z.string().min(1).max(200),
  industry: z.string().max(120).optional(),
  country: z.string().min(1).max(120),
  status: statusField,
});
export const clientUpdateSchema = clientCreateSchema.partial();
export type ClientCreateInput = z.infer<typeof clientCreateSchema>;
export type ClientUpdateInput = z.infer<typeof clientUpdateSchema>;

export const contactCreateSchema = z.object({
  name: z.string().min(1).max(160),
  designation: z.string().max(120).optional(),
  contactNo: z.string().max(40).optional(),
  email: z.string().email().optional(),
  isPrimary: z.boolean().optional(),
});
export const contactUpdateSchema = contactCreateSchema.partial();
export type ContactCreateInput = z.infer<typeof contactCreateSchema>;
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;

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

export interface ContactDto {
  id: string;
  name: string;
  designation: string | null;
  contactNo: string | null;
  email: string | null;
  isPrimary: boolean;
}
export interface ClientDto {
  id: string;
  clientCode: string;
  companyName: string;
  industry: string | null;
  country: string;
  status: MasterStatus;
  contacts?: ContactDto[];
}
export interface VesselDto {
  id: string;
  vesselCode: string;
  name: string;
  imoNumber: string | null;
  shippingLine: string | null;
  vesselType: VesselType;
  status: MasterStatus;
}
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
