import type { FindingScope } from "./findings";

// Impact classes (§11.1), ordered by downstream cost.
export const ImpactClass = {
  Internal: "Internal",
  Corrective: "Corrective",
  RfqDefining: "RfqDefining",
  PricingAwardDefining: "PricingAwardDefining",
  Structural: "Structural",
} as const;
export type ImpactClass = (typeof ImpactClass)[keyof typeof ImpactClass];
export const IMPACT_CLASSES = Object.values(ImpactClass) as [ImpactClass, ...ImpactClass[]];

// Numeric rank so the fork can compare "RfqDefining-or-heavier".
export const IMPACT_RANK: Record<ImpactClass, number> = {
  Internal: 0,
  Corrective: 1,
  RfqDefining: 2,
  PricingAwardDefining: 3,
  Structural: 4,
};

export type ImpactPath = "free" | "change-order";

// A mutation flowing through the mediator. `field` for a field edit; `action`
// for structural add/remove. `queryId` names the owning query for revalidation.
export interface ChangeRequest {
  entity: string;
  id: string;
  field?: string;
  action?: "@create" | "@delete";
  patch?: Record<string, unknown>;
  queryId?: string;
  actorId?: string | null;
  reason?: string;
}

export interface ImpactDecision {
  class: ImpactClass;
  scope: FindingScope[];
  path: ImpactPath;
}

// The blast-radius preview returned when a change-order-path request arrives without a
// `reason` (Task 7, §11.3): what a confirm-with-reason would invalidate (QUOTED → INVALID)
// vs silently refresh (RFQ_SENT — the FF hasn't priced yet, so the manifest swap is free).
export interface ChangeOrderPreview {
  affectedLegs: string[];
  invalidatingQuotes: { quoteId: string; freightForwarderId: string }[];
  refreshingQuotes: { quoteId: string; freightForwarderId: string }[];
  impactClass: ImpactClass;
}

// The fork (§7.3, §11.2/§11.4): a change is FREE unless it is RfqDefining-or-heavier
// AND targets a scope that already has downstream work. Pre-RFQ (no downstream work)
// everything is Free; Internal/Corrective stay Free even post-RFQ (class still gates).
export function decidePath(impactClass: ImpactClass, hasDownstreamWork: boolean): ImpactPath {
  const rfqDefiningOrHeavier = IMPACT_RANK[impactClass] >= IMPACT_RANK.RfqDefining;
  return rfqDefiningOrHeavier && hasDownstreamWork ? "change-order" : "free";
}
