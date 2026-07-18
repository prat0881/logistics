import { ImpactClass } from "@svyft/shared";
import type { EntityImpactMap } from "../changes/impact.registry";

// Cargo field → impact class (§11.1). Weight/dims/DG = RfqDefining (FFs quote against
// them); labels/refs/docs = Corrective; add/remove a row = Structural. volumeCbm is
// generated and freightDensity/chargeableWeight are Stage-4 → never edited here.
export const cargoImpactMap: EntityImpactMap = {
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
