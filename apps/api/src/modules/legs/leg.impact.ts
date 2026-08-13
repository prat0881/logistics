// apps/api/src/modules/legs/leg.impact.ts
import { ImpactClass, type LegSaveInput } from "@svyft/shared";

// Leg field impact classes (§11.1). Keys match the leg SAVE schema field names (originPointId,
// destinationPointId, …), not the abstract "origin"/"destination" of the old provisional map.
// Reassigning cargo recomputes coverage → Structural.
// `reason` is excluded — it's ChangeRequest metadata (Task 10, SB6), never the classified
// field; LegsService strips it from `fields` before highestImpactField ever sees it.
export const legImpactMap: Record<
  Exclude<keyof LegSaveInput, "reason"> | "@create" | "@delete",
  ImpactClass
> = {
  legName: ImpactClass.Corrective,
  originPointId: ImpactClass.RfqDefining,
  destinationPointId: ImpactClass.RfqDefining,
  mode: ImpactClass.RfqDefining,
  readyDate: ImpactClass.RfqDefining,
  targetDelivery: ImpactClass.RfqDefining,
  assignedPackageIds: ImpactClass.Structural,
  // Task 11: charge selection + warehouse toggle are both RfqDefining — free pre-distribute,
  // change-order-gated post-distribute (same class as mode/dates/endpoints).
  warehouseHandlingIncluded: ImpactClass.RfqDefining,
  chargeLineDefinitionIds: ImpactClass.RfqDefining,
  "@create": ImpactClass.Structural,
  "@delete": ImpactClass.Structural,
};
