import { z } from "zod";
import { MASTER_STATUSES, type MasterStatus } from "./contacts";
import type { ContactDto } from "./contacts";

const statusField = z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional();

export const clientCreateSchema = z.object({
  companyName: z.string().min(1).max(200),
  industry: z.string().max(120).optional(),
  country: z.string().min(1).max(120),
  streetAddress: z.string().min(1).max(300),
  city: z.string().min(1).max(120),
  postalCode: z.string().max(20).optional(),
  status: statusField,
});
export const clientUpdateSchema = clientCreateSchema.partial();
export type ClientCreateInput = z.infer<typeof clientCreateSchema>;
export type ClientUpdateInput = z.infer<typeof clientUpdateSchema>;

export interface ClientDto {
  id: string;
  clientCode: string;
  companyName: string;
  industry: string | null;
  country: string;
  streetAddress: string;
  city: string;
  postalCode: string | null;
  status: MasterStatus;
  contacts?: ContactDto[];
}
