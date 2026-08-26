import type { Finding } from "./findings";

// ── Generic state-machine primitives (Technical Design §7.2) ───────────────────
// A guard returns `true` to allow, or `Finding[]` explaining WHY it is blocked.
export type Guard<C> = (ctx: C) => true | Finding[];
export type Effect<C> = (ctx: C) => Promise<void>;
export type TransitionKind = "forward" | "reopen";

export interface Transition<S extends string, E extends string, C> {
  from: S | S[];
  on: E;
  to: S;
  guard?: Guard<C>;
  effect?: Effect<C>;
  kind?: TransitionKind;
}

export interface Machine<S extends string, E extends string, C> {
  key: string;
  initial: S;
  transitions: Transition<S, E, C>[];
}

// Pure matcher — the only place "which edge fires" is decided. Used by StatusService.fire.
export function findTransition<S extends string, E extends string, C>(
  machine: Machine<S, E, C>,
  current: S,
  event: E,
): Transition<S, E, C> | undefined {
  return machine.transitions.find(
    (t) =>
      t.on === event && (Array.isArray(t.from) ? t.from.includes(current) : t.from === current),
  );
}

// ── Leg status vocabulary (§9.2) ───────────────────────────────────────────────
// Full vocabulary declared centrally; Stage 3 activates only DRAFT ↔ READY_FOR_RFQ.
export const LegStatus = {
  DRAFT: "DRAFT",
  READY_FOR_RFQ: "READY_FOR_RFQ",
  RFQ_SENT: "RFQ_SENT",
  PARTIALLY_QUOTED: "PARTIALLY_QUOTED",
  FULLY_QUOTED: "FULLY_QUOTED",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  AWARDED: "AWARDED",
  IN_TRANSIT: "IN_TRANSIT",
  DELIVERED: "DELIVERED",
  CLOSED: "CLOSED",
} as const;
export type LegStatus = (typeof LegStatus)[keyof typeof LegStatus];
export const LEG_STATUSES = Object.values(LegStatus) as [LegStatus, ...LegStatus[]];

// Leg events — add the Stage-4 forward triggers (VALIDATE_PASS/REOPEN already present).
export const LegEvent = {
  VALIDATE_PASS: "validate.pass",
  REOPEN: "reopen",
  SEND_RFQ: "rfq.send",
  QUOTE_PARTIAL: "quote.partial",
  QUOTE_FULL: "quote.full",
  SEND_FOR_APPROVAL: "send_for_approval",
  APPROVE: "approve",
  RETURN_FULL: "return.full",
  RETURN_PARTIAL: "return.partial",
  REOPEN_AWARD: "reopen_award",
  // S5.9.2 Q1 (register C7) — the two BACKWARD rollup edges a re-quote walks. Deliberately their
  // own events rather than reusing QUOTE_PARTIAL/SEND_RFQ from a later state: `findTransition`
  // matches on (from, on), so a backward `FULLY_QUOTED --quote.partial--> PARTIALLY_QUOTED` would
  // be indistinguishable in the StatusTransition log from the forward rollup, and there is no
  // existing event that lands on RFQ_SENT other than "the RFQ was distributed". Named
  // `requote.*` because a re-quote is the ONLY input allowed to fire them — see
  // leg-quote.projector.ts.
  REQUOTE_PARTIAL: "requote.partial", // FULLY_QUOTED -> PARTIALLY_QUOTED (a comparable sibling survives)
  REQUOTE_OUTSTANDING: "requote.outstanding", // -> RFQ_SENT (nothing comparable left at all)
} as const;
export type LegEvent = (typeof LegEvent)[keyof typeof LegEvent];
export const LEG_EVENTS = Object.values(LegEvent) as [LegEvent, ...LegEvent[]];

// ── Quote status vocabulary (spec §9.1 — Forwarder status) ──────────────────────
export const QuoteStatus = {
  SELECT: "SELECT",
  RFQ_SENT: "RFQ_SENT",
  QUOTED: "QUOTED",
  EXPIRED: "EXPIRED",
  INVALID: "INVALID",
  REQUOTED: "REQUOTED",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  CLOSED: "CLOSED",
  APPROVED: "APPROVED",
} as const;
export type QuoteStatus = (typeof QuoteStatus)[keyof typeof QuoteStatus];
export const QUOTE_STATUSES = Object.values(QuoteStatus) as [QuoteStatus, ...QuoteStatus[]];

export const QuoteEvent = {
  SEND: "send",       // SELECT → RFQ_SENT (on distribute)
  SUBMIT: "submit",   // RFQ_SENT → QUOTED
  EXPIRE: "expire",   // RFQ_SENT → EXPIRED
  INVALIDATE: "invalidate", // QUOTED → INVALID (change-order, sub-build 6)
  SEND_FOR_APPROVAL: "send_for_approval", // QUOTED → PENDING_APPROVAL
  APPROVE: "approve",             // PENDING_APPROVAL → APPROVED
  RETURN: "return",               // PENDING_APPROVAL → QUOTED (reject)
  UNAPPROVE: "unapprove",         // APPROVED → QUOTED
  // S5.9.5 (Step 5c) — PENDING_APPROVAL/APPROVED → EXPIRED. The reversal edge for an offer that
  // was already EXPIRED when it was sent for approval (S5.9.5 D4 made a priced-EXPIRED offer
  // sendable). RETURN and UNAPPROVE both land on QUOTED, which would hand a live status back to a
  // forwarder whose submission window closed and who never answered. A separate EVENT rather than
  // a second target for RETURN/UNAPPROVE because `findTransition` matches on (from, on), so one
  // event cannot have two destinations from the same source.
  RETURN_EXPIRED: "return_expired",
  REQUEST_REQUOTE: "request_requote", // QUOTED/APPROVED → REQUOTED
} as const;
export type QuoteEvent = (typeof QuoteEvent)[keyof typeof QuoteEvent];
export const QUOTE_EVENTS = Object.values(QuoteEvent) as [QuoteEvent, ...QuoteEvent[]];

// ── Query status vocabulary (§9.1) — derived/rollup, never hand-set ─────────────
export const QueryStatus = {
  DRAFT: "DRAFT",
  CREATED: "CREATED",
  RFQ_READY: "RFQ_READY",
  RFQ_SENT: "RFQ_SENT",
  QUOTED: "QUOTED",
  QUOTING_CLIENT: "QUOTING_CLIENT",
  NO_RESPONSE: "NO_RESPONSE",
  AWAITING_CLIENT_DECISION: "AWAITING_CLIENT_DECISION",
  WON: "WON",
  LOST: "LOST",
  CLOSED: "CLOSED",
} as const;
export type QueryStatus = (typeof QueryStatus)[keyof typeof QueryStatus];
export const QUERY_STATUSES = Object.values(QueryStatus) as [QueryStatus, ...QueryStatus[]];

// Query-level milestones layered on top of the leg rollup (client-facing events
// that legs never have): Created, Awaiting Client Decision, Won, Lost, Closed.
export interface QueryMilestones {
  created?: boolean;
  rfqReady?: boolean;
  noResponse?: boolean;
  awaitingClientDecision?: boolean;
  quotingClient?: boolean;
  won?: boolean;
  lost?: boolean;
  closed?: boolean;
}

const LEG_RANK: Record<LegStatus, number> = {
  DRAFT: 0,
  READY_FOR_RFQ: 1,
  RFQ_SENT: 2,
  PARTIALLY_QUOTED: 3,
  FULLY_QUOTED: 4,
  PENDING_APPROVAL: 5,
  APPROVED: 6,
  AWARDED: 7,
  IN_TRANSIT: 8,
  DELIVERED: 9,
  CLOSED: 10,
};

function leastAdvanced(legStatuses: LegStatus[]): LegStatus {
  return legStatuses.reduce((m, s) => (LEG_RANK[s] < LEG_RANK[m] ? s : m), legStatuses[0]);
}

// Derived query status: query-level milestones win; otherwise the least-advanced leg
// gates the rollup (the query only advances when ALL legs have, §9.1). Plan 5: RFQ_READY
// is gated on the `rfqReady` milestone in BOTH branches (was inconsistently `created` in
// the leg branch); CREATED now EMERGES from the leg rollup (all legs READY_FOR_RFQ, no
// rfqReady milestone) so `created` is no longer aliased to rfqReadyAt.
export function deriveQueryStatus(
  legStatuses: LegStatus[],
  milestones: QueryMilestones = {},
): QueryStatus {
  if (milestones.closed) return QueryStatus.CLOSED;
  if (milestones.lost) return QueryStatus.LOST;
  if (milestones.won) return QueryStatus.WON;
  if (milestones.awaitingClientDecision) return QueryStatus.AWAITING_CLIENT_DECISION;
  if (milestones.quotingClient) return QueryStatus.QUOTING_CLIENT;

  if (legStatuses.length === 0) {
    // No legs (legacy Plan-4 drafts / pre-leg queries): query-level milestones only.
    if (milestones.rfqReady) return QueryStatus.RFQ_READY;
    if (milestones.created) return QueryStatus.CREATED;
    return QueryStatus.DRAFT;
  }

  switch (leastAdvanced(legStatuses)) {
    case LegStatus.DRAFT:
      return QueryStatus.DRAFT;
    case LegStatus.READY_FOR_RFQ:
      // All legs valid & ready ⇒ CREATED; RFQ_READY only once Create Query set the milestone.
      return milestones.rfqReady ? QueryStatus.RFQ_READY : QueryStatus.CREATED;
    case LegStatus.RFQ_SENT:
    case LegStatus.PARTIALLY_QUOTED:
      return QueryStatus.RFQ_SENT;
    case LegStatus.FULLY_QUOTED:
      return milestones.noResponse ? QueryStatus.NO_RESPONSE : QueryStatus.QUOTED;
    case LegStatus.PENDING_APPROVAL:
    case LegStatus.APPROVED:
      return QueryStatus.QUOTED;
    case LegStatus.DELIVERED:
      return QueryStatus.CLOSED; // all legs delivered (§9.1)
    case LegStatus.CLOSED:
      return QueryStatus.CLOSED;
    default:
      // AWARDED / IN_TRANSIT: no query-level rollup status until Stage 5+/8–9 (advance via
      // milestones — WON on PO, CLOSED on closure). Documented placeholder, unreachable in
      // Stage 3 (no edges reach those states).
      return QueryStatus.QUOTED;
  }
}

/**
 * Quote states that count as "settled" for the leg rollup (§9.2). `PENDING_APPROVAL` and
 * `APPROVED` count — a quote under review or already approved is not something we are still
 * waiting on. `REQUOTED` deliberately does NOT: a re-quote in flight is genuinely unresolved.
 */
const LEG_ROLLUP_RESOLVED: readonly QuoteStatus[] = [
  QuoteStatus.QUOTED,
  QuoteStatus.EXPIRED,
  QuoteStatus.CLOSED,
  QuoteStatus.PENDING_APPROVAL,
  QuoteStatus.APPROVED,
];

/**
 * What a leg's status SHOULD be, given its quotes. `null` means "nothing to say" — either
 * nothing was ever distributed, or every distributed quote is still outstanding, in which case
 * the leg keeps whatever status it already has.
 *
 * Undistributed (`SELECT`) quotes are excluded: they were never sent, so they can never resolve.
 */
export function rollupLegTarget(quoteStatuses: QuoteStatus[]): LegStatus | null {
  const distributed = quoteStatuses.filter((s) => s !== QuoteStatus.SELECT);
  if (distributed.length === 0) return null;
  if (distributed.every((s) => LEG_ROLLUP_RESOLVED.includes(s))) return LegStatus.FULLY_QUOTED;
  if (distributed.some((s) => s === QuoteStatus.QUOTED)) return LegStatus.PARTIALLY_QUOTED;
  return null;
}
