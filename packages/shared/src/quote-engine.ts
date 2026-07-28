import { AIR_CHARGE_PRESETS, SEA_CHARGE_PRESETS, type QuoteDraft } from "./quote";
import type { Finding } from "./findings";

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

export function validateQuote(draft: QuoteDraft, deadlineIso: string, nowIso: string): Finding[] {
  const f: Finding[] = [];
  const blk = (rule: string, message: string, scope: Finding["scope"]): Finding => ({ rule, severity: "blocking", scope, message });
  const leg = { type: "leg", id: draft.legId } as const;

  // Q7 — submission not past the deadline
  if (new Date(nowIso).getTime() > new Date(deadlineIso).getTime())
    f.push(blk("Q7", "The submission deadline has passed", leg));

  // Q1 — mandatory charge lines per mode
  if (draft.mode === "AIR" || draft.mode === "SEA") {
    const presets = draft.mode === "AIR" ? AIR_CHARGE_PRESETS : SEA_CHARGE_PRESETS;
    const priced = new Set(draft.charges.filter((c) => c.amount != null).map((c) => c.presetKey));
    for (const p of presets)
      if (!priced.has(p.presetKey)) f.push(blk("Q1", `Charge line "${p.label}" must be priced`, leg));
  } else if (draft.mode === "ROAD") {
    for (const t of draft.trucking)
      if (t.amount == null) f.push(blk("Q1", "A trucking charge is required for every pickup/drop block", leg));
  }

  // Q8 — warehousing in/out priced for every warehouse endpoint
  for (const w of draft.warehouse)
    if (w.amount == null) f.push(blk("Q8", `Warehousing (In/Out) must be priced for ${w.label}`, leg));

  // Q2 — density on every cargo row
  for (const c of draft.cargo)
    if (c.freightDensity == null) f.push(blk("Q2", "Freight density is required for every cargo row", { type: "cargo", id: c.cargoItemId }));

  // Q3 — validity present + ≥ deadline
  if (!draft.quoteValidityUntil) f.push(blk("Q3", "Quote Validity Until is required", { type: "field", id: "quoteValidityUntil" }));
  else if (new Date(draft.quoteValidityUntil).getTime() < new Date(deadlineIso).getTime())
    f.push(blk("Q3", "Quote Validity Until must be on or after the submission deadline", { type: "field", id: "quoteValidityUntil" }));

  // Q4 — currency
  if (!draft.currency) f.push(blk("Q4", "Currency is required", { type: "field", id: "currency" }));

  // Q5 — DG surcharge note when any assigned row is DG
  if (draft.cargo.some((c) => c.isDangerous) && !draft.dgSurchargeNote?.trim())
    f.push(blk("Q5", "A DG Surcharge Note is required when the shipment includes dangerous goods", { type: "field", id: "dgSurchargeNote" }));

  // Q6 — transit departure + arrival
  if (!draft.transit?.departureDate) f.push(blk("Q6", "Transit Plan departure date is required", { type: "field", id: "departureDate" }));
  if (!draft.transit?.arrivalDate) f.push(blk("Q6", "Transit Plan arrival date is required", { type: "field", id: "arrivalDate" }));

  return f;
}
