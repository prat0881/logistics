import { z } from "zod";
import {
  MASTER_STATUSES,
  contactUpsertSchema,
  exactlyOnePrimary,
  atMostOnePrimary,
  PRIMARY_REQUIRED_MESSAGE,
  PRIMARY_DUPLICATE_MESSAGE,
  type MasterStatus,
  type ContactDto,
} from "./contacts";

const statusField = z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional();

const clientCore = z.object({
  companyName: z.string().min(1).max(200),
  industry: z.string().max(120).optional(),
  country: z.string().min(1).max(120),
  streetAddress: z.string().min(1).max(300),
  city: z.string().min(1).max(120),
  postalCode: z.string().max(20).optional(),
  status: statusField,
});

const warehouseIdsField = z.array(z.string().uuid()).optional();

export const clientCreateSchema = clientCore.extend({
  contacts: z
    .array(contactUpsertSchema)
    .min(1)
    .refine(exactlyOnePrimary, { message: PRIMARY_REQUIRED_MESSAGE }),
  warehouseIds: warehouseIdsField,
});

// NOT `clientCreateSchema.partial()`: that would keep the create-time min(1)/exactly-one rule
// on the array itself, blocking every legacy client that has no primary from ever being saved.
export const clientUpdateSchema = clientCore.partial().extend({
  contacts: z
    .array(contactUpsertSchema)
    .refine(atMostOnePrimary, { message: PRIMARY_DUPLICATE_MESSAGE })
    .optional(),
  warehouseIds: warehouseIdsField,
});
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
