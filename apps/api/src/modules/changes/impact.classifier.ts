import { Injectable } from "@nestjs/common";
import type { ChangeRequest, FindingScope, ImpactClass } from "@svyft/shared";
import { ImpactRegistry } from "./impact.registry";
import { RoutingService } from "../routing/routing.service";

export interface Classification {
  class: ImpactClass;
  scope: FindingScope[];
}

// Maps (entity, field|action) → impact class + the minimal touched scope (§11.3). The leg is
// the biddable unit, so scope is always fanned out to the affected leg(s) before the Stage-4
// change-order cascade reopens them: cargo→legs carrying that row (LegCargo), point→legs using
// it as an endpoint, query→all its legs, quote→its leg, leg→itself. An entity with no legs in
// scope (unassigned/pre-RFQ, or an entity with no fan-out rule) falls back to self-scope.
@Injectable()
export class ImpactClassifier {
  constructor(
    private readonly registry: ImpactRegistry,
    private readonly routing: RoutingService,
  ) {}

  async classify(req: ChangeRequest): Promise<Classification> {
    const key = req.action ?? req.field;
    if (!key) throw new Error("ChangeRequest must carry a `field` or an `action`");

    const impactClass = this.registry.classOf(req.entity, key);
    if (!impactClass) throw new Error(`No impact class declared for ${req.entity}.${key}`);

    let legIds: string[];
    switch (req.entity) {
      case "cargo": legIds = await this.routing.legsCarryingCargo(req.id); break;
      case "point": legIds = await this.routing.legsUsingPoint(req.id); break;
      case "query": legIds = await this.routing.legsOfQuery(req.id); break;
      case "quotes": { const l = await this.routing.legOfQuote(req.id); legIds = l ? [l] : []; break; }
      case "leg": legIds = [req.id]; break;
      default: legIds = [];
    }
    const scope: FindingScope[] =
      legIds.length > 0
        ? legIds.map((id) => ({ type: "leg", id }))
        : [{ type: req.entity as FindingScope["type"], id: req.id }]; // self-scope fallback (pre-RFQ / unassigned)
    return { class: impactClass, scope };
  }
}
