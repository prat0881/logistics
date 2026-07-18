import { Module } from "@nestjs/common";
import { ImpactRegistry } from "./impact.registry";
import { ImpactClassifier } from "./impact.classifier";
import { ScopeResolver } from "./scope.resolver";
import { ChangeMediator } from "./change-mediator";
import { FreePathStrategy } from "./free-path.strategy";
import { ChangeOrderStrategy } from "./change-order.strategy";
import { CHANGE_LOG, NoopChangeLog } from "./change-log";
import { ROUTE_VALIDATOR, NoopRouteValidator } from "./route-validator";

@Module({
  providers: [
    ImpactRegistry,
    ImpactClassifier,
    ScopeResolver,
    ChangeMediator,
    FreePathStrategy,
    ChangeOrderStrategy,
    { provide: CHANGE_LOG, useClass: NoopChangeLog },
    { provide: ROUTE_VALIDATOR, useClass: NoopRouteValidator },
  ],
  exports: [ChangeMediator, ImpactRegistry],
})
export class ChangesModule {}
