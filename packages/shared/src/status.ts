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
  AWARDED: "AWARDED",
  IN_TRANSIT: "IN_TRANSIT",
  DELIVERED: "DELIVERED",
  CLOSED: "CLOSED",
} as const;
export type LegStatus = (typeof LegStatus)[keyof typeof LegStatus];
export const LEG_STATUSES = Object.values(LegStatus) as [LegStatus, ...LegStatus[]];

export const LegEvent = {
  VALIDATE_PASS: "validate.pass",
  REOPEN: "reopen",
} as const;
export type LegEvent = (typeof LegEvent)[keyof typeof LegEvent];
export const LEG_EVENTS = Object.values(LegEvent) as [LegEvent, ...LegEvent[]];

// ── Query status vocabulary (§9.1) — derived/rollup, never hand-set ─────────────
export const QueryStatus = {
  DRAFT: "DRAFT",
  CREATED: "CREATED",
  RFQ_READY: "RFQ_READY",
  RFQ_SENT: "RFQ_SENT",
  QUOTED: "QUOTED",
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
  awaitingClientDecision?: boolean;
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
  AWARDED: 5,
  IN_TRANSIT: 6,
  DELIVERED: 7,
  CLOSED: 8,
};

function leastAdvanced(legStatuses: LegStatus[]): LegStatus {
  return legStatuses.reduce((m, s) => (LEG_RANK[s] < LEG_RANK[m] ? s : m), legStatuses[0]);
}

// Derived query status: query-level milestones win; otherwise the least-advanced
// leg gates the rollup (the query only advances when ALL legs have, §9.1).
export function deriveQueryStatus(
  legStatuses: LegStatus[],
  milestones: QueryMilestones = {},
): QueryStatus {
  if (milestones.closed) return QueryStatus.CLOSED;
  if (milestones.lost) return QueryStatus.LOST;
  if (milestones.won) return QueryStatus.WON;
  if (milestones.awaitingClientDecision) return QueryStatus.AWAITING_CLIENT_DECISION;
  if (legStatuses.length === 0) return QueryStatus.DRAFT;

  switch (leastAdvanced(legStatuses)) {
    case LegStatus.DRAFT:
      return QueryStatus.DRAFT;
    case LegStatus.READY_FOR_RFQ:
      return milestones.created ? QueryStatus.RFQ_READY : QueryStatus.CREATED;
    case LegStatus.RFQ_SENT:
    case LegStatus.PARTIALLY_QUOTED:
      return QueryStatus.RFQ_SENT;
    case LegStatus.FULLY_QUOTED:
      return QueryStatus.QUOTED;
    case LegStatus.CLOSED:
      return QueryStatus.CLOSED;
    default:
      // AWARDED / IN_TRANSIT / DELIVERED — driven by milestones + later stages.
      return QueryStatus.QUOTED;
  }
}
