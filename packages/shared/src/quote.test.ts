import { describe, it, expect } from "vitest";
import {
  CHARGE_ZONES, TRUCKING_TYPES, TRUCKING_BASES, WAREHOUSE_POSITIONS,
  AIR_CHARGE_PRESETS, SEA_CHARGE_PRESETS,
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
      "Export Customs Clearance", "Documentation Charges", "Origin THC / Airport Handling",
      "Security / Screening Charges", "Warehouse / Pre-storage at OAP",
      "Air Freight Charges", "Security Exchange (SEC)", "Airline / Carrier Surcharge", "Heavy Weight Surcharge",
      "Destination THC / Airport Handling", "Import Customs Clearance", "Last Mile Handling / Lift Gate", "Storage 1 Free Day Charges",
    ]);
    expect(AIR_CHARGE_PRESETS.filter((p) => p.zone === "MAIN_FREIGHT")).toHaveLength(4);
    expect(SEA_CHARGE_PRESETS.filter((p) => p.zone === "MAIN_FREIGHT")).toHaveLength(1);
    expect(new Set(SEA_CHARGE_PRESETS.map((p) => p.presetKey)).size).toBe(SEA_CHARGE_PRESETS.length); // keys unique
  });
});
