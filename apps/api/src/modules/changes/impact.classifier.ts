import { Injectable } from "@nestjs/common";
import type { ChangeRequest, FindingScope, ImpactClass } from "@svyft/shared";
import { ImpactRegistry } from "./impact.registry";
import { RoutingService } from "../routing/routing.service";

export interface Classification {
  class: ImpactClass;
  scope: FindingScope[];
}

// Maps (entity, field|action) → impact class + the minimal touched scope (§11.3). A cargo edit
// fans out to the legs carrying that row (via LegCargo) — that is the scope the Stage-4
// change-order cascade will reopen. Every other entity is self-scope.
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

    let scope: FindingScope[];
    if (req.entity === "cargo") {
      const legIds = await this.routing.legsCarryingCargo(req.id);
      scope =
        legIds.length > 0
          ? legIds.map((id) => ({ type: "leg", id }))
          : [{ type: "cargo", id: req.id }]; // unassigned cargo → self-scope
    } else {
      scope = [{ type: req.entity as FindingScope["type"], id: req.id }];
    }
    return { class: impactClass, scope };
  }
}
