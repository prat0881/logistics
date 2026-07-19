// apps/api/src/modules/routing/routing.controller.ts
import { Controller, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { RoutePhase } from "@svyft/shared";
import { RoutingService } from "./routing.service";

@Controller("queries/:id/validate")
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Post()
  @HttpCode(200)
  async validate(@Param("id") id: string, @Query("phase") phase?: string) {
    const p: RoutePhase = phase === "create" ? "create" : "draft";
    return { findings: await this.routing.validate(id, p) };
  }
}
