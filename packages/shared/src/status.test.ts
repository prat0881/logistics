import { describe, it, expect } from "vitest";
import {
  findTransition,
  deriveQueryStatus,
  LegStatus,
  LegEvent,
  QueryStatus,
  LEG_STATUSES,
  LEG_EVENTS,
  QUERY_STATUSES,
  type Machine,
} from "./status";

interface Ctx {
  routeValid?: boolean;
}

const legMachine: Machine<LegStatus, LegEvent, Ctx> = {
  key: "leg",
  initial: LegStatus.DRAFT,
  transitions: [
    {
      from: LegStatus.DRAFT,
      on: LegEvent.VALIDATE_PASS,
      to: LegStatus.READY_FOR_RFQ,
      kind: "forward",
    },
    { from: LegStatus.READY_FOR_RFQ, on: LegEvent.REOPEN, to: LegStatus.DRAFT, kind: "reopen" },
  ],
};

describe("findTransition", () => {
  it("matches the forward edge from a scalar `from`", () => {
    expect(findTransition(legMachine, LegStatus.DRAFT, LegEvent.VALIDATE_PASS)?.to).toBe(
      LegStatus.READY_FOR_RFQ,
    );
  });

  it("matches the reopen reverse edge", () => {
    expect(findTransition(legMachine, LegStatus.READY_FOR_RFQ, LegEvent.REOPEN)?.to).toBe(
      LegStatus.DRAFT,
    );
  });

  it("returns undefined for an illegal (from,event) pair", () => {
    expect(findTransition(legMachine, LegStatus.DRAFT, LegEvent.REOPEN)).toBeUndefined();
  });

  it("matches an array `from` (multiple source states)", () => {
    const m: Machine<LegStatus, LegEvent, Ctx> = {
      key: "leg",
      initial: LegStatus.DRAFT,
      transitions: [
        {
          from: [LegStatus.RFQ_SENT, LegStatus.FULLY_QUOTED],
          on: LegEvent.REOPEN,
          to: LegStatus.READY_FOR_RFQ,
        },
      ],
    };
    expect(findTransition(m, LegStatus.FULLY_QUOTED, LegEvent.REOPEN)?.to).toBe(
      LegStatus.READY_FOR_RFQ,
    );
  });
});

describe("deriveQueryStatus (least-advanced gate + milestones, §9.1)", () => {
  it("is DRAFT with no legs", () => {
    expect(deriveQueryStatus([])).toBe(QueryStatus.DRAFT);
  });

  it("is gated by the least-advanced leg", () => {
    expect(deriveQueryStatus([LegStatus.DRAFT, LegStatus.READY_FOR_RFQ])).toBe(QueryStatus.DRAFT);
  });

  it("finds the least-advanced leg regardless of position (real reduce, not legStatuses[0])", () => {
    expect(
      deriveQueryStatus([LegStatus.FULLY_QUOTED, LegStatus.DRAFT, LegStatus.READY_FOR_RFQ]),
    ).toBe(QueryStatus.DRAFT); // least-advanced out of position
    expect(deriveQueryStatus([LegStatus.PARTIALLY_QUOTED, LegStatus.FULLY_QUOTED])).toBe(
      QueryStatus.RFQ_SENT,
    ); // PARTIALLY_QUOTED as the gate
  });

  it("is CREATED when all legs are READY_FOR_RFQ and Create Query has not run", () => {
    expect(deriveQueryStatus([LegStatus.READY_FOR_RFQ, LegStatus.READY_FOR_RFQ])).toBe(
      QueryStatus.CREATED,
    );
  });

  it("is RFQ_READY when all legs are READY_FOR_RFQ and the created milestone is set", () => {
    expect(deriveQueryStatus([LegStatus.READY_FOR_RFQ], { created: true })).toBe(
      QueryStatus.RFQ_READY,
    );
  });

  it("is RFQ_SENT when the least leg is RFQ_SENT/PARTIALLY_QUOTED", () => {
    expect(deriveQueryStatus([LegStatus.RFQ_SENT, LegStatus.FULLY_QUOTED])).toBe(
      QueryStatus.RFQ_SENT,
    );
  });

  it("is QUOTED when all legs are FULLY_QUOTED", () => {
    expect(deriveQueryStatus([LegStatus.FULLY_QUOTED, LegStatus.FULLY_QUOTED])).toBe(
      QueryStatus.QUOTED,
    );
  });

  it("lets query-level milestones override the leg rollup", () => {
    expect(deriveQueryStatus([LegStatus.READY_FOR_RFQ], { closed: true })).toBe(QueryStatus.CLOSED);
    expect(deriveQueryStatus([LegStatus.FULLY_QUOTED], { won: true })).toBe(QueryStatus.WON);
    expect(deriveQueryStatus([LegStatus.RFQ_SENT], { lost: true })).toBe(QueryStatus.LOST);
    expect(deriveQueryStatus([LegStatus.RFQ_SENT], { awaitingClientDecision: true })).toBe(
      QueryStatus.AWAITING_CLIENT_DECISION,
    );
  });
});

describe("status vocabularies", () => {
  it("pins the companion-array vocabularies (order matters for downstream Zod enums)", () => {
    expect(LEG_STATUSES).toEqual([
      "DRAFT",
      "READY_FOR_RFQ",
      "RFQ_SENT",
      "PARTIALLY_QUOTED",
      "FULLY_QUOTED",
      "AWARDED",
      "IN_TRANSIT",
      "DELIVERED",
      "CLOSED",
    ]);
    expect(LEG_EVENTS).toEqual(["validate.pass", "reopen"]);
    expect(QUERY_STATUSES).toEqual([
      "DRAFT",
      "CREATED",
      "RFQ_READY",
      "RFQ_SENT",
      "QUOTED",
      "AWAITING_CLIENT_DECISION",
      "WON",
      "LOST",
      "CLOSED",
    ]);
  });
});
