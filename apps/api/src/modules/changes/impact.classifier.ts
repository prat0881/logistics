import { Injectable } from "@nestjs/common";
import type { ChangeRequest, FindingScope, ImpactClass } from "@svyft/shared";
import { ImpactRegistry } from "./impact.registry";

export interface Classification {
  class: ImpactClass;
  scope: FindingScope[];
}

// Maps (entity, field|action) → impact class + the minimal touched scope (§11.3).
// Stage-3 scope is the target entity itself; the cargo→legs fan-out lands in Plan 5.
@Injectable()
export class ImpactClassifier {
  constructor(private readonly registry: ImpactRegistry) {}

  classify(req: ChangeRequest): Classification {
    const key = req.action ?? req.field;
    if (!key) throw new Error("ChangeRequest must carry a `field` or an `action`");

    const impactClass = this.registry.classOf(req.entity, key);
    if (!impactClass) throw new Error(`No impact class declared for ${req.entity}.${key}`);

    const scope: FindingScope[] = [{ type: req.entity as FindingScope["type"], id: req.id }];
    return { class: impactClass, scope };
  }
}
