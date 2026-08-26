import { z } from "zod";
import { MASTER_STATUSES, type MasterStatus } from "./contacts";
import { FREIGHT_MODES, type FreightMode } from "../config";
import { COUNTRY_CODES, CURRENCY_CODES } from "../reference";

const statusField = z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional();

export const PaymentTerm = {
  CREDIT_7: "CREDIT_7", CREDIT_15: "CREDIT_15", CREDIT_30: "CREDIT_30",
  CREDIT_45: "CREDIT_45", CREDIT_60: "CREDIT_60", ADVANCE_100: "ADVANCE_100",
  ADVANCE_50_BALANCE_50: "ADVANCE_50_BALANCE_50",
  ADVANCE_30_BALANCE_70: "ADVANCE_30_BALANCE_70",
  ADVANCE_70_BALANCE_30: "ADVANCE_70_BALANCE_30",
  AFTER_DELIVERY_100: "AFTER_DELIVERY_100",
} as const;
export type PaymentTerm = (typeof PaymentTerm)[keyof typeof PaymentTerm];
export const PAYMENT_TERMS = Object.values(PaymentTerm) as [PaymentTerm, ...PaymentTerm[]];

export const PAYMENT_TERM_LABELS: Record<PaymentTerm, string> = {
  CREDIT_7: "7 Days Credit", CREDIT_15: "15 Days Credit", CREDIT_30: "30 Days Credit",
  CREDIT_45: "45 Days Credit", CREDIT_60: "60 Days Credit", ADVANCE_100: "100% Advance",
  ADVANCE_50_BALANCE_50: "50% Advance : 50% After Delivery",
  ADVANCE_30_BALANCE_70: "30% Advance : 70% After Delivery",
  ADVANCE_70_BALANCE_30: "70% Advance : 30% After Delivery",
  AFTER_DELIVERY_100: "100% After Delivery",
};

export const freightForwarderCreateSchema = z.object({
  companyName: z.string().min(1).max(200),
  companyAddress: z.string().min(1).max(500),
  city: z.string().min(1).max(120),
  postalCode: z.string().max(20).optional(),
  country: z.string().min(1).max(120),
  pic: z.string().min(1).max(160),
  contactNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164"),
  email: z.string().email(),
  availableCountries: z.array(z.enum(COUNTRY_CODES)).min(1, "Select at least one country"),
  modes: z.array(z.enum(FREIGHT_MODES)).min(1, "Select at least one mode"),
  handleDg: z.boolean().optional(),
  vatTrnEori: z.string().max(100).optional(),
  whLocation: z.string().max(200).optional(),
  defaultCurrency: z.enum(CURRENCY_CODES).optional(),
  paymentTerms: z.enum(PAYMENT_TERMS).optional(),
  typicalLeadTime: z.number().int().min(0).max(365).optional(),
  status: statusField,
});
// pic/contactNumber/email are derived once a forwarder exists: FreightForwardersService's
// syncPrimaryContactColumns is their sole writer after create(), which seeds the primary
// contact from these same three fields. whLocation joins them for the same reason:
// FreightForwardersService.setWarehouses (Task 14) is its sole writer after create(), derived
// from the assigned warehouses. All four are omitted here (not just made optional) so the
// update DTO can't carry them at all — editing a forwarder's contact details or warehouses
// happens through its contact list / warehouse picker, in exactly one place each. They stay on
// the *create* schema above: creation still needs them (pic/contactNumber/email are NOT NULL)
// and rfq.service.ts still reads all four off the row.
export const freightForwarderUpdateSchema = freightForwarderCreateSchema
  .omit({ pic: true, contactNumber: true, email: true, whLocation: true })
  .partial();
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
  paymentTerms: PaymentTerm | null;
  typicalLeadTime: number | null;
  status: MasterStatus;
}
