// apps/api/src/modules/points/points.controller.ts
import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { pointSaveSchema, pointUpdateSchema, type PointSaveInput, type PointUpdateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { PointsService } from "./points.service";

@Controller("queries/:id/points")
export class PointsController {
  constructor(private readonly points: PointsService) {}

  @Post()
  create(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(pointSaveSchema)) body: PointSaveInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.points.create(id, body, user);
  }

  @Patch(":pointId")
  update(
    @Param("id") id: string,
    @Param("pointId") pointId: string,
    @Body(new ZodValidationPipe(pointUpdateSchema)) body: PointUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.points.update(id, pointId, body, user);
  }

  @Delete(":pointId")
  @HttpCode(204)
  remove(@Param("id") id: string, @Param("pointId") pointId: string, @CurrentUser() user: RequestUser) {
    return this.points.remove(id, pointId, user);
  }
}
