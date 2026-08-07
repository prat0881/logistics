import type {
  FfPortalLegDto,
  FfPortalRfqDto,
  QuoteDraft,
  QuoteDraftWarehouse,
} from "@svyft/shared";
import { toNumOrNull } from "./numeric";

function warehouseLabel(position: QuoteDraftWarehouse["position"]): string {
  return position === "ORIGIN" ? "Origin warehouse" : "Destination warehouse";
}

export function draftFromDto(leg: FfPortalLegDto, rfq: FfPortalRfqDto): QuoteDraft {
  if (leg.draft) {
    return {
      ...leg.draft,
      legId: leg.legId,
      mode: leg.mode,
      currency: rfq.currency,
      quoteValidityUntil: rfq.quoteValidityUntil,
    };
  }
  const cargo = leg.manifest.cargo.map((c) => ({
    packageId: c.packageId,
    grossWtKg: toNumOrNull(c.grossWt) ?? 0,
    cbm: toNumOrNull(c.volumeCbm) ?? 0,
    chargedWeightKg: null,
  }));
  const charges = leg.seededCharges.map((s) => ({
    zone: s.zone,
    definitionKey: s.definitionKey,
    presetKey: s.presetKey,
    label: s.label,
    amount: null,
  }));
  const warehouse = (
    leg.warehouseIncluded ? leg.endpoints.filter((e) => e.warehousePosition != null) : []
  ).map((e) => ({
    warehousePointId: e.pointId,
    position: e.warehousePosition!,
    label: warehouseLabel(e.warehousePosition!),
    amount: null,
    cfsCode: null,
    side: null,
  }));
  // Road is dual-rate (design §7): seed both variants up front so the FF can price either or
  // both — an unpriced row stays amount: null (blank rate → "–", computeQuoteTotals). Both rows
  // key off the same leg endpoint (Road legs quote at the leg level, not per-endpoint).
  const trucking =
    leg.mode === "ROAD"
      ? (["DEDICATED", "GROUPAGE"] as const).map((rv) => ({
          legEndpointPointId: leg.endpoints[0]?.pointId ?? "",
          truckingType: rv,
          basis: "PER_TRUCK" as const,
          amount: null,
          rateVariant: rv,
          tonnage: null,
        }))
      : [];
  // Sea is dual-rate too (design §7): seed both FCL/LCL rows up front, same pattern as Road's
  // Dedicated/Groupage — an unpriced row stays amount: null (blank rate → "–", computeQuoteTotals).
  const seaRates =
    leg.mode === "SEA"
      ? (["FCL", "LCL"] as const).map((rv) => ({
          rateVariant: rv,
          containerSize: null,
          amount: null,
        }))
      : [];
  return {
    legId: leg.legId,
    mode: leg.mode,
    currency: rfq.currency,
    quoteValidityUntil: rfq.quoteValidityUntil,
    cargo,
    charges,
    trucking,
    seaRates,
    warehouse,
    transit: { departureDate: null, arrivalDate: null, guaranteedTransitDays: null },
    dgSurchargeNote: null,
    termsConditions: null,
  };
}
