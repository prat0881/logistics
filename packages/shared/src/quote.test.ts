import { describe, it, expect } from "vitest";
import {
  CHARGE_ZONES,
  TRUCKING_TYPES,
  TRUCKING_BASES,
  WAREHOUSE_POSITIONS,
  CHARGE_RATE_VARIANTS,
  TRUCK_TONNAGES,
  CONTAINER_SIZES,
  BILL_OF_LADING_TYPES,
  WAREHOUSE_SIDES,
  AIR_VARIANT_KEY,
  SEA_VARIANT_KEY,
  truckTonnageLabel,
  containerSizeLabel,
  rateVariantLabel,
  variantsForMode,
  variantsForTransit,
  type QuoteDraftCargo,
  type QuoteDraft,
} from "./quote";

describe("quote vocabulary", () => {
  it("pins the enum value sets", () => {
    expect(CHARGE_ZONES).toEqual(["ORIGIN", "MAIN_FREIGHT", "DESTINATION"]);
    expect(TRUCKING_TYPES).toEqual(["DEDICATED", "GROUPAGE"]);
    expect(TRUCKING_BASES).toEqual(["PER_TRUCK", "PER_CBM", "PER_TON", "FIXED"]);
    expect(WAREHOUSE_POSITIONS).toEqual(["ORIGIN", "DESTINATION"]);
  });
});

// ── v2: dual-rate / calc option-sets (Task 5) ──
describe("dual-rate / calc option-sets", () => {
  it("exposes dual-rate option-sets", () => {
    expect(CHARGE_RATE_VARIANTS).toEqual(["DEDICATED", "GROUPAGE", "FCL", "LCL"]);
    expect(TRUCK_TONNAGES).toContain("TRAILER_30_40T");
    expect(CONTAINER_SIZES).toEqual(["TWENTY", "FORTY", "FORTY_FIVE_HC"]);
    const c: QuoteDraftCargo = { packageId: "p", grossWtKg: 100, cbm: 0.9 };
    expect(c.grossWtKg).toBe(100);
  });

  it("pins the full TruckTonnage set (11 values), and the B/L + warehouse-side sets", () => {
    expect(TRUCK_TONNAGES).toEqual([
      "T_1",
      "T_2",
      "T_3_5",
      "T_5",
      "T_7",
      "T_9",
      "T_12",
      "T_16",
      "T_20",
      "T_25",
      "TRAILER_30_40T",
    ]);
    expect(BILL_OF_LADING_TYPES).toEqual(["ORIGINAL", "TELEX"]);
    expect(WAREHOUSE_SIDES).toEqual(["DROP", "PICKUP"]);
  });

  it("labels tonnage + container size for display", () => {
    expect(truckTonnageLabel("T_3_5")).toBe("3.5 T");
    expect(truckTonnageLabel("TRAILER_30_40T")).toBe("Trailer 30–40 T");
    expect(containerSizeLabel("TWENTY")).toBe("20'");
    expect(containerSizeLabel("FORTY_FIVE_HC")).toBe("45' HC");
  });

  it("labels rate variants for display (shared across Road/Sea UIs)", () => {
    expect(rateVariantLabel("DEDICATED")).toBe("Dedicated");
    expect(rateVariantLabel("GROUPAGE")).toBe("Groupage");
    expect(rateVariantLabel("FCL")).toBe("FCL");
    expect(rateVariantLabel("LCL")).toBe("LCL");
  });
});

// ── v3: per-variant columns (FF Portal v3, Task 1) ──
describe("variantsForMode", () => {
  it("Road → Dedicated/Groupage", () => {
    expect(variantsForMode("ROAD")).toEqual(["DEDICATED", "GROUPAGE"]);
  });
  it("Sea → FCL/LCL", () => {
    expect(variantsForMode("SEA")).toEqual(["FCL", "LCL"]);
  });
  it("Air → a single implicit column (null)", () => {
    expect(variantsForMode("AIR")).toEqual([null]);
  });
  it("an unresolved mode also degrades to a single implicit column", () => {
    expect(variantsForMode(null)).toEqual([null]);
  });
  it("AIR_VARIANT_KEY is not one of the four real rate variants", () => {
    expect(CHARGE_RATE_VARIANTS).not.toContain(AIR_VARIANT_KEY);
  });
});

// ── v4: variantsForTransit (design §3.1/D2-D3) — Road stays per-variant like variantsForMode;
// Sea COLLAPSES to one common key (unlike variantsForMode("SEA")'s two freight columns); Air is
// unchanged. Never returns `null` (unlike variantsForMode) — every result is a real map key. ──
describe("variantsForTransit", () => {
  it("Road → the two real ChargeRateVariant members, same as variantsForMode", () => {
    expect(variantsForTransit("ROAD")).toEqual(["DEDICATED", "GROUPAGE"]);
  });
  it("Sea → ONE common key (SEA_VARIANT_KEY) — narrower than variantsForMode('SEA')'s [FCL, LCL]", () => {
    expect(variantsForTransit("SEA")).toEqual([SEA_VARIANT_KEY]);
  });
  it("Air → the single AIR key", () => {
    expect(variantsForTransit("AIR")).toEqual([AIR_VARIANT_KEY]);
  });
  it("an unresolved mode also degrades to the single AIR key", () => {
    expect(variantsForTransit(null)).toEqual([AIR_VARIANT_KEY]);
  });
  it("SEA_VARIANT_KEY is not one of the four real rate variants, and differs from AIR_VARIANT_KEY", () => {
    expect(CHARGE_RATE_VARIANTS).not.toContain(SEA_VARIANT_KEY);
    expect(SEA_VARIANT_KEY).not.toBe(AIR_VARIANT_KEY);
  });
});

describe("QuoteDraft (v4 shape)", () => {
  it("builds a full v4 QuoteDraft: common charges (rateVariant null), per-variant freight, and Sea's ONE common transit-days entry (shape check)", () => {
    const draft: QuoteDraft = {
      legId: "l1",
      mode: "SEA",
      currency: "USD",
      quoteValidityUntil: null,
      chargedWeightKg: 500, // one leg-level chargeable weight, not per-package
      notes: null,
      cargo: [{ packageId: "p1", grossWtKg: 500, cbm: 3 }],
      charges: [
        {
          zone: "ORIGIN",
          presetKey: null,
          rateVariant: null, // v4: every charge is common, regardless of mode
          label: "Doc fee",
          amount: 20,
          billOfLadingType: "TELEX",
        },
      ],
      trucking: [
        {
          legEndpointPointId: "e1",
          truckingType: "DEDICATED",
          basis: "PER_TRUCK",
          amount: 100,
          rateVariant: "DEDICATED",
          tonnage: "T_9",
        },
      ],
      seaRates: [
        { rateVariant: "FCL", containerSize: "TWENTY", amount: 900, remarks: "spot rate" },
      ],
      warehouse: [
        {
          warehousePointId: "w1",
          position: "ORIGIN",
          label: "WH",
          amount: 50,
          cfsCode: "CFS1",
          side: "DROP",
        },
      ],
      transit: {
        departureDate: null,
        arrivalDate: null,
        // v4: Sea's GTT is ONE common value under SEA_VARIANT_KEY — covers both FCL and LCL, no
        // more per-variant FCL/LCL split.
        guaranteedTransitDaysByVariant: { [SEA_VARIANT_KEY]: 10 },
        shippingLine: "Maersk",
        vesselVoyage: "MV1/001",
        etd: null,
        eta: null,
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };
    expect(draft.seaRates[0].rateVariant).toBe("FCL");
    expect(draft.warehouse[0].side).toBe("DROP");
    expect(draft.trucking[0].tonnage).toBe("T_9");
    expect(draft.charges[0].rateVariant).toBeNull();
    expect(draft.transit?.guaranteedTransitDaysByVariant[SEA_VARIANT_KEY]).toBe(10);
    expect(draft.chargedWeightKg).toBe(500);
  });

  it("Air's single implicit transit-days slot is addressed via AIR_VARIANT_KEY", () => {
    const draft: QuoteDraft = {
      legId: "l1",
      mode: "AIR",
      currency: "USD",
      quoteValidityUntil: null,
      chargedWeightKg: 1000,
      notes: "Handle with care",
      cargo: [{ packageId: "p1", grossWtKg: 1000, cbm: 2 }],
      charges: [
        {
          zone: "MAIN_FREIGHT",
          presetKey: null,
          rateVariant: null, // Air's charges carry no variant — unchanged from v3
          label: "Air Freight",
          amount: 900,
        },
      ],
      trucking: [],
      seaRates: [],
      warehouse: [],
      transit: {
        departureDate: null,
        arrivalDate: null,
        guaranteedTransitDaysByVariant: { [AIR_VARIANT_KEY]: 5 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };
    expect(draft.transit?.guaranteedTransitDaysByVariant[AIR_VARIANT_KEY]).toBe(5);
    expect(draft.notes).toBe("Handle with care");
  });

  it("a Road draft's charges are common (rateVariant null) even though its freight (trucking) stays per-variant", () => {
    const draft: QuoteDraft = {
      legId: "l1",
      mode: "ROAD",
      currency: "USD",
      quoteValidityUntil: null,
      chargedWeightKg: 900,
      notes: null,
      cargo: [{ packageId: "p1", grossWtKg: 900, cbm: 4 }],
      charges: [
        {
          zone: null,
          definitionKey: "DOC",
          presetKey: null,
          rateVariant: null,
          label: "Documentation",
          amount: 150,
        },
      ],
      trucking: [
        {
          legEndpointPointId: "e1",
          truckingType: "DEDICATED",
          basis: "PER_TRUCK",
          amount: 4200,
          rateVariant: "DEDICATED",
          tonnage: "T_5",
        },
        {
          legEndpointPointId: "e1",
          truckingType: "GROUPAGE",
          basis: "PER_CBM",
          amount: 3800,
          rateVariant: "GROUPAGE",
          tonnage: null,
        },
      ],
      seaRates: [],
      warehouse: [],
      // v4: Road's GTT stays per-variant — DEDICATED and GROUPAGE keep independent entries.
      transit: {
        departureDate: null,
        arrivalDate: null,
        guaranteedTransitDaysByVariant: { DEDICATED: 3, GROUPAGE: 5 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };
    expect(draft.charges[0].rateVariant).toBeNull();
    expect(draft.trucking.map((t) => t.rateVariant)).toEqual(["DEDICATED", "GROUPAGE"]);
    expect(draft.transit?.guaranteedTransitDaysByVariant).toEqual({ DEDICATED: 3, GROUPAGE: 5 });
  });
});
