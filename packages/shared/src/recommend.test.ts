import { describe, it, expect } from "vitest";
import { recommendOffer, transitKeyForVariant, type RecommendOffer } from "./recommend";
import { SEA_VARIANT_KEY, AIR_VARIANT_KEY } from "./quote";

const o = (p: Partial<RecommendOffer> & { quoteId: string }): RecommendOffer => ({
  variant: null, usdTotal: 1000, transitDays: 5, submittedAt: "2026-08-10T00:00:00.000Z", ...p,
});

describe("transitKeyForVariant", () => {
  it("Road keys transit by the variant itself", () => {
    expect(transitKeyForVariant("ROAD", "DEDICATED")).toBe("DEDICATED");
    expect(transitKeyForVariant("ROAD", "GROUPAGE")).toBe("GROUPAGE");
  });
  it("Sea collapses both FCL/LCL to the common SEA key", () => {
    expect(transitKeyForVariant("SEA", "FCL")).toBe(SEA_VARIANT_KEY);
    expect(transitKeyForVariant("SEA", "LCL")).toBe(SEA_VARIANT_KEY);
  });
  it("Air (and null variant) uses the AIR key", () => {
    expect(transitKeyForVariant("AIR", null)).toBe(AIR_VARIANT_KEY);
    expect(transitKeyForVariant(null, null)).toBe(AIR_VARIANT_KEY);
  });
});

describe("recommendOffer", () => {
  it("HIGH → fastest transit wins", () => {
    const r = recommendOffer({ priority: "HIGH", offers: [
      o({ quoteId: "slow", transitDays: 5, usdTotal: 900 }),
      o({ quoteId: "fast", transitDays: 3, usdTotal: 1200 }),
    ]});
    expect(r?.quoteId).toBe("fast");
  });
  it("HIGH transit tie → lower price wins", () => {
    const r = recommendOffer({ priority: "HIGH", offers: [
      o({ quoteId: "pricey", transitDays: 3, usdTotal: 1200 }),
      o({ quoteId: "cheap", transitDays: 3, usdTotal: 1000 }),
    ]});
    expect(r?.quoteId).toBe("cheap");
  });
  it("URGENT behaves like HIGH (fastest wins)", () => {
    const r = recommendOffer({ priority: "URGENT", offers: [
      o({ quoteId: "fast", transitDays: 2, usdTotal: 1500 }),
      o({ quoteId: "slow", transitDays: 4, usdTotal: 800 }),
    ]});
    expect(r?.quoteId).toBe("fast");
  });
  it("MEDIUM → lowest price wins", () => {
    const r = recommendOffer({ priority: "MEDIUM", offers: [
      o({ quoteId: "fast", transitDays: 2, usdTotal: 1500 }),
      o({ quoteId: "cheap", transitDays: 6, usdTotal: 800 }),
    ]});
    expect(r?.quoteId).toBe("cheap");
  });
  it("MEDIUM price tie → faster transit wins", () => {
    const r = recommendOffer({ priority: "LOW", offers: [
      o({ quoteId: "slow", transitDays: 6, usdTotal: 1000 }),
      o({ quoteId: "fast", transitDays: 3, usdTotal: 1000 }),
    ]});
    expect(r?.quoteId).toBe("fast");
  });
  it("final tie → earliest submittedAt wins (deterministic)", () => {
    const r = recommendOffer({ priority: "HIGH", offers: [
      o({ quoteId: "later", transitDays: 3, usdTotal: 1000, submittedAt: "2026-08-11T00:00:00.000Z" }),
      o({ quoteId: "earlier", transitDays: 3, usdTotal: 1000, submittedAt: "2026-08-10T00:00:00.000Z" }),
    ]});
    expect(r?.quoteId).toBe("earlier");
  });
  it("excludes offers with no USD total (missing FX) or no transit days", () => {
    const r = recommendOffer({ priority: "MEDIUM", offers: [
      o({ quoteId: "noFx", usdTotal: null, transitDays: 2 }),
      o({ quoteId: "noTransit", usdTotal: 500, transitDays: null }),
      o({ quoteId: "ok", usdTotal: 900, transitDays: 4 }),
    ]});
    expect(r?.quoteId).toBe("ok");
  });
  it("returns null when nothing is rankable", () => {
    expect(recommendOffer({ priority: "HIGH", offers: [] })).toBeNull();
    expect(recommendOffer({ priority: "HIGH", offers: [o({ quoteId: "x", usdTotal: null })] })).toBeNull();
  });
});
