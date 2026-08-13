import { describe, it, expect } from "vitest";
import { toUsd, latestRateByCurrency, fxRateCreateSchema, type FxRateDto } from "./fx";

const rate = (
  currency: string,
  unitsPerUsd: number,
  effectiveFrom: string,
  createdAt: string = effectiveFrom,
): FxRateDto => ({
  id: `${currency}-${effectiveFrom}-${createdAt}`,
  currency,
  unitsPerUsd,
  effectiveFrom,
  note: null,
  createdById: null,
  createdAt,
});

describe("toUsd", () => {
  it("passes USD through unchanged, ignoring any rate", () => {
    expect(toUsd(1500, "USD", null)).toBe(1500);
  });
  it("divides by unitsPerUsd for a foreign currency", () => {
    expect(toUsd(83200, "INR", { unitsPerUsd: 83.2 })).toBe(1000);
  });
  it("rounds to cents", () => {
    expect(toUsd(100, "INR", { unitsPerUsd: 83.2 })).toBe(1.2); // 1.2019… → 1.20
  });
  it("returns null when a foreign currency has no rate", () => {
    expect(toUsd(1000, "INR", null)).toBeNull();
  });
  it("returns null for a non-positive rate instead of dividing (e.g. Infinity)", () => {
    expect(toUsd(1000, "INR", { unitsPerUsd: 0 })).toBeNull();
  });
});

describe("latestRateByCurrency", () => {
  it("keeps the newest effectiveFrom per currency", () => {
    const m = latestRateByCurrency([
      rate("INR", 82, "2026-08-01T00:00:00.000Z"),
      rate("INR", 83.2, "2026-08-10T00:00:00.000Z"),
      rate("EUR", 0.92, "2026-08-05T00:00:00.000Z"),
    ]);
    expect(m.get("INR")?.unitsPerUsd).toBe(83.2);
    expect(m.get("EUR")?.unitsPerUsd).toBe(0.92);
  });
  it("breaks a tie on identical effectiveFrom by keeping the later createdAt, regardless of input order", () => {
    const older = rate("INR", 82, "2026-08-10T00:00:00.000Z", "2026-08-10T09:00:00.000Z");
    const newer = rate("INR", 83.2, "2026-08-10T00:00:00.000Z", "2026-08-10T15:00:00.000Z");

    expect(latestRateByCurrency([older, newer]).get("INR")?.unitsPerUsd).toBe(83.2);
    expect(latestRateByCurrency([newer, older]).get("INR")?.unitsPerUsd).toBe(83.2);
  });
});

describe("fxRateCreateSchema", () => {
  it("rejects USD (base currency, never stored)", () => {
    expect(fxRateCreateSchema.safeParse({ currency: "USD", unitsPerUsd: 1 }).success).toBe(false);
  });
  it("rejects a non-positive rate", () => {
    expect(fxRateCreateSchema.safeParse({ currency: "INR", unitsPerUsd: 0 }).success).toBe(false);
  });
  it("accepts a valid foreign rate", () => {
    expect(fxRateCreateSchema.safeParse({ currency: "INR", unitsPerUsd: 83.2 }).success).toBe(true);
  });
});
