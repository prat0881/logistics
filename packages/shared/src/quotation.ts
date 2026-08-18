import { z } from "zod";
import type { PricedQuotation } from "./quotation-pricing";

/** Mirrors the `Quotation.status` enum (design doc, Data model). */
export type QuotationStatus = "DRAFT" | "ISSUED" | "SUPERSEDED";

/** `PATCH /api/queries/:id/quotation` body — margin and/or overrides, both optional so either
 *  can be edited independently. `marginPct` matches the DB column (`Decimal(5,2)`, 0–100).
 *  Overrides are absolute client-USD amounts (`≥ 0`), keyed `${legId}:${lineId}` — see
 *  `priceQuotation` in `quotation-pricing.ts` for how a stale/unmatched key is handled. */
export const quotationPatchSchema = z.object({
  marginPct: z.number().min(0).max(100).optional(),
  overrides: z.record(z.string(), z.number().min(0)).optional(),
});
export type QuotationPatch = z.infer<typeof quotationPatchSchema>;

/** `POST /api/queries/:id/quotation/issue` body — the composed client email. */
export const quotationIssueSchema = z.object({
  recipientEmail: z.string().email(),
  subject: z.string().trim().min(1).max(200),
  bodyText: z.string().trim().min(1).max(20000),
});
export type QuotationIssue = z.infer<typeof quotationIssueSchema>;

/**
 * The API's read/write shape for a `Quotation` row (`GET`/`PATCH .../quotation`,
 * `POST .../issue`, `POST .../revise` all return this).
 *
 * `pricing` is `priceQuotation(...)` run against the row's current `marginPct` + `overrides` —
 * always fresh, never persisted redundantly. `costTotalUsd`/`clientTotalUsd` on the `Quotation`
 * row itself (design doc) are a snapshot cache for listing/reporting without re-pricing; this DTO
 * exposes the live totals via `pricing.costTotalUsd`/`pricing.clientTotalUsd` instead of
 * duplicating them at the top level.
 *
 * `validUntil` is NOT a `Quotation` column — it is derived at read time as the earliest
 * `validUntil` across the winning quotes (pre-authorised design decision, S5.8 progress log Q2),
 * `null` when every winning quote's `validUntil` is null.
 *
 * Withheld by design (design doc "Screens" section) from anything the CLIENT sees, but present
 * here because this DTO is the INTERNAL builder/API contract: charge lines, forwarder cost,
 * margin and forwarder names are all included for the operator-facing builder screen (T5).
 */
export interface QuotationDto {
  id: string;
  queryId: string;
  version: number;
  status: QuotationStatus;
  marginPct: number;
  overrides: Record<string, number>;
  pricing: PricedQuotation;
  validUntil: string | null;
  recipientEmail: string | null;
  subject: string | null;
  bodyText: string | null;
  issuedAt: string | null;
  issuedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}
