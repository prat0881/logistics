/** Chargeable weight (tonnes) = max(actual gross T, volumetric T). Volumetric = cbm(m³) × density(kg/CBM) / 1000. */
export function computeChargeableWeight(grossWtT: number, cbm: number, densityKgPerCbm: number): number {
  const volumetricT = (cbm * densityKgPerCbm) / 1000;
  return Math.max(grossWtT, volumetricT);
}
