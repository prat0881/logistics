import { ImpactClass, type CargoUpdateInput } from "@svyft/shared";

// Cargo field -> impact class (§11.1). A cargo grouping now holds only PO/label/unit metadata —
// no dims/weight/DG of its own (Package carries those, RfqDefining) — so every header field is
// Corrective: cosmetic/grouping edits an FF never re-quotes against. Adding/removing a grouping
// row is Structural.
// Typed as Record<keyof CargoUpdateInput | ..., ImpactClass> (rather than the looser
// EntityImpactMap) so the compiler REQUIRES an entry for EVERY cargoUpdateSchema field — mirrors
// queryImpactMap (see query.impact.ts).
export const cargoImpactMap: Record<keyof CargoUpdateInput | "@create" | "@delete", ImpactClass> = {
  poReference: ImpactClass.Corrective,
  label: ImpactClass.Corrective,
  dimUnit: ImpactClass.Corrective,
  weightUnit: ImpactClass.Corrective,
  "@create": ImpactClass.Structural,
  "@delete": ImpactClass.Structural,
};
