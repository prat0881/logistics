import type { FfPortalLegDto, FfPortalRfqDto, QuoteDraft } from "@svyft/shared";
import { seedQuoteDraftPricing, seedQuoteDraftWarehouse } from "@svyft/shared";
import { toNumOrNull } from "./numeric";

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
  }));
  // v3 (design §3.1/§5): the per-variant charge matrix + the mode's freight-rate rows
  // (Road → trucking, Sea → seaRates) come from ONE shared seed — the SAME `seedQuoteDraftPricing`
  // the server's ff-portal.service.ts `seedQuoteDraft` calls, so this client fallback and the
  // server seed can never diverge again (the divergence that made every Road/Sea freight cell
  // render as a disabled "not applicable" cell — design §6 finding #1). Air seeds neither freight
  // row (its freight is the AIR_MAIN_FREIGHT charge line). Both Road rows key off the leg's first
  // endpoint (Road legs quote at the leg level, not per-endpoint).
  const { charges, trucking, seaRates } = seedQuoteDraftPricing(
    leg.seededCharges,
    leg.mode,
    leg.endpoints[0]?.pointId ?? "",
  );
  // Same shared helper the server's seedQuoteDraft calls (finding #1 sibling) — one source of
  // truth so server + client warehouse seeds can't diverge.
  const warehouse = seedQuoteDraftWarehouse(leg.warehouseIncluded === true, leg.endpoints);
  return {
    legId: leg.legId,
    mode: leg.mode,
    currency: rfq.currency,
    quoteValidityUntil: rfq.quoteValidityUntil,
    // v3: one leg-level chargeable weight + FF notes (design §3.1/D2, D5) — a fresh draft (no
    // leg.draft yet) starts both unset; an existing draft's values pass through the `leg.draft`
    // branch above via the spread instead of this literal.
    chargedWeightKg: null,
    notes: null,
    cargo,
    charges,
    trucking,
    seaRates,
    warehouse,
    transit: { departureDate: null, arrivalDate: null, guaranteedTransitDaysByVariant: {} },
    dgSurchargeNote: null,
    termsConditions: null,
  };
}
