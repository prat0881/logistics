import { Module } from "@nestjs/common";
import { RoutingModule } from "../routing/routing.module";
import { ImpactRegistry } from "./impact.registry";
import { ImpactClassifier } from "./impact.classifier";
import { ScopeResolver } from "./scope.resolver";
import { ChangeMediator } from "./change-mediator";
import { FreePathStrategy } from "./free-path.strategy";
import { ChangeOrderStrategy } from "./change-order.strategy";
import { CHANGE_LOG, NoopChangeLog } from "./change-log";

@Module({
  imports: [RoutingModule],
  providers: [
    ImpactRegistry,
    ImpactClassifier,
    ScopeResolver,
    ChangeMediator,
    FreePathStrategy,
    ChangeOrderStrategy,
    { provide: CHANGE_LOG, useClass: NoopChangeLog },
  ],
  exports: [ChangeMediator, ImpactRegistry],
})
export class ChangesModule {}
