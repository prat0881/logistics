import { describe, it, expect } from "vitest";
import { quoteDraftSchema } from "./ff-portal";
import type { QuoteDraft } from "./quote";

const valid: QuoteDraft = {
  legId: "l1", mode: "AIR", currency: "USD", quoteValidityUntil: "2026-08-20T00:00:00.000Z",
  cargo: [{ cargoItemId: "c1", grossWtT: 1, cbm: 2, isDangerous: false, freightDensity: 167 }],
  charges: [{ zone: "ORIGIN", presetKey: "AIR_ORIGIN_THC", label: "Origin THC", amount: 100, note: "x" }],
  trucking: [], warehouse: [],
  transit: { departureDate: "2026-08-12T00:00:00.000Z", arrivalDate: "2026-08-14T00:00:00.000Z" },
  dgSurchargeNote: null, termsConditions: null,
};

describe("quoteDraftSchema", () => {
  it("accepts a well-formed QuoteDraft (nullable amounts allowed)", () => {
    expect(quoteDraftSchema.safeParse(valid).success).toBe(true);
    const partial = { ...valid, charges: [{ zone: "ORIGIN", presetKey: null, label: "x", amount: null }] };
    expect(quoteDraftSchema.safeParse(partial).success).toBe(true); // draft allows blank amount
  });
  it("rejects a malformed body (bad zone / wrong type)", () => {
    expect(quoteDraftSchema.safeParse({ ...valid, charges: [{ zone: "NOPE", label: "x", amount: 1, presetKey: null }] }).success).toBe(false);
    expect(quoteDraftSchema.safeParse({ ...valid, legId: 123 }).success).toBe(false);
  });
});
