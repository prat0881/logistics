import { describe, it, expect } from "vitest";
import { formatDateTime, formatDate, toIsoOffset } from "./dates";

describe("formatDateTime", () => {
  it("formats an ISO string to DD-MM-YYYY HH:mm", () => {
    expect(formatDateTime("2024-03-15T14:30:00.000Z")).toMatch(/15-03-2024 \d{2}:\d{2}/);
  });

  it("returns empty string for null", () => {
    expect(formatDateTime(null)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(formatDateTime("")).toBe("");
  });
});

describe("formatDate", () => {
  it("formats an ISO string to DD-MM-YYYY", () => {
    // Pin to exact expected date rather than a pattern that matches MM-DD-YYYY too
    expect(formatDate("2024-03-15T00:00:00.000Z")).toMatch(/15-03-2024/);
  });

  it("returns empty string for null", () => {
    expect(formatDate(null)).toBe("");
  });
});

describe("toIsoOffset", () => {
  it("converts datetime-local string to offset ISO string", () => {
    const result = toIsoOffset("2024-03-15T14:30");
    // Should be a valid ISO string with offset or Z
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(new Date(result).getTime()).not.toBeNaN();
  });

  it("preserves the local hour in the output", () => {
    // toIsoOffset should represent the same local hour regardless of timezone
    const result = toIsoOffset("2024-06-20T09:00");
    // The output is an offset-ISO string: extract the time portion (before the +/- offset)
    const timePart = result.match(/T(\d{2}):(\d{2})/);
    expect(timePart).not.toBeNull();
    // Hour must be 09 — the same as the input local hour
    expect(timePart![1]).toBe("09");
    expect(timePart![2]).toBe("00");
  });
});
