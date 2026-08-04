import type { FfPortalLegDto, FfPortalRfqDto, QuoteDraft, QuoteDraftWarehouse } from "@svyft/shared";
import { toNumOrNull } from "./numeric";

function warehouseLabel(position: QuoteDraftWarehouse["position"]): string {
  return position === "ORIGIN" ? "Origin warehouse" : "Destination warehouse";
}

export function draftFromDto(leg: FfPortalLegDto, rfq: FfPortalRfqDto): QuoteDraft {
  if (leg.draft) {
    return { ...leg.draft, legId: leg.legId, mode: leg.mode, currency: rfq.currency, quoteValidityUntil: rfq.quoteValidityUntil };
  }
  const cargo = leg.manifest.cargo.map((c) => {
    const seed = leg.seededDensity.find((s) => s.cargoItemId === c.cargoItemId);
    return {
      cargoItemId: c.cargoItemId,
      grossWtT: (toNumOrNull(c.grossWt) ?? 0) / 1000,
      cbm: toNumOrNull(c.volumeCbm) ?? 0,
      isDangerous: c.isDangerous,
      freightDensity: seed?.freightDensity ?? null,
    };
  });
  const charges = leg.seededCharges.map((s) => ({
    zone: s.zone, definitionKey: s.definitionKey, presetKey: s.presetKey, label: s.label, amount: null,
  }));
  const trucking =
    leg.mode === "ROAD"
      ? leg.endpoints.map((e) => ({ legEndpointPointId: e.pointId, truckingType: "DEDICATED" as const, basis: "PER_TRUCK" as const, amount: null }))
      : [];
  const warehouse = (leg.warehouseIncluded ? leg.endpoints.filter((e) => e.warehousePosition != null) : [])
    .map((e) => ({ warehousePointId: e.pointId, position: e.warehousePosition!, label: warehouseLabel(e.warehousePosition!), amount: null }));
  return {
    legId: leg.legId,
    mode: leg.mode,
    currency: rfq.currency,
    quoteValidityUntil: rfq.quoteValidityUntil,
    cargo,
    charges,
    trucking,
    warehouse,
    transit: { departureDate: null, arrivalDate: null },
    dgSurchargeNote: null,
    termsConditions: null,
  };
}
