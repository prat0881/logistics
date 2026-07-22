// apps/api/src/modules/points/point.impact.ts
import { ImpactClass, type PointSaveInput } from "@svyft/shared";

// Point field impact classes (§11.1: address + country are RfqDefining; contact is Corrective).
// Typed Record<keyof PointSaveInput | "@create" | "@delete"> for compile-time completeness.
export const pointImpactMap: Record<keyof PointSaveInput | "@create" | "@delete", ImpactClass> = {
  type: ImpactClass.RfqDefining,
  name: ImpactClass.Corrective,
  streetAddress: ImpactClass.RfqDefining,
  city: ImpactClass.RfqDefining,
  postalCode: ImpactClass.RfqDefining,
  country: ImpactClass.RfqDefining,
  contactName: ImpactClass.Corrective,
  contactPhone: ImpactClass.Corrective,
  contactEmail: ImpactClass.Corrective,
  warehouseType: ImpactClass.Corrective,
  iataCode: ImpactClass.RfqDefining,
  icaoCode: ImpactClass.Corrective,
  unLocode: ImpactClass.RfqDefining,
  terminal: ImpactClass.Corrective,
  timezone: ImpactClass.RfqDefining,
  "@create": ImpactClass.Structural,
  "@delete": ImpactClass.Structural,
};
