import { describe, it, expect } from "vitest";
import { dedupeFindings, findingTabKey } from "./findings";
import type { Finding } from "./findings";

const leg1: Finding = { rule: "T1", severity: "blocking", scope: { type: "leg", id: "l1" }, message: "broken" };
const leg1dup: Finding = { rule: "T1", severity: "blocking", scope: { type: "leg", id: "l1" }, message: "broken" };
const leg2: Finding = { rule: "T1", severity: "blocking", scope: { type: "leg", id: "l2" }, message: "broken" };
const warn: Finding = { rule: "W1", severity: "warning", scope: { type: "query" }, message: "check this" };

describe("dedupeFindings", () => {
  it("returns empty array for empty input", () => {
    expect(dedupeFindings([])).toEqual([]);
  });

  it("collapses duplicate T1 findings to one", () => {
    const result = dedupeFindings([leg1, leg1dup]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(leg1);
  });

  it("keeps distinct scopes (different id) as separate findings", () => {
    const result = dedupeFindings([leg1, leg2]);
    expect(result).toHaveLength(2);
  });

  it("keeps findings with different rules as separate", () => {
    const result = dedupeFindings([leg1, warn]);
    expect(result).toHaveLength(2);
  });

  it("deduplicates when same finding appears multiple times", () => {
    const result = dedupeFindings([leg1, leg1dup, leg2, leg1]);
    expect(result).toHaveLength(2);
    expect(result[0].scope.id).toBe("l1");
    expect(result[1].scope.id).toBe("l2");
  });

  it("distinguishes findings with no scope id from those with id", () => {
    const noId: Finding = { rule: "T1", severity: "blocking", scope: { type: "leg" }, message: "broken" };
    const withId: Finding = { rule: "T1", severity: "blocking", scope: { type: "leg", id: "l1" }, message: "broken" };
    const result = dedupeFindings([noId, withId]);
    expect(result).toHaveLength(2);
  });

  it("deduplicates findings with no scope id", () => {
    const noId: Finding = { rule: "T1", severity: "blocking", scope: { type: "leg" }, message: "broken" };
    const noIdDup: Finding = { rule: "T1", severity: "blocking", scope: { type: "leg" }, message: "broken" };
    const result = dedupeFindings([noId, noIdDup]);
    expect(result).toHaveLength(1);
  });
});

const f = (over: Partial<Finding>): Finding => ({
  rule: "F1", severity: "blocking", scope: { type: "query" }, message: "x", ...over,
});

describe("findingTabKey", () => {
  it("F1 query-mandatory → client", () => {
    expect(findingTabKey(f({ rule: "F1", scope: { type: "query", id: "q1" } }))).toBe("client");
  });
  it("incoterms field finding → shipment", () => {
    expect(findingTabKey(f({ rule: "F1", scope: { type: "field", id: "incoterms" } }))).toBe("shipment");
  });
  it("F6 / cargo → cargo", () => {
    expect(findingTabKey(f({ rule: "F6", scope: { type: "cargo", id: "c1" } }))).toBe("cargo");
    expect(findingTabKey(f({ rule: "R2", scope: { type: "cargo", id: "c1" } }))).toBe("cargo");
  });
  it("leg / point / query-scoped route rule → legs", () => {
    expect(findingTabKey(f({ rule: "R1", scope: { type: "leg", id: "l1" } }))).toBe("legs");
    expect(findingTabKey(f({ rule: "R8", scope: { type: "point", id: "p1" } }))).toBe("legs");
    expect(findingTabKey(f({ rule: "R3", scope: { type: "query", id: "q1" } }))).toBe("legs");
  });
  it("checklist / notes field findings → notes", () => {
    expect(findingTabKey(f({ rule: "F7", scope: { type: "field", id: "notes" } }))).toBe("notes");
    expect(findingTabKey(f({ rule: "F7", scope: { type: "field", id: "checklist:weight-confirmed" } }))).toBe("notes");
  });
});
