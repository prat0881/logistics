import { ImpactClass } from "@svyft/shared";
import type { EntityImpactMap } from "../changes/impact.registry";

// Field → impact class for the Query aggregate. Must cover EVERY field in
// querySaveSchema, or the classifier throws. All Free-path in Stage 3 (no downstream
// work); classes gate the fork once Stage 4 RFQs exist.
export const queryImpactMap: EntityImpactMap = {
  // Internal — no downstream cost (§11.1)
  priority: ImpactClass.Internal,
  responseDeadline: ImpactClass.Internal,
  responseDeadlineRemarks: ImpactClass.Internal,
  internalNotes: ImpactClass.Internal,
  assignedUserId: ImpactClass.Internal,
  queryDate: ImpactClass.Internal,
  // Corrective — cosmetic contact/vessel edits (§11.1)
  contactName: ImpactClass.Corrective,
  contactDesignation: ImpactClass.Corrective,
  contactEmail: ImpactClass.Corrective,
  contactPhone: ImpactClass.Corrective,
  whatsappEnabled: ImpactClass.Corrective,
  faxNumber: ImpactClass.Corrective,
  vesselId: ImpactClass.Corrective,
  vesselName: ImpactClass.Corrective,
  imoNumber: ImpactClass.Corrective,
  eta: ImpactClass.Corrective,
  etb: ImpactClass.Corrective,
  etd: ImpactClass.Corrective,
  portOfCall: ImpactClass.Corrective,
  shipmentDescription: ImpactClass.Corrective,
  // RfqDefining — FFs quote against these (§11.1)
  clientId: ImpactClass.RfqDefining,
  incoterms: ImpactClass.RfqDefining,
  dgIndicator: ImpactClass.RfqDefining,
  readyDate: ImpactClass.RfqDefining,
  targetDelivery: ImpactClass.RfqDefining,
};
