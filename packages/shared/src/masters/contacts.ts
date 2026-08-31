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

/**
 * A contact as it arrives inside a parent's composite create/update payload. `id` present means
 * "update this existing row"; absent means "create". A contact omitted from the array is
 * deleted — see reconcileContacts on the API side.
 */
export const contactUpsertSchema = contactCoreSchema.extend({
  id: z.string().uuid().optional(),
});
export type ContactUpsertInput = z.input<typeof contactUpsertSchema>;
/** Post-parse shape: every `.default()` applied. Services should use THIS, not the input type,
 *  so `pocLevel` is always a real value and never needs a `?? "NONE"` fallback. */
export type ContactUpsert = z.output<typeof contactUpsertSchema>;

const primaryCount = (contacts: { pocLevel?: PocLevel }[]): number =>
  contacts.filter((c) => c.pocLevel === PocLevel.PRIMARY).length;

/** Create-time rule: a new Client/Warehouse must name exactly one primary contact. */
export const exactlyOnePrimary = (contacts: { pocLevel?: PocLevel }[]): boolean =>
  primaryCount(contacts) === 1;

/** Update-time rule: never two, but zero is allowed — a record that pre-dates the rule stays
 *  editable and is nudged by a banner instead of blocked (design C4). */
export const atMostOnePrimary = (contacts: { pocLevel?: PocLevel }[]): boolean =>
  primaryCount(contacts) <= 1;

export const PRIMARY_REQUIRED_MESSAGE = "Exactly one contact must be marked Primary";
export const PRIMARY_DUPLICATE_MESSAGE = "Only one contact can be marked Primary";

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
