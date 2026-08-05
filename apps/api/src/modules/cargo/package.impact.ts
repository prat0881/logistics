import { ImpactClass, type PackageUpdateInput } from "@svyft/shared";

// Package field -> impact class (§11.1). Dims/type/weights are exactly what an FF quotes
// against (RfqDefining) — the whole point of the Cargo->Package re-model was to move these off
// the Cargo header and onto Package. packageNo/tags/msdsFileId are reference/cosmetic metadata
// an FF never re-quotes over (Corrective). Adding/removing a package row is Structural.
// Typed as Record<Exclude<keyof PackageUpdateInput, "reason"> | ..., ImpactClass> (rather than
// the looser EntityImpactMap) so the compiler REQUIRES an entry for EVERY real
// packageUpdateSchema field — mirrors cargoImpactMap/legImpactMap/queryImpactMap.
// `reason` is excluded — it's ChangeRequest metadata (SB6 §7.2), never the classified field;
// PackageService strips it from `fields` before highestImpactField ever sees it. `msdsFileId`
// is added back in (it's not part of packageUpdateSchema — set only via the dedicated
// attachMsds flow — but still needs a declared class for that mediator call).
export const packageImpactMap: Record<
  Exclude<keyof PackageUpdateInput, "reason"> | "msdsFileId" | "@create" | "@delete",
  ImpactClass
> = {
  packageNo: ImpactClass.Corrective,
  packageType: ImpactClass.RfqDefining,
  dimL: ImpactClass.RfqDefining,
  dimW: ImpactClass.RfqDefining,
  dimH: ImpactClass.RfqDefining,
  grossWt: ImpactClass.RfqDefining,
  netWt: ImpactClass.RfqDefining,
  tags: ImpactClass.Corrective,
  msdsFileId: ImpactClass.Corrective,
  "@create": ImpactClass.Structural,
  "@delete": ImpactClass.Structural,
};
