import { describe, it, expect } from "vitest";
import { quoteDraftSchema } from "./ff-portal";
import type { QuoteDraft } from "./quote";

const valid: QuoteDraft = {
  legId: "l1",
  mode: "AIR",
  currency: "USD",
  quoteValidityUntil: "2026-08-20T00:00:00.000Z",
  chargedWeightKg: 1000,
  notes: null,
  cargo: [{ packageId: "c1", grossWtKg: 1000, cbm: 2 }],
  charges: [
    {
      zone: "ORIGIN",
      presetKey: "AIR_ORIGIN_THC",
      rateVariant: null,
      label: "Origin THC",
      amount: 100,
      note: "x",
    },
  ],
  trucking: [],
  seaRates: [],
  warehouse: [],
  transit: {
    departureDate: "2026-08-12T00:00:00.000Z",
    arrivalDate: "2026-08-14T00:00:00.000Z",
    guaranteedTransitDaysByVariant: { DEDICATED: 5 },
  },
  dgSurchargeNote: null,
  termsConditions: null,
};

describe("quoteDraftSchema", () => {
  it("accepts a well-formed QuoteDraft (nullable amounts allowed)", () => {
    expect(quoteDraftSchema.safeParse(valid).success).toBe(true);
    const partial = {
      ...valid,
      charges: [{ zone: "ORIGIN", presetKey: null, rateVariant: null, label: "x", amount: null }],
    };
    expect(quoteDraftSchema.safeParse(partial).success).toBe(true); // draft allows blank amount
  });
  it("accepts an empty guaranteedTransitDaysByVariant (no variant priced yet)", () => {
    const empty = { ...valid, transit: { ...valid.transit, guaranteedTransitDaysByVariant: {} } };
    expect(quoteDraftSchema.safeParse(empty).success).toBe(true);
  });
  it("rejects a malformed body (bad zone / wrong type)", () => {
    expect(
      quoteDraftSchema.safeParse({
        ...valid,
        charges: [{ zone: "NOPE", label: "x", amount: 1, presetKey: null, rateVariant: null }],
      }).success,
    ).toBe(false);
    expect(quoteDraftSchema.safeParse({ ...valid, legId: 123 }).success).toBe(false);
  });
  it("rejects a bad rateVariant key on the transit-days map", () => {
    expect(
      quoteDraftSchema.safeParse({
        ...valid,
        transit: { ...valid.transit, guaranteedTransitDaysByVariant: { NOPE: 5 } },
      }).success,
    ).toBe(false);
  });
});
