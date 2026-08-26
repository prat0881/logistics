import type { LegComparisonDto, OfferDto, PendingForwarderDto } from "@svyft/shared";
import { formatDate } from "@/lib/dates";
import { fmtNative, fmtUsd } from "./money";

/**
 * The stable identity of one (FF × variant) column. NOT `quoteId` alone: one submitted Quote fans
 * out into one `OfferDto` per variant of the leg's mode (Road: Dedicated + Groupage; Sea: FCL +
 * LCL — see comparison.service.ts's `buildLeg`, which loops `variantsForMode` per quote), so two
 * columns on the same leg can legitimately share a `quoteId` and differ only by `variant`.
 * Moved here from `ComparisonGrid.tsx` (S5.7 T1) byte-for-byte — every existing importer keeps
 * resolving it via `ComparisonGrid`'s re-export.
 */
export function offerKey(quoteId: string, variant: string | null): string {
  return `${quoteId}::${variant ?? "AIR"}`;
}

/** The stale-price marker for a REQUOTED offer (design §14). One constant, because it labels the
 *  same offer in three places — `ComparisonGridColumns`'s Status row, `ComparisonGridRows`'s Status
 *  cell, and `SendForApprovalDialog`'s per-option warning (S5.9 T9 — where the S5.6 shortlist
 *  radio's inline version of this warning ended up, via `ShortlistDialog`, which T9 retired).
 *  Lives here (not `ComparisonGrid.tsx`) so `ComparisonGridColumns` can import it without a cycle
 *  back through `ComparisonGrid.tsx`; still re-exported from `ComparisonGrid.tsx`, which is how
 *  `ComparisonGrid.test.tsx` imports it. */
export const STALE_OFFER_LABEL = "Re-quote requested";

/** S5.9.5 (D4) — `STALE_OFFER_LABEL`'s sibling for the other stale cause. `stale` (below) now also
 *  covers `EXPIRED`: since S5.9.5 Task 2, an expired quote that still carries a price is comparable
 *  and sendable, but it is stale one step further along than a `REQUOTED` offer — the re-quote was
 *  asked for and the deadline passed with no answer.
 *
 *  **Still unconsumed — `SendForApprovalDialog.tsx` is the one place that needs it (Task 10).**
 *  This pointer used to name "S5.9.5 Task 9/10" and the two grid components as well. Task 9 has
 *  since run: it narrowed both grids to `GridCell`, and in doing so established that neither grid
 *  can consume this label at all — S5.9.2 Q4 deleted their second stale badge outright, so each
 *  now renders exactly one `ForwarderStatusBadge` per cell and that badge names the status by
 *  itself. That leaves `SendForApprovalDialog` as the sole consumer, where the label has to be
 *  picked off `offer.quoteStatus` rather than off `cell.stale` (which spans both causes since D4).
 *
 *  **Wording (S5.9.5 Task 9, product owner's ruling).** Task 8 first shipped this as "Forwarder
 *  unresponsive", on the stated premise that "nobody asked this forwarder for a new number". That
 *  premise is FALSE for a cell that carries a price, and the label is replaced along with it.
 *  Traced: `QuoteEvent.EXPIRE` has exactly two edges into `EXPIRED` — `RFQ_SENT → EXPIRED`
 *  (`quote.machine.ts:8`) and `REQUOTED → EXPIRED` (`award.module.ts:95`) — and the only caller is
 *  the RFQ deadline sweep (`rfq-schedule.listener.ts:143`), which discards the draft on the
 *  `RFQ_SENT` path only. A forwarder expired out of `RFQ_SENT` therefore has no price and renders
 *  as a `PendingCell`, never as an offer this label can reach; a priced `EXPIRED` offer can only
 *  have arrived via `REQUOTED`, i.e. a re-quote WAS requested and went unanswered. So the two
 *  labels are one pair over the same subject, differing only in outcome — "Re-quote requested"
 *  then "Re-quote unanswered" — rather than the earlier text, which named a different subject and
 *  passed judgement on a business partner. */
export const EXPIRED_OFFER_LABEL = "Re-quote unanswered";

export interface OfferCell {
  kind: "offer";
  key: string; // offerKey(quoteId, variant)
  offer: OfferDto;
  recommended: boolean; // this is the recommendation OF RECORD (S5.9.1 R1) — true both before and
  // after a send, false only once suppressed (`locked`) or when it names some other cell
  /** This is the offer `decision.shortlistedQuoteId`/`shortlistedVariant` names, and ONLY while
   *  that decision is still `PENDING_APPROVAL` — i.e. the offer a checker is looking at right now
   *  (S5.9.1 Task 5, corrected by the final whole-branch review's C1). Deliberately NOT derived
   *  from `offer.quoteStatus`: sending for approval is supposed to flip the named offer's OWN
   *  quote to `PENDING_APPROVAL` (S5.9 T3), but that is a second-hand signal that can drift from
   *  the decision record (observed live on `S56VIS-0001` — `decision.status = PENDING_APPROVAL`
   *  naming a quote whose `quoteStatus` was still `QUOTED`, stale seed data rather than a code
   *  bug, but proof that a derived signal is the wrong source for this). Reads the decision
   *  directly, the same way `recommended` reads it for the snapshot above.
   *
   *  **Where this deliberately parts company with `recommended` (C1).** Both marks read the same
   *  decision row, but only ONE of them makes a claim about the present tense. `★` says
   *  "recommended by the comparison engine" — a timeless fact about a snapshot, true forever after
   *  it was taken, which is exactly why `recommended` reads the snapshot on a DRAFT decision too
   *  (a returned leg keeps the mark it was judged against). `⚑`'s copy is a LIVE status assertion
   *  ("the offer currently under checker review", `SENT_FOR_APPROVAL_FOOTNOTE`), and `reject()`
   *  (award.service.ts) writes the decision back to `DRAFT` — clearing `sentByUserId`, storing
   *  `rejectionReason` — WITHOUT clearing `shortlistedQuoteId`/`shortlistedVariant`, on purpose:
   *  `MakerPanel`'s "Returned by the checker — revise this shortlist" alert needs that shortlist
   *  to still be there. Reusing `recommended`'s "read it regardless of status" rule therefore made
   *  a rejected leg render `⚑` + "currently under checker review" a few rows above that very
   *  alert. Gating on `PENDING_APPROVAL` is the fix, and it belongs HERE rather than in `reject()`:
   *  clearing the field server-side would fix the display by breaking `MakerPanel`'s premise. The
   *  same gate also covers `APPROVED` (decided, no longer under review) and the `REJECTED` status
   *  the DTO's union allows but `reject()` never persists. `locked` still suppresses it too,
   *  consistently with `recommended`. */
  sentForApproval: boolean;
  /** S5.9.5 (design D8) — the approved offer's own mark. Reads the DECISION, exactly like
   *  `sentForApprovalKey` above and for the same traced reason (see this field's sibling
   *  `sentForApproval`'s doc comment: `offer.quoteStatus` is a second-hand signal that has been
   *  observed to drift from the decision record). The two are mutually exclusive BY CONSTRUCTION —
   *  one requires `status === "PENDING_APPROVAL"`, the other `status === "APPROVED"` — so no
   *  precedence rule is needed and the product owner's "approved replaces the flag" falls out of
   *  the gate itself.
   *
   *  `locked` deliberately does NOT suppress this one, unlike `recommended` and `sentForApproval`.
   *  Those two are suppressed because they would CONTRADICT the frozen award panel below the grid
   *  (the live ranking re-ranks the losers; "currently under checker review" is false once frozen).
   *  The approved mark AGREES with that panel — it names the same winner the snapshot froze — so
   *  suppressing it would remove the one mark that is still true. */
  approved: boolean;
  stale: boolean; // quoteStatus === "REQUOTED" || quoteStatus === "EXPIRED" — see EXPIRED_OFFER_LABEL
}

/** S5.9.5 (D7) — a forwarder sent an RFQ who has priced nothing comparable yet. Lives IN the grid
 *  now, not in a list below it (design D7); `pendingKey` gives it its own namespace so it can never
 *  collide with an `offerKey`. */
export interface PendingCell {
  kind: "pending";
  key: string; // pendingKey(freightForwarderId)
  forwarder: PendingForwarderDto;
}

/** S5.9.5 (D7) — a discriminated union rather than a nullable `offer` field on `OfferCell`, so
 *  TypeScript forces every consumer that iterates cells to handle the new kind instead of letting a
 *  missed site compile and render `undefined`. `METRICS[].render` and `onOpenBreakdown` both stay
 *  typed to `OfferCell` alone (never `GridCell`) — a pending cell can never reach either. */
export type GridCell = OfferCell | PendingCell;

/** The pending cell's key. A separate namespace from `offerKey` on purpose — a pending forwarder
 *  has no quote id to key on, and the two must never collide in a `key` prop or a `data-testid`. */
export function pendingKey(freightForwarderId: string): string {
  return `pending::${freightForwarderId}`;
}

export interface ForwarderGroup {
  freightForwarderId: string;
  freightForwarderName: string;
  cells: GridCell[];
}

export interface ComparisonRowModel {
  groups: ForwarderGroup[];
  cells: GridCell[]; // flat, same order as groups flattened
  recommendedKey: string | null;
  /** The `★` mark's accessible-name text (S5.9.1 R1, Step 4) — `null` exactly when
   *  `recommendedKey` is `null`. Resolved here, alongside `recommendedKey`, rather than left for
   *  each grid orientation to re-derive off `leg.recommendation.reason` directly: that live string
   *  describes whatever `buildRecommendation` ranks NOW, which is correct only in the same
   *  "no decision yet" branch that makes `recommendedKey` read `live` below. Once a decision is in
   *  play `recommendedKey` reads the SNAPSHOT, which carries no stored reason text of its own — a
   *  generic sentence (`RECOMMENDED_REASON_ON_RECORD`) takes its place so the mark still renders
   *  with a sensible name instead of silently reusing a reason that may no longer describe it. */
  recommendedReason: string | null;
}

/** The `★` mark's accessible-name text once the recommendation of record is a decision SNAPSHOT
 *  rather than the live `leg.recommendation` — `AwardDecisionDto` has no stored reason text of its
 *  own (see award.ts:52-60), so this is what fills in for `leg.recommendation.reason` once the two
 *  can diverge (comparisonRowModel's doc comment on `buildComparisonRowModel`). */
export const RECOMMENDED_REASON_ON_RECORD =
  "Recommended by the comparison engine when this leg was sent for approval.";

/**
 * Builds the leg's (FF × variant) row model, grouped by forwarder in first-seen order (design
 * §12 — Dedicated/Groupage or FCL/LCL of the same FF read as a pair).
 *
 * **The recommendation OF RECORD (S5.9.1 R1).** `locked` still suppresses it entirely. **CORRECTED
 * (S5.9.5 D8)** — this used to say the winning quote is excluded from `offers` once the client
 * quote is generated, so the live recommendation would re-rank the losers; that cause is now FALSE
 * (`APPROVED` joined `COMPARABLE_STATUSES`, so the winner IS in `offers`). The conclusion still
 * holds for a different reason: `buildRecommendation` (comparison.service.ts) still never ranks
 * `APPROVED` (design D8), so the live recommendation would still name a loser (S5.6 final review
 * M1) — but that is now the ONLY hard suppression. S5.9 T9 additionally suppressed the mark the
 * moment `leg.decision.status` left `DRAFT`, because `buildRecommendation` ranks only `QUOTED`
 * (and now `EXPIRED`, D4/D8) offers: the very act of sending an offer for approval flips ITS OWN
 * quote to `PENDING_APPROVAL`, which drops it out of that ranking on the next fetch, so the LIVE
 * `leg.recommendation` can start naming a DIFFERENT forwarder than the one actually under review
 * — exactly while a checker is looking at
 * this same grid. That suppression traded a wrong answer for no answer, which a product review
 * caught (a checker reviewing a sent leg saw no recommendation at all). The actual fix: once a
 * `LegAwardDecision` row exists, it already snapshots `recommendedQuoteId`/`recommendedVariant` at
 * send time (award.ts:52-60) — stable, and exactly what the maker was judged against — so read
 * THAT instead of suppressing. Precedence:
 *
 * - No decision yet (`leg.decision == null`) → the LIVE `leg.recommendation`. This is the one case
 *   where "live" is exactly right — nobody has acted, so there is no snapshot to prefer.
 * - A decision exists → its SNAPSHOT, `recommendedQuoteId`/`recommendedVariant` — even on a DRAFT
 *   decision (a returned/rejected leg is still DRAFT; it keeps the mark it was judged against, not
 *   whatever the live ranking has drifted to since) and even when the snapshot itself is `null`
 *   (the maker shortlisted with NO recommendation on offer — falling back to the live value here
 *   would invent one after the fact and misrepresent the record, so the answer is a deliberate
 *   `null`, not a fallback).
 * - `locked` overrides both branches to `null` unconditionally.
 *
 * The `★` mark, its emerald tint, AND the footnote (gated in `ComparisonGrid.tsx` on
 * `model.cells.some(c => c.recommended)`, itself downstream of this) still all move together —
 * there is still exactly one place that decides "is this the recommendation?".
 */
export function buildComparisonRowModel(
  leg: LegComparisonDto,
  locked: boolean,
): ComparisonRowModel {
  const snapshotKey = leg.decision?.recommendedQuoteId
    ? offerKey(leg.decision.recommendedQuoteId, leg.decision.recommendedVariant)
    : null;
  const liveKey = leg.recommendation
    ? offerKey(leg.recommendation.quoteId, leg.recommendation.variant)
    : null;
  const recKey = locked ? null : leg.decision != null ? snapshotKey : liveKey;

  // S5.9.1 Task 5 (+ final-review C1) — the offer that went for approval, read straight from the
  // decision (never from `offer.quoteStatus`; see `OfferCell.sentForApproval`'s doc comment for
  // the drift this avoids) and only while that decision is STILL under review. The `status` term
  // is the C1 fix and is NOT a copy-paste slip against `recKey` above, which deliberately has no
  // such term: `★`'s copy is timeless, `⚑`'s ("currently under checker review") is a present-tense
  // claim, and `reject()` leaves `shortlistedQuoteId` in place on a DRAFT decision so `MakerPanel`
  // can still show the maker which shortlist to revise. Without this term that same DRAFT row
  // rendered `⚑` directly above MakerPanel's "Returned by the checker" alert.
  // No "no decision yet" live fallback here (unlike `recKey` above): there is no live equivalent of
  // "sent for approval" to fall back to — before a decision exists, nothing has been sent, full
  // stop. `locked` suppresses it for the same reason it suppresses `recKey`: post-generate, the
  // award panel below is the authority on what happened.
  const sentForApprovalKey =
    !locked && leg.decision?.status === "PENDING_APPROVAL" && leg.decision.shortlistedQuoteId
      ? offerKey(leg.decision.shortlistedQuoteId, leg.decision.shortlistedVariant)
      : null;

  // S5.9.5 (design D8) — the approved offer's own mark. Reads the DECISION, exactly like
  // `sentForApprovalKey` above and for the same traced reason (see `OfferCell.sentForApproval`'s
  // doc comment: `offer.quoteStatus` is a second-hand signal that has been observed to drift from
  // the decision record). The two are mutually exclusive BY CONSTRUCTION — one requires
  // `status === "PENDING_APPROVAL"`, the other `status === "APPROVED"` — so no precedence rule is
  // needed and the product owner's "approved replaces the flag" falls out of the gate itself.
  //
  // `locked` deliberately does NOT suppress this one, unlike `recKey` and `sentForApprovalKey`.
  // Those two are suppressed because they would CONTRADICT the frozen award panel below the grid
  // (the live ranking re-ranks the losers; "currently under checker review" is false once frozen).
  // The approved mark AGREES with that panel — it names the same winner the snapshot froze — so
  // suppressing it would remove the one mark that is still true.
  const approvedKey =
    leg.decision?.status === "APPROVED" && leg.decision.shortlistedQuoteId
      ? offerKey(leg.decision.shortlistedQuoteId, leg.decision.shortlistedVariant)
      : null;

  // The reason text follows the SAME branch recKey just took — live reason only in the live
  // branch (where it's guaranteed to describe recKey, since recKey IS liveKey there), the generic
  // on-record sentence for a snapshot (which has no stored reason of its own), null wherever recKey
  // itself is null (nothing to explain).
  const recommendedReason =
    recKey == null
      ? null
      : leg.decision == null
        ? (leg.recommendation?.reason ?? null)
        : RECOMMENDED_REASON_ON_RECORD;

  const groups: ForwarderGroup[] = [];
  for (const offer of leg.offers) {
    const key = offerKey(offer.quoteId, offer.variant);
    const cell: OfferCell = {
      kind: "offer",
      key,
      offer,
      recommended: recKey != null && key === recKey,
      sentForApproval: sentForApprovalKey != null && key === sentForApprovalKey,
      approved: approvedKey != null && key === approvedKey,
      stale: offer.quoteStatus === "REQUOTED" || offer.quoteStatus === "EXPIRED",
    };
    const existing = groups.find((g) => g.freightForwarderId === offer.freightForwarderId);
    if (existing) existing.cells.push(cell);
    else
      groups.push({
        freightForwarderId: offer.freightForwarderId,
        freightForwarderName: offer.freightForwarderName,
        cells: [cell],
      });
  }

  // S5.9.5 (design D7) — every forwarder at RFQ_SENT and beyond belongs IN the table, not in a list
  // below it. Appended after the offering forwarders rather than interleaved: the priced columns
  // are what the Executive is comparing, and a run of empty ones between them would break that
  // reading. The `existing` branch is defensive, not exercised: Task 1 subtracts any quote that
  // produced an offer from `pendingForwarders`, so a forwarder cannot legitimately be in both
  // lists. It is here so a stale or hand-built payload degrades to one group rather than rendering
  // the forwarder twice.
  for (const pf of leg.pendingForwarders) {
    const cell: PendingCell = {
      kind: "pending",
      key: pendingKey(pf.freightForwarderId),
      forwarder: pf,
    };
    const existing = groups.find((g) => g.freightForwarderId === pf.freightForwarderId);
    if (existing) existing.cells.push(cell);
    else
      groups.push({
        freightForwarderId: pf.freightForwarderId,
        freightForwarderName: pf.freightForwarderName,
        cells: [cell],
      });
  }

  return {
    groups,
    cells: groups.flatMap((g) => g.cells),
    recommendedKey: recKey,
    recommendedReason,
  };
}

export interface MetricDef {
  id: string;
  label: string;
  render(cell: OfferCell): string;
}

/**
 * The metrics every orientation renders, in order. `as const satisfies` (rather than a plain
 * `: MetricDef[]` annotation) is load-bearing, not style: it keeps each `id` a STRING LITERAL so
 * `MetricId` below is a closed union. Annotating with `MetricDef[]` widened `id` back to `string`,
 * which silently collapsed the two lookup maps into `Record<string, string>` — adding a metric then
 * compiled cleanly and rendered `data-testid="undefined-<key>"` in BOTH views (final review MINOR
 * #5; T2 recorded this as fixed but the widening made the fix inert). The `render` parameters are
 * annotated explicitly because `as const` removes the contextual typing that used to infer them.
 */
export const METRICS = [
  {
    id: "nativeTotal",
    label: "Total (native)",
    render: (c: OfferCell) =>
      c.offer.priced ? fmtNative(c.offer.nativeTotal, c.offer.currency) : "—",
  },
  {
    id: "rate",
    label: "Rate (per USD)",
    render: (c: OfferCell) => (c.offer.unitsPerUsd == null ? "—" : c.offer.unitsPerUsd.toFixed(5)),
  },
  {
    id: "usdTotal",
    label: "Total (USD)",
    render: (c: OfferCell) => (c.offer.priced ? fmtUsd(c.offer.usdTotal) : "—"),
  },
  {
    id: "transit",
    label: "Transit",
    render: (c: OfferCell) => (c.offer.transitDays == null ? "—" : `${c.offer.transitDays} d`),
  },
  {
    id: "validUntil",
    label: "Valid until",
    render: (c: OfferCell) => (c.offer.validUntil ? formatDate(c.offer.validUntil) : "—"),
  },
] as const satisfies readonly MetricDef[];

/** The closed union of metric ids, derived FROM `METRICS` — so the maps below are exhaustiveness-
 *  checked against the array itself and a new metric without map entries is a COMPILE error. */
export type MetricId = (typeof METRICS)[number]["id"];

/**
 * Per-metric `data-testid` suffix and cell class, shared by `ComparisonGridColumns` and
 * `ComparisonGridRows` (S5.7 T2) so the two orientations physically cannot drift on either — they
 * were untyped, per-file copies in `ComparisonGridColumns.tsx` alone until T2 lifted them here.
 * Keyed by the derived `MetricId` union (not by `string`, and not hand-listed) so a new `METRICS`
 * entry can't compile against a lookup map that forgot to grow with it.
 */
export const METRIC_TESTID: Record<MetricId, string> = {
  usdTotal: "offer-usd",
  nativeTotal: "offer-native",
  rate: "offer-rate",
  transit: "offer-transit",
  validUntil: "offer-valid",
};

/** Type treatment every orientation shares — font, numerals, muting. Alignment is deliberately
 *  NOT here: a metric is a COLUMN in the rows view (right-aligned under a right-aligned header)
 *  and a ROW in the columns view (centred under a centred offer header), so forcing one alignment
 *  on both is exactly what made values read as detached from their heading (S5.9.1 R6). Each grid
 *  component applies `METRIC_ALIGN` below alongside this map. */
export const METRIC_CELL_CLASS: Record<MetricId, string> = {
  usdTotal: "font-mono tabular-nums",
  nativeTotal: "font-mono tabular-nums",
  rate: "font-mono tabular-nums text-muted-foreground",
  transit: "text-muted-foreground",
  validUntil: "text-muted-foreground",
};

/** Alignment by orientation (S5.9.1 R6) — applied alongside `METRIC_CELL_CLASS` by each grid
 *  component, never folded into that shared map (see its doc comment for why). */
export const METRIC_ALIGN = { columns: "text-center", rows: "text-right" } as const;

/** The recommended row/column's tint (S5.7 item 2 — every cell, not just the header/label). Shared
 *  by both orientations for the same drift-proofing reason as the maps above. */
export const RECOMMENDED_TINT = "bg-emerald-500/10";

/** The recommendation marker (product item 2). Replaces the status-cell badge: a `★` beside the
 *  variant costs no column width, and the reason rides on its accessible name so the information
 *  is not lost with the badge. The footnote below the table explains it once per leg. */
export const RECOMMENDED_MARK = "★";
export const RECOMMENDATION_FOOTNOTE = "★ Recommended by the comparison engine.";

/** The "sent for approval" mark (S5.9.1 Task 5) — the product owner's second signal, "came for
 *  Approval", answered from `decision.shortlistedQuoteId`/`shortlistedVariant` the same way the
 *  `★` answers "Recommended" from the decision's snapshot. Deliberately a DIFFERENT glyph and
 *  colour, not a second use of `★`: recommended (the engine's opinion) and sent-for-approval (the
 *  maker's actual decision) are independent signals — an offer can be either, neither, or both —
 *  and a shared glyph could not represent "both" at all. `⚑` was chosen over a checkmark
 *  specifically because a checkmark reads as "approved" (an outcome this mark must not claim — the
 *  offer is only under review); a flag reads as "picked out for a decision" with no outcome
 *  implied. `text-primary` (this feature's own established accent for a highlighted identifier —
 *  see `CompareLegPanel.tsx`'s leg-code span) keeps it visually distinct from the star's emerald
 *  without inventing a new colour outside the app's palette. */
export const SENT_FOR_APPROVAL_MARK = "⚑";
export const SENT_FOR_APPROVAL_ACCESSIBLE_NAME = "Sent for approval";
export const SENT_FOR_APPROVAL_FOOTNOTE =
  "⚑ Sent for approval — the offer currently under checker review.";

/** S5.9.5 (D8) — the approved offer's mark. A checkmark, which `SENT_FOR_APPROVAL_MARK`'s own doc
 *  comment deliberately avoided precisely because "a checkmark reads as approved" — here that
 *  reading is the correct one. Its tint is the app's `primary`, distinct from the star's emerald,
 *  and the two can coexist on one cell (an offer can be both recommended and approved). */
export const APPROVED_MARK = "✔";
export const APPROVED_ACCESSIBLE_NAME = "Approved";
export const APPROVED_FOOTNOTE = "✔ Approved — the forwarder selected for this leg.";
export const APPROVED_TINT = "bg-primary/10";

/** S5.9.5 (D7) — what a forwarder who has not priced anything reads as in the grid. Deliberately
 *  NOT a status name: `ForwarderStatusBadge` in the same cell already gives the precise status
 *  (RFQ Sent / Expired / Invalid), and this is the variant slot, where every other cell names what
 *  was priced. */
export const NOT_QUOTED_LABEL = "Not quoted";
