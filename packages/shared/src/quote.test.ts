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
  truckTonnageLabel,
  containerSizeLabel,
  rateVariantLabel,
  variantsForMode,
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

describe("QuoteDraft (v3 shape)", () => {
  it("builds a full v3 QuoteDraft including seaRates, per-variant charges, and per-variant transit-days (shape check)", () => {
    const draft: QuoteDraft = {
      legId: "l1",
      mode: "SEA",
      currency: "USD",
      quoteValidityUntil: null,
      chargedWeightKg: 500, // v3: one leg-level chargeable weight, not per-package
      notes: null,
      cargo: [{ packageId: "p1", grossWtKg: 500, cbm: 3 }],
      charges: [
        {
          zone: "ORIGIN",
          presetKey: null,
          rateVariant: "FCL", // v3: each charge cell belongs to a column
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
        guaranteedTransitDaysByVariant: { FCL: 10, LCL: 14 }, // v3: per variant, not one shared value
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
    expect(draft.charges[0].rateVariant).toBe("FCL");
    expect(draft.transit?.guaranteedTransitDaysByVariant.LCL).toBe(14);
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
          rateVariant: null, // v3: Air's charges carry no variant
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
});
