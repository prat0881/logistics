import { describe, it, expect } from "vitest";
import type { FfPortalLegDto, FfPortalRfqDto } from "@svyft/shared";
import { draftFromDto } from "./draftFromDto";

const rfq = { currency: "USD", quoteValidityUntil: "2026-09-01T00:00:00.000Z" } as FfPortalRfqDto;

function airLeg(): FfPortalLegDto {
  return {
    legId: "L1", quoteId: "Q1", status: "RFQ_SENT", mode: "AIR",
    manifest: { cargo: [{ cargoItemId: "c1", grossWt: "1500", volumeCbm: "2.5", isDangerous: true }] } as never,
    endpoints: [{ pointId: "w1", type: "WAREHOUSE", name: "W", country: "IN", warehousePosition: "ORIGIN" }],
    seededCharges: [{ zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_FREIGHT", label: "Air Freight", isPreset: true, amount: null }],
    seededDensity: [{ cargoItemId: "c1", freightDensity: 167 }],
    draft: null,
  } as never;
}

describe("draftFromDto", () => {
  it("seeds cargo (kg→t), charges (amount null), density, and RFQ currency/validity", () => {
    const d = draftFromDto(airLeg(), rfq);
    expect(d.legId).toBe("L1");
    expect(d.currency).toBe("USD");
    expect(d.quoteValidityUntil).toBe("2026-09-01T00:00:00.000Z");
    expect(d.cargo[0]).toMatchObject({ cargoItemId: "c1", grossWtT: 1.5, cbm: 2.5, isDangerous: true, freightDensity: 167 });
    expect(d.charges[0]).toMatchObject({ presetKey: "AIR_MAIN_FREIGHT", amount: null });
    expect(d.warehouse[0]).toMatchObject({ warehousePointId: "w1", position: "ORIGIN" });
    expect(d.trucking).toEqual([]);
  });

  it("Road leg builds a trucking block per endpoint and no charges", () => {
    const leg = { ...airLeg(), mode: "ROAD", seededCharges: [],
      endpoints: [{ pointId: "p1", type: "PICKUP", name: "P", country: "IN", warehousePosition: null }] } as FfPortalLegDto;
    const d = draftFromDto(leg, rfq);
    expect(d.charges).toEqual([]);
    expect(d.trucking[0]).toMatchObject({ legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: null });
  });

  it("prefers an existing draft but overwrites currency/validity from the RFQ", () => {
    const leg = { ...airLeg(), draft: { legId: "L1", currency: "EUR", quoteValidityUntil: "2020-01-01T00:00:00.000Z", cargo: [], charges: [], trucking: [], warehouse: [], transit: null, dgSurchargeNote: "x", termsConditions: null, mode: "AIR" } } as FfPortalLegDto;
    const d = draftFromDto(leg, rfq);
    expect(d.currency).toBe("USD");
    expect(d.quoteValidityUntil).toBe("2026-09-01T00:00:00.000Z");
    expect(d.dgSurchargeNote).toBe("x");
  });
});
