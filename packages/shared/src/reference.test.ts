import { describe, it, expect } from "vitest";
import { COUNTRIES, COUNTRY_CODES, CURRENCIES, CURRENCY_CODES, getCountryName } from "./reference";

describe("reference data", () => {
  it("exposes country codes with unique 2-letter ISO codes", () => {
    expect(COUNTRIES.length).toBeGreaterThan(40);
    expect(COUNTRY_CODES).toContain("US");
    expect(COUNTRY_CODES).toContain("SG");
    expect(COUNTRY_CODES.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });
  it("exposes currency codes with unique 3-letter ISO codes", () => {
    expect(CURRENCY_CODES).toContain("USD");
    expect(CURRENCY_CODES).toContain("AED");
    expect(CURRENCY_CODES.every((c) => /^[A-Z]{3}$/.test(c))).toBe(true);
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
  });
  it("keeps CODES arrays in sync with the object lists", () => {
    expect(COUNTRY_CODES).toEqual(COUNTRIES.map((c) => c.code));
    expect(CURRENCY_CODES).toEqual(CURRENCIES.map((c) => c.code));
  });
});

describe("getCountryName", () => {
  it("maps a known code to its full name", () => {
    expect(getCountryName("IN")).toBe("India");
  });
  it("falls back to the raw code when unknown", () => {
    expect(getCountryName("ZZ")).toBe("ZZ");
  });
});
