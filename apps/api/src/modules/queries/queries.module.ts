import { Module, type OnModuleInit } from "@nestjs/common";
import { ImpactRegistry } from "../changes/impact.registry";
import { ChangesModule } from "../changes/changes.module";
import { QueryLockModule } from "../award/query-lock.module";
import { StatusModule } from "../status/status.module";
import { LegsModule } from "../legs/legs.module";
import { RoutingModule } from "../routing/routing.module";
import { QueriesService } from "./queries.service";
import { QueriesController } from "./queries.controller";
import { queryImpactMap } from "./query.impact";

@Module({
  imports: [ChangesModule, StatusModule, LegsModule, RoutingModule, QueryLockModule],
  controllers: [QueriesController],
  providers: [QueriesService],
  exports: [QueriesService],
})
export class QueriesModule implements OnModuleInit {
  constructor(private readonly impacts: ImpactRegistry) {}
  onModuleInit(): void {
    this.impacts.declare("query", queryImpactMap);
  }
}
