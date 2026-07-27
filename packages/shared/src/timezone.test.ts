// packages/shared/src/timezone.test.ts
import { describe, it, expect } from "vitest";
import {
  isValidIanaZone,
  zonedInputToUtc,
  utcToZonedInput,
  zoneLabel,
  formatInZone,
} from "./timezone";

describe("isValidIanaZone", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidIanaZone("Asia/Kolkata")).toBe(true);
    expect(isValidIanaZone("America/New_York")).toBe(true);
    expect(isValidIanaZone("UTC")).toBe(true);
    expect(isValidIanaZone("Not/AZone")).toBe(false);
    expect(isValidIanaZone("")).toBe(false);
  });
});

describe("zonedInputToUtc / utcToZonedInput round-trip", () => {
  it("interprets the wall-clock in the given zone (IST, +05:30, no DST)", () => {
    // 09:00 in Kolkata is 03:30 UTC.
    expect(zonedInputToUtc("2026-06-15T09:00", "Asia/Kolkata")).toBe("2026-06-15T03:30:00.000Z");
    expect(utcToZonedInput("2026-06-15T03:30:00.000Z", "Asia/Kolkata")).toBe("2026-06-15T09:00");
  });

  it("interprets the wall-clock in Singapore (+08:00)", () => {
    expect(zonedInputToUtc("2026-06-15T09:00", "Asia/Singapore")).toBe("2026-06-15T01:00:00.000Z");
    expect(utcToZonedInput("2026-06-15T01:00:00.000Z", "Asia/Singapore")).toBe("2026-06-15T09:00");
  });

  it("round-trips a value back to the same wall-clock digits", () => {
    const wall = "2026-03-10T14:45";
    for (const z of ["Asia/Kolkata", "America/New_York", "Australia/Sydney", "UTC"]) {
      expect(utcToZonedInput(zonedInputToUtc(wall, z), z)).toBe(wall);
    }
  });

  it("handles a DST boundary (America/New_York: EST −05:00 in Jan, EDT −04:00 in Jul)", () => {
    // Winter: 09:00 EST = 14:00 UTC.
    expect(zonedInputToUtc("2026-01-15T09:00", "America/New_York")).toBe("2026-01-15T14:00:00.000Z");
    // Summer: 09:00 EDT = 13:00 UTC.
    expect(zonedInputToUtc("2026-07-15T09:00", "America/New_York")).toBe("2026-07-15T13:00:00.000Z");
    // And back.
    expect(utcToZonedInput("2026-01-15T14:00:00.000Z", "America/New_York")).toBe("2026-01-15T09:00");
    expect(utcToZonedInput("2026-07-15T13:00:00.000Z", "America/New_York")).toBe("2026-07-15T09:00");
  });
});

describe("midnight handling (no 24:00 day-off)", () => {
  it("round-trips wall-clock midnight in a +08:00 zone", () => {
    // 2026-06-14T16:00Z is 00:00 on 2026-06-15 in Singapore (+08:00).
    expect(utcToZonedInput("2026-06-14T16:00:00.000Z", "Asia/Singapore")).toBe("2026-06-15T00:00");
    expect(zonedInputToUtc("2026-06-15T00:00", "Asia/Singapore")).toBe("2026-06-14T16:00:00.000Z");
  });
  it("round-trips UTC midnight in UTC", () => {
    expect(utcToZonedInput("2026-06-15T00:00:00.000Z", "UTC")).toBe("2026-06-15T00:00");
    expect(zonedInputToUtc("2026-06-15T00:00", "UTC")).toBe("2026-06-15T00:00:00.000Z");
  });
});

describe("zoneLabel / formatInZone", () => {
  it("labels a zone with a non-empty short name", () => {
    expect(zoneLabel("America/New_York", "2026-01-15T14:00:00.000Z")).toMatch(/E[SD]T|GMT/);
    expect(zoneLabel("Asia/Kolkata", "2026-06-15T03:30:00.000Z").length).toBeGreaterThan(0);
  });
  it("formats an instant as dd-MM-yyyy HH:mm + a zone label", () => {
    expect(formatInZone("2026-06-15T03:30:00.000Z", "Asia/Kolkata")).toMatch(
      /^15-06-2026 09:00 .+/,
    );
  });
  it("returns empty string for a null/empty instant", () => {
    expect(formatInZone("", "Asia/Kolkata")).toBe("");
  });
});

describe("zoneLabel padded offset", () => {
  it("returns a padded GMT offset for fixed-offset zones", () => {
    expect(zoneLabel("Asia/Kolkata")).toBe("GMT+05:30");
    expect(zoneLabel("Asia/Singapore")).toBe("GMT+08:00");
    expect(zoneLabel("UTC")).toMatch(/GMT|UTC/);
  });
});
