import { ImpactClass } from "@svyft/shared";

// Quote (Forwarder-selection) impact classes (Design §4). @delete (remove an FF from a sent
// leg) = Structural (change-order — voids that FF's quote). @create (add an FF) = a new
// distribution that invalidates nothing → below the fork threshold (free). The FF's own
// price/density/transit are edited in the FF portal, NEVER through the mediator, so they are
// free by construction and are not listed here.
export const quoteImpactMap: Record<"@create" | "@delete", ImpactClass> = {
  "@create": ImpactClass.Corrective,
  "@delete": ImpactClass.Structural,
};
