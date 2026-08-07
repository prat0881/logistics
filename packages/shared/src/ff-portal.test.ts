import { describe, it, expect } from "vitest";
import { quoteDraftSchema } from "./ff-portal";
import { AIR_VARIANT_KEY, type QuoteDraft } from "./quote";

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
    // mode is AIR — must use Air's own implicit key (quote-engine.ts's transitDaysFor reads/writes
    // this exact key for Air; a v2-review bug briefly had this paired with "DEDICATED" instead,
    // which passed only because DEDICATED was ALSO a valid (if wrong) key under the old schema).
    guaranteedTransitDaysByVariant: { [AIR_VARIANT_KEY]: 5 },
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

  // Regression test for the Critical finding (review round 1): the schema's transit-days key
  // enum previously only accepted the 4 real ChargeRateVariant values, so a real Air-mode PATCH
  // (whose engine-correct key is the literal "AIR", per quote.ts's AIR_VARIANT_KEY) would 400 —
  // and Q_TRANSIT (quote-engine.ts) would then permanently block Air submission, since the draft
  // could never be saved with an Air transit-days value in the first place.
  it("accepts an AIR-mode draft with its transit-days keyed by AIR_VARIANT_KEY", () => {
    const air = {
      ...valid,
      mode: "AIR" as const,
      transit: { ...valid.transit, guaranteedTransitDaysByVariant: { [AIR_VARIANT_KEY]: 5 } },
    };
    expect(quoteDraftSchema.safeParse(air).success).toBe(true);
  });

  it("still accepts the 4 real Road/Sea rate-variant keys (DEDICATED/GROUPAGE/FCL/LCL) — widening for Air didn't regress the normal case", () => {
    const road = {
      ...valid,
      mode: "ROAD" as const,
      transit: {
        ...valid.transit,
        guaranteedTransitDaysByVariant: { DEDICATED: 3, GROUPAGE: 4 },
      },
    };
    expect(quoteDraftSchema.safeParse(road).success).toBe(true);
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
