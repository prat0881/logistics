// format.test.ts
import { describe, it, expect } from "vitest";
import { fmtAmount, fmtWeight, fmtCbm, fmtDecimal, toDatetimeLocal, fromDatetimeLocal } from "./format";

describe("format helpers", () => {
  it("fmtAmount groups thousands with 2dp, dash for null", () => {
    expect(fmtAmount(1250)).toBe("1,250.00");
    expect(fmtAmount(null)).toBe("—");
  });
  it("fmtWeight is 3dp tonnes", () => expect(fmtWeight(2.5)).toBe("2.500"));
  it("fmtCbm parses strings, 4dp, dash for null", () => {
    expect(fmtCbm("1.2")).toBe("1.2000");
    expect(fmtCbm(null)).toBe("—");
  });
  it("fmtDecimal handles NaN/null", () => expect(fmtDecimal("x")).toBe("—"));
  it("datetime-local round-trips a UTC instant back to an ISO instant", () => {
    const iso = "2026-08-01T09:30:00.000Z";
    const local = toDatetimeLocal(iso);          // viewer-local wall time
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(fromDatetimeLocal(local)!).getTime()).toBe(new Date(iso).getTime());
  });
  it("fromDatetimeLocal maps empty to null", () => expect(fromDatetimeLocal("")).toBeNull());
});
