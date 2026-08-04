import { ImpactClass, type QuerySaveInput } from "@svyft/shared";

// Field → impact class for the Query aggregate. Typed as Record<keyof QuerySaveInput,
// ImpactClass> (rather than the looser EntityImpactMap) so the compiler REQUIRES an entry
// for EVERY querySaveSchema field — a future field can't silently ship without a declared
// impact class (previously only caught at runtime, by ImpactClassifier.classify throwing on
// a missing key). A Record<keyof QuerySaveInput, ImpactClass> is structurally assignable to
// ImpactRegistry.declare's EntityImpactMap (= Record<string, ImpactClass>) param, so
// `declare("query", queryImpactMap)` still type-checks. All Free-path in Stage 3 (no
// downstream work); classes gate the fork once Stage 4 RFQs exist.
// `reason` is excluded — it's ChangeRequest metadata (Task 10, SB6), never the classified
// field; QueriesService strips it from `fields` before highestImpactField ever sees it.
export const queryImpactMap: Record<Exclude<keyof QuerySaveInput, "reason">, ImpactClass> = {
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
  readyDateTimezone: ImpactClass.Corrective,
  targetDeliveryTimezone: ImpactClass.Corrective,
};
