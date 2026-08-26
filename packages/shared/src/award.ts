import { z } from "zod";
import type { ChargeRateVariant } from "./quote";
import { CHARGE_RATE_VARIANTS } from "./quote";
import type { FreightMode } from "./config";
import type { Priority } from "./query";
import type { QuoteStatus } from "./status";

/** One itemised line in an offer's charge breakdown (click-FF-to-expand detail, §11/§12).
 *  Derived from the SAME `computeQuoteTotals(draft)` the offer's own totals already use — one row
 *  per charge GROUP the totals object exposes (`freight` = the variant's own rate cell, Road/Sea
 *  only; `additional` = the common `additionalChargeSum`; `warehouse` = `warehouseSum`), NOT a
 *  hand-rolled parse of raw `draft.charges`/`draft.warehouse` lines. See comparison.service.ts's
 *  `buildCharges` for exactly which groups are emitted and why. */
export interface OfferChargeLineDto {
  label: string;
  group: string;
  nativeAmount: number; // in the quote's own currency
  usdAmount: number | null; // toUsd(nativeAmount, currency, rate) — null when no FX rate on file
}
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
  charges: OfferChargeLineDto[]; // itemised breakdown; Σ nativeAmount === nativeTotal
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
/** The maker-checker state for one leg's award (S5.3/S5.4 `LegAwardDecision`, read-only mirror —
 *  string dates, mirrors `FxRateDto`'s ISO convention). `null` on the leg's `decision` means no
 *  shortlist has ever been made (the row doesn't exist yet), not an error. */
export interface AwardDecisionDto {
  legId: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  shortlistedQuoteId: string | null;
  shortlistedVariant: ChargeRateVariant | null;
  recommendedQuoteId: string | null; // the recommendation snapshotted at shortlist time (D3)
  recommendedVariant: ChargeRateVariant | null;
  overrideReason: string | null; // required (A2) when the shortlist deviates from the recommendation
  rejectionReason: string | null;
  sentByUserId: string | null;
  sentForApprovalAt: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
}
/** One immutable audit-trail entry (`AwardDecisionEvent`) — SHORTLIST/SEND_FOR_APPROVAL/APPROVE/
 *  REJECT/GENERATE/REOPEN/… (`type` stays a plain string here, not a closed union: the event log
 *  is append-only and additive, new types shouldn't require a shared-package release). */
export interface AwardDecisionEventDto {
  id: string;
  legId: string;
  type: string;
  quoteId: string | null;
  variant: ChargeRateVariant | null;
  reason: string | null;
  actorId: string | null;
  at: string;
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
  decision: AwardDecisionDto | null; // null = no LegAwardDecision row yet (nothing shortlisted)
  timeline: AwardDecisionEventDto[]; // chronological (`at` ascending), [] when nothing has happened
}
export interface ComparisonDto {
  queryId: string;
  priority: Priority;
  fxAsOf: string | null; // when the FX rates were read (display)
  legs: LegComparisonDto[];
  // S5.6 Task 6 — the frozen award summary once the query is QUOTING_CLIENT (`query.status`
  // projects straight off this column's presence, see query-status.projector.ts). `null` until
  // `AwardService.generateClientQuote` freezes it; scoped here (not on the wider `QueryDetail`)
  // since this one feature is the only frontend consumer — see this file's `QueryAwardSnapshot`
  // doc comment above for the persisted shape.
  awardSnapshot: QueryAwardSnapshot | null;
  // S5.6 Task 6 (review round 1 fix) — freightForwarderId -> companyName for EVERY forwarder
  // quoted anywhere on this query, regardless of quote status. `QueryAwardSnapshotLeg` stores only
  // ids, and a winner's own quote is always APPROVED by the time a snapshot exists.
  //
  // S5.9.5 (D8) CORRECTION — this used to say `COMPARABLE_STATUSES` (comparison.service.ts)
  // excludes APPROVED, so `offers`/`pendingForwarders` could never name a winner on its own leg.
  // APPROVED is now IN that list, so an approved winner carrying a `draftJson` does appear in its
  // leg's `offers`. This map is kept, and is still the right lookup, for the reason below rather
  // than that one: it is status-unfiltered BY CONSTRUCTION, so resolving a snapshot's
  // `freightForwarderId` never depends on which statuses those two lists happen to admit today.
  // This map is the SAME query-wide, status-unfiltered lookup `ComparisonService.getComparison` already
  // builds (off `prisma.quote.findMany({ where: { queryId } })`, no status predicate) to label
  // `offers[].freightForwarderName`/`pendingForwarders[].freightForwarderName` — just exposed
  // directly so `QuotingClientPanel` can resolve `QueryAwardSnapshotLeg.freightForwarderId`
  // without a second network call and without depending on that id happening to also show up in
  // some other leg's (status-filtered) offer/pending list.
  forwarderNames: Record<string, string>;
}

// ── Stage 5 (S5.4) request schemas — maker/checker approval-workflow endpoints ──
// S5.9 (D6, register B3) — selection and send are ONE call. The offer is named by the request
// that acts on it, so the server never has to trust a separately-persisted shortlist.
export const sendForApprovalSchema = z.object({
  quoteId: z.string().uuid(),
  variant: z.enum(CHARGE_RATE_VARIANTS).nullable(),
  overrideReason: z.string().trim().min(1).max(2000).optional(), // required when ≠ recommendation (A2)
  proceedWithoutWaiting: z.boolean().optional(),                 // A9 — in-flight re-quote override
  proceedReason: z.string().trim().min(1).max(2000).optional(),
});
export const rejectSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
/** S5.9.5 (D6) — reopening a client-quoted comparison is a consequential, auditable act (it
 *  supersedes an ISSUED quotation and discards a DRAFT one), so it collects a reason the same way
 *  a rejection does. Same shape as `rejectSchema` deliberately: one validation rule for "a
 *  required free-text reason", not two that can drift. */
export const reopenComparisonSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export type SendForApprovalInput = z.infer<typeof sendForApprovalSchema>;
export type RejectInput = z.infer<typeof rejectSchema>;
export type ReopenComparisonInput = z.infer<typeof reopenComparisonSchema>;

// ── Stage 5 (S5.4 Task 4) — the frozen award snapshot ───────────────────────────
// Persisted verbatim onto `Query.awardSnapshot` (Json?) by AwardService.generateClientQuote:
// one row per leg's winning (APPROVED) offer, priced directly from its own submitted `draftJson`
// — `generateClientQuote` loads each winning quote and runs `computeQuoteTotals(draft)` itself,
// never reading back through `getComparison`. (S5.9.5 D8 CORRECTION: the reason once given here
// for that — "COMPARABLE_STATUSES deliberately excludes APPROVED, so getComparison can't be
// reused once every leg has an awarded winner" — is no longer true; APPROVED is comparable now.
// The direct-from-draft pricing is unchanged, and is stated here as what the code does, not as a
// consequence of any status list.) Presence
// (`awardSnapshot != null`) IS the `quotingClient` milestone signal query-status.projector.ts
// reads to roll the query up to QUOTING_CLIENT — this type is the contract S5.6 (the
// client-facing quote) reads back.
export interface QueryAwardSnapshotLeg {
  legId: string;
  winningQuoteId: string;
  freightForwarderId: string;
  variant: ChargeRateVariant | null;
  currency: string | null;
  unitsPerUsd: number | null; // null for a USD winner (passes through, no rate stored) or an untracked currency
  usdTotal: number; // A7-gated — generate 409s before a null usdTotal can ever be persisted
  nativeTotal: number; // grandTotal in the winning quote's own currency
  transitDays: number | null;
}
export interface QueryAwardSnapshot {
  generatedByUserId: string;
  legs: QueryAwardSnapshotLeg[];
  combinedUsd: number; // Σ legs[].usdTotal
}
