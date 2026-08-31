import { z } from "zod";

export const PocLevel = { PRIMARY: "PRIMARY", SECONDARY: "SECONDARY", NONE: "NONE" } as const;
export type PocLevel = (typeof PocLevel)[keyof typeof PocLevel];
export const POC_LEVELS: PocLevel[] = [PocLevel.PRIMARY, PocLevel.SECONDARY, PocLevel.NONE];

export const MasterStatus = { ACTIVE: "ACTIVE", INACTIVE: "INACTIVE" } as const;
export type MasterStatus = (typeof MasterStatus)[keyof typeof MasterStatus];
export const MASTER_STATUSES: MasterStatus[] = [MasterStatus.ACTIVE, MasterStatus.INACTIVE];

/** Extracted so Task 4's tightened schema and the FF and Warehouse tables share one pattern. */
export const E164 = /^\+[1-9]\d{6,14}$/;

/** The nine fields every contact table carries — Client, Freight Forwarder and Warehouse. */
export const contactCoreSchema = z.object({
  name: z.string().min(1).max(160),
  designation: z.string().max(120).optional(),
  email: z.string().email(),
  contactNo: z.string().regex(E164, "Phone must be E.164, e.g. +971501234567"),
  whatsappAvailable: z.boolean().default(false),
  wechatAvailable: z.boolean().default(false),
  botimAvailable: z.boolean().default(false),
  pocLevel: z.enum(POC_LEVELS as [PocLevel, ...PocLevel[]]).default(PocLevel.NONE),
  status: z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).default(MasterStatus.ACTIVE),
});

export const contactCreateSchema = contactCoreSchema;
export const contactUpdateSchema = contactCoreSchema.partial();
export type ContactCreateInput = z.input<typeof contactCreateSchema>;
export type ContactUpdateInput = z.input<typeof contactUpdateSchema>;

export interface ContactDto {
  id: string;
  name: string;
  designation: string | null;
  email: string;
  contactNo: string;
  whatsappAvailable: boolean;
  wechatAvailable: boolean;
  botimAvailable: boolean;
  pocLevel: PocLevel;
  status: MasterStatus;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
