// apps/api/src/modules/points/points.module.ts
import { Module, type OnModuleInit } from "@nestjs/common";
import { ChangesModule } from "../changes/changes.module";
import { ImpactRegistry } from "../changes/impact.registry";
import { PointsController } from "./points.controller";
import { PointsService } from "./points.service";
import { pointImpactMap } from "./point.impact";

@Module({
  imports: [ChangesModule],
  controllers: [PointsController],
  providers: [PointsService],
  exports: [PointsService],
})
export class PointsModule implements OnModuleInit {
  constructor(private readonly impacts: ImpactRegistry) {}
  onModuleInit(): void {
    this.impacts.declare("point", pointImpactMap);
  }
}
