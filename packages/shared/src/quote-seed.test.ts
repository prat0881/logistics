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

// v4 (partially reverses v3): charges are COMMON — ONE row per line, `rateVariant: null`,
// regardless of mode. The old per-mode fan-out (Road/Sea → 2 rows, Air → 1) is gone; every mode
// now seeds exactly one row per line.
describe("seedQuoteDraftPricing — common charges (v4: one row per line, regardless of mode)", () => {
  it("Road seeds ONE common row per line (rateVariant null) — no longer fanned across Dedicated/Groupage", () => {
    const { charges } = seedQuoteDraftPricing([line], "ROAD", "e1");
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      definitionKey: "X_ORIGIN_HANDLING",
      amount: null,
      rateVariant: null,
    });
  });

  it("Sea seeds ONE common row per line (rateVariant null) — no longer fanned across FCL/LCL", () => {
    const { charges } = seedQuoteDraftPricing([line], "SEA", "e1");
    expect(charges).toHaveLength(1);
    expect(charges[0].rateVariant).toBeNull();
  });

  it("Air seeds ONE common row per line — unchanged from v3 (Air was already a single implicit column)", () => {
    const { charges } = seedQuoteDraftPricing([line], "AIR", "e1");
    expect(charges).toHaveLength(1);
    expect(charges[0].rateVariant).toBeNull();
  });

  it("an unresolved mode also seeds one common row per line", () => {
    const { charges } = seedQuoteDraftPricing([line], null, "e1");
    expect(charges).toHaveLength(1);
    expect(charges[0].rateVariant).toBeNull();
  });

  it("seeds exactly one row per line, however many lines are given — never fanned out", () => {
    const line2: SeedChargeLine = {
      zone: "DESTINATION",
      definitionKey: "Y_DEST_HANDLING",
      presetKey: null,
      label: "Destination handling",
    };
    const { charges } = seedQuoteDraftPricing([line, line2], "ROAD", "e1");
    expect(charges).toHaveLength(2);
    expect(charges.map((c) => c.definitionKey)).toEqual(["X_ORIGIN_HANDLING", "Y_DEST_HANDLING"]);
    expect(charges.every((c) => c.rateVariant === null && c.amount === null)).toBe(true);
  });

  it("defaults a missing definitionKey/presetKey to null (server ResolvedChargeLine shape)", () => {
    const { charges } = seedQuoteDraftPricing([{ zone: null, label: "Ad hoc" }], "AIR", "e1");
    expect(charges[0]).toMatchObject({
      definitionKey: null,
      presetKey: null,
      amount: null,
      rateVariant: null,
    });
  });
});

describe("seedQuoteDraftPricing — freight-rate rows (finding #1; v4: unchanged, still per-variant)", () => {
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
    expect(seedQuoteDraftWarehouse(true, [{ pointId: "p", warehousePosition: null }])).toEqual([]);
  });
});
