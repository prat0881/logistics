import { describe, it, expect } from "vitest";
import { formatDateTime, formatDate, toIsoOffset, isoToLocalInput } from "./dates";

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

describe("isoToLocalInput", () => {
  // FLOATING WALL-CLOCK: digits must be extracted verbatim, independent of runner TZ.

  it("extracts wall-clock digits from an offset ISO string (+05:30)", () => {
    // Must be exactly "2026-06-15T09:00" on ANY machine — no timezone shift.
    expect(isoToLocalInput("2026-06-15T09:00:00+05:30")).toBe("2026-06-15T09:00");
  });

  it("extracts wall-clock digits from a UTC-offset ISO string (+00:00)", () => {
    expect(isoToLocalInput("2024-03-15T14:30:00+00:00")).toBe("2024-03-15T14:30");
  });

  it("extracts wall-clock digits from a Z-suffix ISO string", () => {
    expect(isoToLocalInput("2024-03-15T14:30:00Z")).toBe("2024-03-15T14:30");
  });

  it("extracts wall-clock digits from a negative-offset ISO string (-08:00)", () => {
    expect(isoToLocalInput("2024-12-01T23:59:00-08:00")).toBe("2024-12-01T23:59");
  });

  it("extracts wall-clock digits from an ISO string without offset suffix", () => {
    expect(isoToLocalInput("2024-03-15T14:30:00")).toBe("2024-03-15T14:30");
  });

  it("returns empty string for null", () => {
    expect(isoToLocalInput(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(isoToLocalInput(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(isoToLocalInput("")).toBe("");
  });

  it("returns empty string for invalid ISO", () => {
    expect(isoToLocalInput("not-a-date")).toBe("");
  });
});

describe("toIsoOffset", () => {
  it("preserves the entered wall-clock hour in the output", () => {
    const result = toIsoOffset("2024-06-20T09:00");
    // The output is an offset-ISO string: extract the time portion (before the +/- offset)
    const timePart = result.match(/T(\d{2}):(\d{2})/);
    expect(timePart).not.toBeNull();
    // Hour must be 09 — the same as the input local hour, on ANY machine.
    expect(timePart![1]).toBe("09");
    expect(timePart![2]).toBe("00");
  });

  it("produces an ISO string with an explicit offset (not bare Z unless UTC machine)", () => {
    const result = toIsoOffset("2026-06-15T09:00");
    // Must match YYYY-MM-DDTHH:MM:SS+HH:MM or YYYY-MM-DDTHH:MM:SS-HH:MM or ...+00:00
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("round-trip: local → toIsoOffset → isoToLocalInput returns the SAME local string", () => {
    const local = "2026-06-15T09:00";
    const iso = toIsoOffset(local);
    const back = isoToLocalInput(iso);
    expect(back).toBe(local);
  });

  it("round-trip is stable for a midnight value", () => {
    const local = "2026-01-01T00:00";
    expect(isoToLocalInput(toIsoOffset(local))).toBe(local);
  });

  it("round-trip is stable for an end-of-day value", () => {
    const local = "2026-12-31T23:59";
    expect(isoToLocalInput(toIsoOffset(local))).toBe(local);
  });
});
