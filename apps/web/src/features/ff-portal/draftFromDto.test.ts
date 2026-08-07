import { describe, it, expect } from "vitest";
import type {
  FfPortalLegDto,
  FfPortalRfqDto,
  ManifestSnapshotCargo,
  QuoteDraft,
} from "@svyft/shared";
import { draftFromDto } from "./draftFromDto";

const rfq: FfPortalRfqDto = {
  rfqNumber: "R-1",
  incoterms: "FOB",
  submissionDeadline: "2999-01-01T00:00:00.000Z",
  currency: "USD",
  quoteValidityUntil: "2026-09-01T00:00:00.000Z",
  freightForwarder: { companyName: "Acme" },
  legs: [],
};

const pkg1: ManifestSnapshotCargo = {
  packageId: "pk1",
  packageNo: "PK-1",
  packageType: "CRATE",
  packageCount: 1,
  dimL: "100",
  dimW: "100",
  dimH: "100",
  netWt: "1400",
  grossWt: "1500",
  volumeCbm: "2.5",
  tags: ["DG"],
};

function airLeg(): FfPortalLegDto {
  return {
    legId: "L1",
    quoteId: "Q1",
    status: "RFQ_SENT",
    mode: "AIR",
    manifest: {
      legId: "L1",
      legCode: "L1",
      legName: null,
      mode: "AIR",
      incoterms: null,
      origin: null,
      destination: null,
      readyDate: null,
      targetDelivery: null,
      cargo: [pkg1],
      frozenAt: "2026-08-01T00:00:00.000Z",
    },
    endpoints: [
      { pointId: "w1", type: "WAREHOUSE", name: "W", country: "IN", warehousePosition: "ORIGIN" },
    ],
    seededCharges: [
      {
        zone: "MAIN_FREIGHT",
        definitionKey: "AIR_MAIN_FREIGHT",
        presetKey: "AIR_MAIN_FREIGHT",
        label: "Air Freight",
        isPreset: true,
        amount: null,
      },
    ],
    warehouseIncluded: true,
    draft: null,
  };
}

describe("draftFromDto", () => {
  it("seeds per-package cargo (kg passthrough, no per-package chargedWeightKg), charges, warehouse, and RFQ currency/validity", () => {
    const d = draftFromDto(airLeg(), rfq);
    expect(d.legId).toBe("L1");
    expect(d.mode).toBe("AIR");
    expect(d.currency).toBe("USD");
    expect(d.quoteValidityUntil).toBe("2026-09-01T00:00:00.000Z");
    expect(d.cargo).toEqual([{ packageId: "pk1", grossWtKg: 1500, cbm: 2.5 }]);
    // Air has a single implicit rate-variant column (variantsForMode("AIR") === [null]) — one
    // seeded line still fans out to exactly one charges entry, now carrying rateVariant: null.
    expect(d.charges).toHaveLength(1);
    expect(d.charges[0]).toMatchObject({
      definitionKey: "AIR_MAIN_FREIGHT",
      presetKey: "AIR_MAIN_FREIGHT",
      amount: null,
      rateVariant: null,
    });
    expect(d.warehouse[0]).toMatchObject({
      warehousePointId: "w1",
      position: "ORIGIN",
      label: "Origin warehouse",
      amount: null,
      cfsCode: null,
      side: null,
    });
  });

  it("seeds the leg-level chargedWeightKg/notes as null (v3: no more per-package charged weight)", () => {
    const d = draftFromDto(airLeg(), rfq);
    expect(d.chargedWeightKg).toBeNull();
    expect(d.notes).toBeNull();
    expect(d.cargo.every((c) => !("chargedWeightKg" in c))).toBe(true);
  });

  it("seeds two Road rate rows (Dedicated + Groupage) off the leg's first endpoint, both unpriced", () => {
    const road = { ...airLeg(), mode: "ROAD" as const, seededCharges: [] };
    const d = draftFromDto(road, rfq);
    expect(d.trucking).toEqual([
      {
        legEndpointPointId: "w1",
        truckingType: "DEDICATED",
        basis: "PER_TRUCK",
        amount: null,
        rateVariant: "DEDICATED",
        tonnage: null,
      },
      {
        legEndpointPointId: "w1",
        truckingType: "GROUPAGE",
        basis: "PER_TRUCK",
        amount: null,
        rateVariant: "GROUPAGE",
        tonnage: null,
      },
    ]);
    expect(d.seaRates).toEqual([]);
    expect(d.charges).toEqual([]);
  });

  it("falls back to an empty legEndpointPointId when a Road leg has no endpoints", () => {
    const road = { ...airLeg(), mode: "ROAD" as const, endpoints: [] };
    const d = draftFromDto(road, rfq);
    expect(d.trucking.map((t) => t.legEndpointPointId)).toEqual(["", ""]);
  });

  it("seeds two Sea rate rows (FCL + LCL), both unpriced with no container size", () => {
    const sea = { ...airLeg(), mode: "SEA" as const, seededCharges: [] };
    const d = draftFromDto(sea, rfq);
    expect(d.seaRates).toEqual([
      { rateVariant: "FCL", containerSize: null, amount: null },
      { rateVariant: "LCL", containerSize: null, amount: null },
    ]);
    expect(d.trucking).toEqual([]);
  });

  it("leaves trucking and seaRates empty for non-Road modes (filled by later tasks)", () => {
    const d = draftFromDto(airLeg(), rfq); // AIR
    expect(d.trucking).toEqual([]);
    expect(d.seaRates).toEqual([]);
  });

  it("seeds a mandatory-but-unset transit plan (guaranteedTransitDaysByVariant empty)", () => {
    const d = draftFromDto(airLeg(), rfq);
    expect(d.transit).toEqual({
      departureDate: null,
      arrivalDate: null,
      guaranteedTransitDaysByVariant: {},
    });
  });

  it("carries seeded plain configured lines (zone: null, definitionKey) into charges", () => {
    const leg = {
      ...airLeg(),
      mode: "ROAD" as const,
      seededCharges: [
        {
          zone: null,
          definitionKey: "ROAD_FUEL_SURCHARGE",
          presetKey: null,
          label: "Fuel Surcharge",
          isPreset: true as const,
          amount: null,
        },
      ],
    };
    const d = draftFromDto(leg, rfq);
    expect(d.charges[0]).toMatchObject({
      zone: null,
      definitionKey: "ROAD_FUEL_SURCHARGE",
      label: "Fuel Surcharge",
      amount: null,
    });
  });

  it("fans each seeded line out across every rate-variant column for the mode (v3 matrix seed, design §3.1)", () => {
    const seededCharges = [
      {
        zone: null,
        definitionKey: "ROAD_FUEL_SURCHARGE",
        presetKey: null,
        label: "Fuel Surcharge",
        isPreset: true as const,
        amount: null,
      },
    ];

    // Road: 2 columns (Dedicated/Groupage) -> one seeded line fans out to 2 charges entries.
    const road = { ...airLeg(), mode: "ROAD" as const, seededCharges };
    const dRoad = draftFromDto(road, rfq);
    expect(dRoad.charges).toHaveLength(2);
    expect(dRoad.charges.map((c) => c.rateVariant).sort()).toEqual(["DEDICATED", "GROUPAGE"]);
    for (const c of dRoad.charges) {
      expect(c).toMatchObject({
        zone: null,
        definitionKey: "ROAD_FUEL_SURCHARGE",
        label: "Fuel Surcharge",
        amount: null,
      });
    }

    // Sea: 2 columns (FCL/LCL) -> same fan-out shape as Road, different variant values.
    const sea = { ...airLeg(), mode: "SEA" as const, seededCharges };
    const dSea = draftFromDto(sea, rfq);
    expect(dSea.charges).toHaveLength(2);
    expect(dSea.charges.map((c) => c.rateVariant).sort()).toEqual(["FCL", "LCL"]);

    // Air: single implicit column -> one seeded line stays one charges entry, rateVariant: null.
    const air = { ...airLeg(), seededCharges };
    const dAir = draftFromDto(air, rfq);
    expect(dAir.charges).toHaveLength(1);
    expect(dAir.charges[0].rateVariant).toBeNull();
  });

  it("gates warehouse rows on warehouseIncluded (falsy/undefined → none)", () => {
    const withFalse = draftFromDto({ ...airLeg(), warehouseIncluded: false }, rfq);
    const withUndefined = draftFromDto({ ...airLeg(), warehouseIncluded: undefined }, rfq);
    expect(withFalse.warehouse).toEqual([]);
    expect(withUndefined.warehouse).toEqual([]);
  });

  it("prefers an existing draft but overwrites legId/mode/currency/validity from the leg/RFQ", () => {
    const staleDraft: QuoteDraft = {
      legId: "STALE",
      mode: "SEA",
      currency: "EUR",
      quoteValidityUntil: "2020-01-01T00:00:00.000Z",
      chargedWeightKg: 850,
      notes: "handle with care",
      cargo: [],
      charges: [],
      trucking: [],
      seaRates: [],
      warehouse: [],
      transit: { departureDate: null, arrivalDate: null, guaranteedTransitDaysByVariant: {} },
      dgSurchargeNote: "x",
      termsConditions: null,
    };
    const leg = { ...airLeg(), draft: staleDraft };
    const d = draftFromDto(leg, rfq);
    expect(d.legId).toBe("L1");
    expect(d.mode).toBe("AIR");
    expect(d.currency).toBe("USD");
    expect(d.quoteValidityUntil).toBe("2026-09-01T00:00:00.000Z");
    expect(d.dgSurchargeNote).toBe("x");
    // leg-level chargedWeightKg/notes are the FF's own entered values — an existing draft's
    // values pass straight through unchanged; only the RFQ/leg-sourced fields above get overwritten.
    expect(d.chargedWeightKg).toBe(850);
    expect(d.notes).toBe("handle with care");
  });
});
