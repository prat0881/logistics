import { describe, it, expect } from "vitest";
import { dedupeFindings } from "./findings";
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
