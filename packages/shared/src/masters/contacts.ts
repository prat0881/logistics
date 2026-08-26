import { z } from "zod";

export const PocLevel = { PRIMARY: "PRIMARY", SECONDARY: "SECONDARY", NONE: "NONE" } as const;
export type PocLevel = (typeof PocLevel)[keyof typeof PocLevel];
export const POC_LEVELS: PocLevel[] = [PocLevel.PRIMARY, PocLevel.SECONDARY, PocLevel.NONE];

export const MasterStatus = { ACTIVE: "ACTIVE", INACTIVE: "INACTIVE" } as const;
export type MasterStatus = (typeof MasterStatus)[keyof typeof MasterStatus];
export const MASTER_STATUSES: MasterStatus[] = [MasterStatus.ACTIVE, MasterStatus.INACTIVE];

/** Extracted so Task 4's tightened schema and the FF and Warehouse tables share one pattern. */
export const E164 = /^\+[1-9]\d{6,14}$/;

// Moved verbatim from masters.ts — same shape, same behaviour. Task 4 replaces this with the
// nine-field version when the Client migration makes email and phone mandatory. Do not tighten
// it here: clients.controller.ts, clients.service.ts and masters.test.ts all bind to it as is.
export const contactCreateSchema = z.object({
  name: z.string().min(1).max(160),
  designation: z.string().max(120).optional(),
  contactNo: z.string().regex(E164, "Phone must be E.164").optional(),
  email: z.string().email().optional(),
  isPrimary: z.boolean().optional(),
});
export const contactUpdateSchema = contactCreateSchema.partial();
export type ContactCreateInput = z.infer<typeof contactCreateSchema>;
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;

export interface ContactDto {
  id: string;
  name: string;
  designation: string | null;
  contactNo: string | null;
  email: string | null;
  isPrimary: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
