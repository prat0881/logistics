import { Module, type OnModuleInit } from "@nestjs/common";
import { ImpactRegistry } from "../changes/impact.registry";
import { ChangesModule } from "../changes/changes.module";
import { StatusModule } from "../status/status.module";
import { QueriesService } from "./queries.service";
import { QueriesController } from "./queries.controller";
import { queryImpactMap } from "./query.impact";

@Module({
  imports: [ChangesModule, StatusModule],
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
