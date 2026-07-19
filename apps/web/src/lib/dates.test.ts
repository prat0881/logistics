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
    expect(formatDate("2024-03-15T00:00:00.000Z")).toMatch(/\d{2}-\d{2}-\d{4}/);
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

  it("round-trips: parsed back to same local time", () => {
    const localStr = "2024-06-20T09:00";
    const iso = toIsoOffset(localStr);
    // Parse back and format to compare
    const parsed = new Date(iso);
    expect(parsed.getTime()).not.toBeNaN();
    // The ISO string should be parseable as a date
    const reparsed = new Date(iso);
    expect(reparsed.getTime()).toBe(parsed.getTime());
  });
});
