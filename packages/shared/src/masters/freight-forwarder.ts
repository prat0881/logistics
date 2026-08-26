import { z } from "zod";
import { MASTER_STATUSES, type MasterStatus } from "./contacts";
import { FREIGHT_MODES, type FreightMode } from "../config";
import { COUNTRY_CODES, CURRENCY_CODES } from "../reference";

const statusField = z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional();

export const freightForwarderCreateSchema = z.object({
  companyName: z.string().min(1).max(200),
  companyAddress: z.string().max(500).optional(),
  city: z.string().max(120).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(120).optional(),
  pic: z.string().min(1).max(160),
  contactNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164"),
  email: z.string().email(),
  availableCountries: z.array(z.enum(COUNTRY_CODES)).min(1, "Select at least one country"),
  modes: z.array(z.enum(FREIGHT_MODES)).min(1, "Select at least one mode"),
  handleDg: z.boolean().optional(),
  vatTrnEori: z.string().max(100).optional(),
  whLocation: z.string().max(200).optional(),
  defaultCurrency: z.enum(CURRENCY_CODES).optional(),
  paymentTerms: z.string().max(200).optional(),
  typicalLeadTime: z.string().max(60).optional(),
  status: statusField,
});
export const freightForwarderUpdateSchema = freightForwarderCreateSchema.partial();
export type FreightForwarderCreateInput = z.infer<typeof freightForwarderCreateSchema>;
export type FreightForwarderUpdateInput = z.infer<typeof freightForwarderUpdateSchema>;

export interface FreightForwarderDto {
  id: string;
  freightForwarderCode: string;
  companyName: string;
  companyAddress: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  pic: string;
  contactNumber: string;
  email: string;
  availableCountries: string[];
  modes: FreightMode[];
  handleDg: boolean;
  vatTrnEori: string | null;
  whLocation: string | null;
  defaultCurrency: string | null;
  paymentTerms: string | null;
  typicalLeadTime: string | null;
  status: MasterStatus;
}
