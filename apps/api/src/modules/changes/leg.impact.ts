import { ImpactClass } from "@svyft/shared";
import type { EntityImpactMap } from "./impact.registry";

// Leg field impact classes (§7.3 / §11.1). Owned by the legs module in Plan 5;
// declared here now so the classifier + fork are provable in Plan 3.
export const legImpactMap: EntityImpactMap = {
  origin: ImpactClass.RfqDefining,
  destination: ImpactClass.RfqDefining,
  mode: ImpactClass.RfqDefining,
  readyDate: ImpactClass.RfqDefining,
  targetDelivery: ImpactClass.RfqDefining,
  legName: ImpactClass.Corrective,
  "@create": ImpactClass.Structural,
  "@delete": ImpactClass.Structural,
};
