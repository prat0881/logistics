import { ImpactClass, type CargoUpdateInput } from "@svyft/shared";

// Cargo field → impact class (§11.1). Weight/dims/DG = RfqDefining (FFs quote against
// them); labels/refs/docs = Corrective; add/remove a row = Structural. volumeCbm is
// generated and freightDensity/chargeableWeight are Stage-4 → never edited here.
// Typed as Record<keyof CargoUpdateInput | ..., ImpactClass> (rather than the looser
// EntityImpactMap) so the compiler REQUIRES an entry for EVERY cargoUpdateSchema field —
// mirrors queryImpactMap (see query.impact.ts). Still structurally assignable to
// ImpactRegistry.declare's EntityImpactMap (= Record<string, ImpactClass>) param.
export const cargoImpactMap: Record<
  keyof CargoUpdateInput | "msdsFileId" | "@create" | "@delete",
  ImpactClass
> = {
  poReference: ImpactClass.Corrective,
  productName: ImpactClass.Corrective,
  referenceTags: ImpactClass.Corrective,
  hsCode: ImpactClass.Corrective,
  msdsFileId: ImpactClass.Corrective,
  packageType: ImpactClass.RfqDefining,
  isDangerous: ImpactClass.RfqDefining,
  qty: ImpactClass.RfqDefining,
  dimL: ImpactClass.RfqDefining,
  dimW: ImpactClass.RfqDefining,
  dimH: ImpactClass.RfqDefining,
  netWt: ImpactClass.RfqDefining,
  grossWt: ImpactClass.RfqDefining,
  "@create": ImpactClass.Structural,
  "@delete": ImpactClass.Structural,
};
