// apps/api/src/modules/legs/legs.controller.ts
import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { legSaveSchema, type LegSaveInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { LegsService } from "./legs.service";

@Controller("queries/:id/legs")
export class LegsController {
  constructor(private readonly legs: LegsService) {}

  @Post()
  create(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(legSaveSchema)) body: LegSaveInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.legs.create(id, body, user);
  }

  @Patch(":legId")
  update(
    @Param("id") id: string,
    @Param("legId") legId: string,
    @Body(new ZodValidationPipe(legSaveSchema)) body: LegSaveInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.legs.update(id, legId, body, user);
  }

  @Delete(":legId")
  @HttpCode(204)
  remove(@Param("id") id: string, @Param("legId") legId: string, @CurrentUser() user: RequestUser) {
    return this.legs.remove(id, legId, user);
  }
}
