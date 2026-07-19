import { Injectable } from "@nestjs/common";
import { decidePath, type ChangeRequest, type ImpactDecision } from "@svyft/shared";
import { ImpactClassifier } from "./impact.classifier";
import { ScopeResolver } from "./scope.resolver";
import { FreePathStrategy, type ChangeResult, type UnitOfWork } from "./free-path.strategy";
import { ChangeOrderStrategy } from "./change-order.strategy";

// One mediator for every mutation (§7.3). classify → resolve downstream → fork.
@Injectable()
export class ChangeMediator {
  constructor(
    private readonly classifier: ImpactClassifier,
    private readonly scope: ScopeResolver,
    private readonly free: FreePathStrategy,
    private readonly changeOrder: ChangeOrderStrategy,
  ) {}

  async apply(req: ChangeRequest, uow: UnitOfWork): Promise<ChangeResult> {
    const { class: impactClass, scope } = await this.classifier.classify(req);
    const hasDownstreamWork = await this.scope.downstreamWork(scope);
    const path = decidePath(impactClass, hasDownstreamWork);
    const decision: ImpactDecision = { class: impactClass, scope, path };

    return path === "free"
      ? this.free.run(req, decision, uow)
      : this.changeOrder.run(req, decision, uow);
  }
}
