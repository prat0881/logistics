import { Module } from "@nestjs/common";
import { RoutingModule } from "../routing/routing.module";
import { ImpactRegistry } from "./impact.registry";
import { ImpactClassifier } from "./impact.classifier";
import { ScopeResolver } from "./scope.resolver";
import { ChangeMediator } from "./change-mediator";
import { FreePathStrategy } from "./free-path.strategy";
import { ChangeOrderStrategy } from "./change-order.strategy";
import { CHANGE_LOG } from "./change-log";
import { PrismaChangeLog } from "./prisma-change-log";
import { ChangeLogPolicy } from "./change-log-policy";

@Module({
  imports: [RoutingModule],
  providers: [
    ImpactRegistry,
    ImpactClassifier,
    ScopeResolver,
    ChangeMediator,
    FreePathStrategy,
    ChangeOrderStrategy,
    ChangeLogPolicy,
    { provide: CHANGE_LOG, useClass: PrismaChangeLog },
  ],
  exports: [ChangeMediator, ImpactRegistry, ChangeLogPolicy],
})
export class ChangesModule {}
