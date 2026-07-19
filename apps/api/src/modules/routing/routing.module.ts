// apps/api/src/modules/routing/routing.module.ts
import { Module } from "@nestjs/common";
import { ROUTE_VALIDATOR } from "../changes/route-validator";
import { RoutingController } from "./routing.controller";
import { RoutingService } from "./routing.service";
import { RoutingRouteValidator } from "./routing.route-validator";

@Module({
  controllers: [RoutingController],
  providers: [RoutingService, { provide: ROUTE_VALIDATOR, useClass: RoutingRouteValidator }],
  exports: [RoutingService, ROUTE_VALIDATOR],
})
export class RoutingModule {}
