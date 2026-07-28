import type { QuoteDraft } from "./quote";

/** Chargeable weight (tonnes) = max(actual gross T, volumetric T). Volumetric = cbm(m³) × density(kg/CBM) / 1000. */
export function computeChargeableWeight(grossWtT: number, cbm: number, densityKgPerCbm: number): number {
  const volumetricT = (cbm * densityKgPerCbm) / 1000;
  return Math.max(grossWtT, volumetricT);
}

export interface QuoteTotals {
  zoneSubtotals: { origin: number; mainFreight: number; destination: number };
  truckingSubtotal: number;
  warehouseSubtotal: number;
  totalChargeableWeightT: number;
  grandTotal: number;
}

export function computeQuoteTotals(draft: QuoteDraft): QuoteTotals {
  const zoneSubtotals = { origin: 0, mainFreight: 0, destination: 0 };
  for (const c of draft.charges) {
    const amt = c.amount ?? 0;
    if (c.zone === "ORIGIN") zoneSubtotals.origin += amt;
    else if (c.zone === "MAIN_FREIGHT") zoneSubtotals.mainFreight += amt;
    else zoneSubtotals.destination += amt;
  }
  const truckingSubtotal = draft.trucking.reduce((s, t) => s + (t.amount ?? 0), 0);
  const warehouseSubtotal = draft.warehouse.reduce((s, w) => s + (w.amount ?? 0), 0);
  const totalChargeableWeightT = draft.cargo.reduce(
    (s, c) => s + (c.freightDensity != null ? computeChargeableWeight(c.grossWtT, c.cbm, c.freightDensity) : 0),
    0,
  );
  const grandTotal =
    zoneSubtotals.origin + zoneSubtotals.mainFreight + zoneSubtotals.destination + truckingSubtotal + warehouseSubtotal;
  return { zoneSubtotals, truckingSubtotal, warehouseSubtotal, totalChargeableWeightT, grandTotal };
}
