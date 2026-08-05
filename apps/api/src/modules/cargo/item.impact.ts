import { ImpactClass, type ItemUpdateInput } from "@svyft/shared";

// Item field -> impact class (§11.1). Every Item field, plus its structural actions, is
// Corrective — unlike Package (whose dims/weights are RfqDefining, exactly what an FF quotes
// against), no Item field or @create/@delete ever gates to the change-order path: items never
// re-open an RFQ. Typed as Record<keyof ItemUpdateInput | "@create" | "@delete", ImpactClass>
// (not the looser EntityImpactMap) so the compiler REQUIRES an entry for EVERY real
// itemUpdateSchema field — mirrors packageImpactMap/cargoImpactMap/legImpactMap.
// ItemUpdateInput has no `reason` field to exclude — unlike PackageUpdateInput, items carry no
// ChangeRequest-reason metadata, so ItemService has nothing to strip out of `fields` before
// highestImpactField sees them.
export const itemImpactMap: Record<keyof ItemUpdateInput | "@create" | "@delete", ImpactClass> = {
  product: ImpactClass.Corrective,
  qty: ImpactClass.Corrective,
  uom: ImpactClass.Corrective,
  hsCode: ImpactClass.Corrective,
  tags: ImpactClass.Corrective,
  "@create": ImpactClass.Corrective,
  "@delete": ImpactClass.Corrective,
};
