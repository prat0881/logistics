import { describe, it, expect } from "vitest";
import {
  seedQuoteDraftPricing,
  seedQuoteDraftWarehouse,
  type SeedChargeLine,
  type SeedEndpoint,
} from "./quote-seed";

const line: SeedChargeLine = {
  zone: "ORIGIN",
  definitionKey: "X_ORIGIN_HANDLING",
  presetKey: null,
  label: "Origin handling",
};

describe("seedQuoteDraftPricing — per-variant charge matrix", () => {
  it("Road fans each line across Dedicated + Groupage, amount null", () => {
    const { charges } = seedQuoteDraftPricing([line], "ROAD", "e1");
    expect(charges).toHaveLength(2);
    expect(charges.map((c) => c.rateVariant).sort()).toEqual(["DEDICATED", "GROUPAGE"]);
    expect(charges.every((c) => c.amount === null && c.definitionKey === "X_ORIGIN_HANDLING")).toBe(
      true,
    );
  });

  it("Sea fans each line across FCL + LCL", () => {
    const { charges } = seedQuoteDraftPricing([line], "SEA", "e1");
    expect(charges.map((c) => c.rateVariant).sort()).toEqual(["FCL", "LCL"]);
  });

  it("Air keeps a single implicit column (rateVariant null)", () => {
    const { charges } = seedQuoteDraftPricing([line], "AIR", "e1");
    expect(charges).toHaveLength(1);
    expect(charges[0].rateVariant).toBeNull();
  });

  it("defaults a missing definitionKey/presetKey to null (server ResolvedChargeLine shape)", () => {
    const { charges } = seedQuoteDraftPricing([{ zone: null, label: "Ad hoc" }], "AIR", "e1");
    expect(charges[0]).toMatchObject({ definitionKey: null, presetKey: null, amount: null });
  });
});

describe("seedQuoteDraftPricing — freight-rate rows (finding #1)", () => {
  it("Road seeds both Dedicated + Groupage trucking rows off the leg's first endpoint, unpriced", () => {
    const { trucking, seaRates } = seedQuoteDraftPricing([], "ROAD", "endpoint-1");
    expect(trucking).toEqual([
      {
        legEndpointPointId: "endpoint-1",
        truckingType: "DEDICATED",
        basis: "PER_TRUCK",
        amount: null,
        rateVariant: "DEDICATED",
        tonnage: null,
      },
      {
        legEndpointPointId: "endpoint-1",
        truckingType: "GROUPAGE",
        basis: "PER_TRUCK",
        amount: null,
        rateVariant: "GROUPAGE",
        tonnage: null,
      },
    ]);
    expect(seaRates).toEqual([]);
  });

  it("Sea seeds both FCL + LCL sea-rate rows, unpriced, no container size", () => {
    const { seaRates, trucking } = seedQuoteDraftPricing([], "SEA", "e1");
    expect(seaRates).toEqual([
      { rateVariant: "FCL", containerSize: null, amount: null },
      { rateVariant: "LCL", containerSize: null, amount: null },
    ]);
    expect(trucking).toEqual([]);
  });

  it("Air seeds NEITHER trucking nor seaRates (its freight is the AIR_MAIN_FREIGHT charge line)", () => {
    const { trucking, seaRates } = seedQuoteDraftPricing([], "AIR", "e1");
    expect(trucking).toEqual([]);
    expect(seaRates).toEqual([]);
  });
});

describe("seedQuoteDraftWarehouse — shared warehouse rows (finding #1 sibling)", () => {
  const endpoints: SeedEndpoint[] = [
    { pointId: "wh-origin", warehousePosition: "ORIGIN" },
    { pointId: "delivery", warehousePosition: null }, // not a warehouse → no row
    { pointId: "wh-dest", warehousePosition: "DESTINATION" },
  ];

  it("seeds one blank row per warehouse-positioned endpoint when handling is included", () => {
    expect(seedQuoteDraftWarehouse(true, endpoints)).toEqual([
      {
        warehousePointId: "wh-origin",
        position: "ORIGIN",
        label: "Origin warehouse",
        amount: null,
        cfsCode: null,
        side: null,
      },
      {
        warehousePointId: "wh-dest",
        position: "DESTINATION",
        label: "Destination warehouse",
        amount: null,
        cfsCode: null,
        side: null,
      },
    ]);
  });

  it("seeds nothing when warehouse handling is not included", () => {
    expect(seedQuoteDraftWarehouse(false, endpoints)).toEqual([]);
  });

  it("seeds nothing when no endpoint classified to a warehouse position", () => {
    expect(
      seedQuoteDraftWarehouse(true, [{ pointId: "p", warehousePosition: null }]),
    ).toEqual([]);
  });
});
