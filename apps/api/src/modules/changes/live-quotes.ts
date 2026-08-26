import { QuoteStatus } from "@svyft/shared";
import { Prisma } from "@prisma/client";

// The statuses that are live REGARDLESS of whether the quote carries a price:
//   RFQ_SENT        — distributed, the window is open, the FF is expected to answer.
//   QUOTED          — a submitted price on the table.
//   PENDING_APPROVAL — that price, under checker review (S5.9 §4.4).
//   APPROVED        — that price, already provisionally awarded (S5.3, §10.2 prereq).
// SELECT (pre-RFQ) and INVALID (already invalidated) are never live.
const UNCONDITIONALLY_LIVE: readonly QuoteStatus[] = [
  QuoteStatus.RFQ_SENT,
  QuoteStatus.QUOTED,
  QuoteStatus.PENDING_APPROVAL,
  QuoteStatus.APPROVED,
];

/**
 * "Is this quote a live commercial commitment on its leg?" — the ONE predicate behind BOTH halves
 * of the change-order fork: `ScopeResolver.downstreamWork` (which decides Free-path vs
 * change-order) and `ChangeOrderStrategy`'s own quote load (which decides what the cascade
 * invalidates or refreshes). They used to carry two hand-copied status lists that had to be kept
 * in lock-step by comment; one definition removes that possibility.
 *
 * **EXPIRED is conditional, and the condition is the whole point (S5.9.5).** `EXPIRED` was
 * excluded outright for the whole life of the two lists, and that was SAFE only because an
 * expired quote never carried a price: the deadline sweep nulled `draftJson` on its way past
 * (`rfq-schedule.listener.ts`). S5.9.5 D4 changed exactly that — the sweep now KEEPS `draftJson`
 * for a quote expiring out of `REQUOTED`, and D8 then made such an offer comparable, rankable
 * (`buildRecommendation`), sendable (`SENDABLE_STATUSES`) and approvable (the
 * `EXPIRED --send_for_approval--> PENDING_APPROVAL` edge). A priced EXPIRED offer is therefore a
 * live commitment in every sense the other four are, and a field edit on its leg must invalidate
 * it — the same invariant this codebase already established for `APPROVED` (S5.3) and for
 * `PENDING_APPROVAL` (S5.9 §4.4). Left out, a cargo edit on a leg whose only quote is a priced
 * EXPIRED offer takes the Free path: no invalidation, no change order, no reopen, and the client
 * is then quoted straight off that superseded `draftJson`.
 *
 * An EXPIRED quote with NO `draftJson` — the ordinary "we asked, they never answered" case, which
 * is the overwhelming majority of expired rows — is NOT a commitment and must stay excluded.
 * Admitting it would start raising change orders (and demanding a reason) for edits that have
 * always been Free-path across the whole product, which is a behaviour regression, not a fix.
 * `draftJson` is the right discriminator rather than a new column because it is already the one
 * the read side uses: `ComparisonService.buildLeg` skips any quote without it, so "carries a
 * `draftJson`" is exactly "produces an offer on the compare screen".
 *
 * `Prisma.DbNull` (not `JsonNull`): `draftJson` is a NULLABLE Json column and the sweep clears it
 * to SQL NULL, so this asks for `draftJson IS NOT NULL`.
 */
export const LIVE_QUOTE_WHERE: Prisma.QuoteWhereInput = {
  OR: [
    { status: { in: [...UNCONDITIONALLY_LIVE] } },
    { status: QuoteStatus.EXPIRED, draftJson: { not: Prisma.DbNull } },
  ],
};

/**
 * Does a quote the above `where` returned have to be INVALIDATED by the cascade, or merely
 * refreshed in place? Everything that carries a submitted price is invalidated (the FF must
 * re-quote against the new basis); only `RFQ_SENT` — still pending, nothing ever submitted —
 * is refreshed. A priced EXPIRED offer is invalidated for the same reason `APPROVED` and
 * `PENDING_APPROVAL` are: it is a real number somebody can still act on, and the basis moved.
 * (Unpriced EXPIRED quotes never reach here — `LIVE_QUOTE_WHERE` filters them out upstream.)
 *
 * Spelled as an allowlist rather than `!== RFQ_SENT` so that adding a status to
 * `LIVE_QUOTE_WHERE` above forces a deliberate answer here instead of silently defaulting to
 * "invalidate it".
 */
const INVALIDATED_BY_CHANGE_ORDER: readonly QuoteStatus[] = [
  QuoteStatus.QUOTED,
  QuoteStatus.PENDING_APPROVAL,
  QuoteStatus.APPROVED,
  QuoteStatus.EXPIRED,
];

export function invalidatedByChangeOrder(status: QuoteStatus): boolean {
  return INVALIDATED_BY_CHANGE_ORDER.includes(status);
}
