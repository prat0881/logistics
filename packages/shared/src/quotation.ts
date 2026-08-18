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

/**
 * `POST /api/queries/:id/quotation/issue` body.
 *
 * Fix round 1 (S5.8 Task 4 review, IMPORTANT #1): the letter's BODY is always rendered
 * server-side from the seeded `quotation.issued.email` template + tokens computed from the
 * query's own data — never accepted as free text. That is the only way "grand total only, no
 * charge lines, no forwarder names" (design doc, "Withheld from the client") is a rule the
 * backend actually enforces, rather than one only the (not-yet-built) compose screen happens to
 * respect. `bodyText` is therefore NOT a field here — not kept-as-override, not kept-but-ignored,
 * since either would reopen the hole this closes.
 *
 * `subject` stays caller-suppliable but now OPTIONAL — the design's envelope names subject as
 * editable (unlike the letter, which "has no controls inside it"); omit it to fall back to the
 * template's own rendered subject.
 */
export const quotationIssueSchema = z.object({
  recipientEmail: z.string().email(),
  subject: z.string().trim().min(1).max(200).optional(),
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
