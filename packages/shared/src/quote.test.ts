import { describe, it, expect } from "vitest";
import {
  CHARGE_ZONES,
  TRUCKING_TYPES,
  TRUCKING_BASES,
  WAREHOUSE_POSITIONS,
  AIR_CHARGE_PRESETS,
  SEA_CHARGE_PRESETS,
  CHARGE_RATE_VARIANTS,
  TRUCK_TONNAGES,
  CONTAINER_SIZES,
  BILL_OF_LADING_TYPES,
  WAREHOUSE_SIDES,
  truckTonnageLabel,
  containerSizeLabel,
  rateVariantLabel,
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
  it("has the mandatory Air/Sea preset lines from spec §7.4.3.1/.2", () => {
    expect(AIR_CHARGE_PRESETS.map((p) => p.label)).toEqual([
      "Export Customs Clearance",
      "Documentation Charges",
      "Origin THC / Airport Handling",
      "Security / Screening Charges",
      "Warehouse / Pre-storage at OAP",
      "Air Freight Charges",
      "Security Exchange (SEC)",
      "Airline / Carrier Surcharge",
      "Heavy Weight Surcharge",
      "Destination THC / Airport Handling",
      "Import Customs Clearance",
      "Last Mile Handling / Lift Gate",
      "Storage 1 Free Day Charges",
    ]);
    expect(AIR_CHARGE_PRESETS.filter((p) => p.zone === "MAIN_FREIGHT")).toHaveLength(4);
    expect(SEA_CHARGE_PRESETS.filter((p) => p.zone === "MAIN_FREIGHT")).toHaveLength(1);
    expect(new Set(SEA_CHARGE_PRESETS.map((p) => p.presetKey)).size).toBe(
      SEA_CHARGE_PRESETS.length,
    ); // keys unique
  });
});

// ── v2: dual-rate / calc option-sets (Task 5) ──
describe("dual-rate / calc option-sets", () => {
  it("exposes dual-rate option-sets", () => {
    expect(CHARGE_RATE_VARIANTS).toEqual(["DEDICATED", "GROUPAGE", "FCL", "LCL"]);
    expect(TRUCK_TONNAGES).toContain("TRAILER_30_40T");
    expect(CONTAINER_SIZES).toEqual(["TWENTY", "FORTY", "FORTY_FIVE_HC"]);
    const c: QuoteDraftCargo = { packageId: "p", grossWtKg: 100, cbm: 0.9, chargedWeightKg: 120 };
    expect(c.chargedWeightKg).toBe(120);
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

  it("builds a full v2 QuoteDraft including seaRates and mode-specific transit fields (shape check)", () => {
    const draft: QuoteDraft = {
      legId: "l1",
      mode: "SEA",
      currency: "USD",
      quoteValidityUntil: null,
      cargo: [{ packageId: "p1", grossWtKg: 500, cbm: 3, chargedWeightKg: 500 }],
      charges: [
        {
          zone: "ORIGIN",
          presetKey: null,
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
        guaranteedTransitDays: 10,
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
  });
});
