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
 * S5.9.3 Task 1 (P1, product owner's explicit ruling): the letter's body IS now caller-editable.
 * Fix round 1 (S5.8 Task 4 review, IMPORTANT #1) had made it server-rendered-only precisely
 * because that was the only STRUCTURAL way to enforce "grand total only, no charge lines, no
 * forwarder names" (design doc, "Withheld from the client") — a UI could not put in the letter
 * what the backend never accepted as input. P1 trades that structural guarantee for a procedural
 * one (P2): the manager always starts from the server-rendered draft (`QuotationDto.previewBody`)
 * and can edit it before issuing, the same way `subject` already worked. What the guarantee still
 * IS NOT is a way to change what the client is actually charged — `bodyText` is prose only;
 * `issue()` prices the grand total from the frozen draft (`priceQuotation` over `draftJson`)
 * exactly as before, and that computed total — never anything parsed out of this string — is what
 * lands in `Quotation.clientTotalUsd`/`issuedSnapshot`. The persisted `bodyText` is whatever was
 * actually sent (auditable), which can diverge from that number if a manager edits the total's own
 * digits in the prose; see quotation.service.ts `issue()` for how that risk is documented.
 *
 * `bodyText` is OPTIONAL, matching `subject`'s own fallback rule: omit it (or the whole field) to
 * fall back to the template's own rendered body — the manager never composes from blank, and every
 * pre-P1 caller that never sent a body keeps working unchanged. When present it must be non-empty
 * after trimming — an explicitly empty body is refused (400), never silently replaced by the
 * template's render, so a manager who clears the box gets a clear rejection rather than a letter
 * they didn't actually write.
 *
 * `subject` stays caller-suppliable but OPTIONAL — the design's envelope names subject as
 * editable; omit it to fall back to the template's own rendered subject.
 *
 * `expectedUpdatedAt` is REQUIRED and is the optimistic-concurrency token (S5.9.3 final review,
 * IMPORTANT #1): the `QuotationDto.updatedAt` the caller's copy of the quotation was read at.
 * `Quotation.updatedAt` is Prisma `@updatedAt`, so EVERY repricing PATCH moves it — which makes it
 * the one value that proves the letter in the request body was composed against the pricing that
 * is still current. Without it, a manager whose cached quotation was repriced by a second tab (or
 * a second manager) could send a letter quoting the OLD grand total while `issue()` charged the
 * NEW one, silently: `bodyText` is prose the server never parses, and nothing else in this body
 * carries a version. `issue()` refuses a mismatch with 409 (see `quotation.service.ts#issue`).
 * Deliberately not `version`: `version` only moves on `revise()`, never on a PATCH, so it cannot
 * see the repricing that actually causes the divergence.
 */
export const quotationIssueSchema = z.object({
  recipientEmail: z.string().email(),
  subject: z.string().trim().min(1).max(200).optional(),
  bodyText: z.string().trim().min(1).max(5000).optional(),
  expectedUpdatedAt: z.string().datetime(),
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
 *
 * `previewSubject`/`previewBody` (T6) are what the seeded `quotation.issued.email` template would
 * render RIGHT NOW from this row's own current `marginPct`/`overrides` — computed by the exact
 * same `buildIssueTokens` → `omitEmptyTokenLine` → `renderTemplate` chain `issue()` itself uses to
 * seed `subject`/`bodyText`'s DEFAULTS. Through S5.8 T6 that made a DRAFT's preview byte-identical
 * to what issuing it would persist; as of S5.9.3 Task 1 (P1) that is only true when the caller
 * doesn't override — `quotationIssueSchema.subject`/`bodyText` are both caller-editable now, so
 * `Quotation.subject`/`bodyText` end up holding whatever text was actually sent, not necessarily
 * this render. Read-only here regardless: nothing in `quotationPatchSchema` sets these directly,
 * and `quotationIssueSchema` only ever supplies the freeform OVERRIDE, never mutates the template
 * render itself. Both are `""` in the (should-be-unreachable) case where the
 * `quotation.issued.email` template itself isn't configured.
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
  previewSubject: string;
  previewBody: string;
  recipientEmail: string | null;
  subject: string | null;
  bodyText: string | null;
  issuedAt: string | null;
  issuedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}
