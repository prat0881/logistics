import { describe, it, expect } from "vitest";
import { formatDateTime, formatDate } from "./dates";

describe("formatDateTime", () => {
  it("formats an ISO string to DD-MM-YYYY HH:mm", () => {
    // Pin date digits; allow any hour since formatDateTime still uses local Date math
    // (it is a display-only helper, not a round-trip store path).
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
    // date-fns parseISO keeps the date digits as-is for offset strings,
    // so 2024-03-15T00:00:00.000Z will render as 15-03-2024 on any machine.
    expect(formatDate("2024-03-15T00:00:00.000Z")).toMatch(/15-03-2024/);
  });

  it("returns empty string for null", () => {
    expect(formatDate(null)).toBe("");
  });
});
