import { z } from "zod";
import type { ChargeRateVariant } from "./quote";
import { CHARGE_RATE_VARIANTS } from "./quote";
import type { FreightMode } from "./config";
import type { Priority } from "./query";
import type { QuoteStatus } from "./status";

/** One comparable offer = a quoted FF's price for one freight-variant column on one leg. */
export interface OfferDto {
  quoteId: string;
  freightForwarderId: string;
  freightForwarderName: string;
  variant: ChargeRateVariant | null; // the freight column (null = Air's single column)
  variantLabel: string; // "Dedicated" | "Groupage" | "FCL" | "LCL" | "—"
  priced: boolean; // the variant carries its own freight rate (Air: any charge) — only priced offers are rankable
  nativeTotal: number; // grandTotal in the quote's own currency
  currency: string;
  unitsPerUsd: number | null; // the FX rate used (null if none on file)
  usdTotal: number | null; // toUsd(nativeTotal, currency, rate)
  transitDays: number | null; // guaranteed transit for this variant's transit key
  chargeableWeightKg: number;
  validUntil: string | null; // the RFQ's quoteValidityUntil
  quoteStatus: QuoteStatus;
}
/** An FF that was sent this leg but has NO comparable price at all (not even a stale one). */
export interface PendingForwarderDto {
  freightForwarderId: string;
  freightForwarderName: string;
  quoteStatus: QuoteStatus; // RFQ_SENT (awaiting) | EXPIRED | INVALID | CLOSED — NOT REQUOTED (that's an offer, see awaitingReQuote)
}
export interface RecommendationDto {
  quoteId: string;
  variant: ChargeRateVariant | null;
  reason: string; // human string, e.g. "High priority → fastest transit (3 days); price broke the tie."
}
export interface LegComparisonDto {
  legId: string;
  legCode: string;
  mode: FreightMode | null;
  origin: string;
  destination: string;
  offers: OfferDto[]; // one per (quoted FF × freight column)
  pendingForwarders: PendingForwarderDto[]; // sent, not yet comparably quoted (the "awaiting" indicator)
  awaitingReQuote: boolean; // true when >=1 offer is REQUOTED (stale price shown, but excluded from ranking)
  recommendation: RecommendationDto | null;
}
export interface ComparisonDto {
  queryId: string;
  priority: Priority;
  fxAsOf: string | null; // when the FX rates were read (display)
  legs: LegComparisonDto[];
}

// ── Stage 5 (S5.4) request schemas — maker/checker approval-workflow endpoints ──
export const shortlistSchema = z.object({
  quoteId: z.string().uuid(),
  variant: z.enum(CHARGE_RATE_VARIANTS).nullable(),
  overrideReason: z.string().trim().min(1).max(2000).optional(), // required at send if shortlist ≠ recommendation (A2)
});
export const sendForApprovalSchema = z.object({
  proceedWithoutWaiting: z.boolean().optional(), // A9 override when the leg has an in-flight re-quote
  proceedReason: z.string().trim().min(1).max(2000).optional(),
});
export const rejectSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export type ShortlistInput = z.infer<typeof shortlistSchema>;
export type SendForApprovalInput = z.infer<typeof sendForApprovalSchema>;
export type RejectInput = z.infer<typeof rejectSchema>;
