import { Body, Controller, Get, Post } from "@nestjs/common";
import { Role, fxRateCreateSchema } from "@svyft/shared";
import type { FxRateCreateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { FxRatesService } from "./fx-rates.service";

@Controller("fx-rates")
export class FxRatesController {
  constructor(private readonly fx: FxRatesService) {}

  @Get()
  list() {
    return this.fx.list(); // auth-only (Executive+)
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  create(
    @Body(new ZodValidationPipe(fxRateCreateSchema)) body: FxRateCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.fx.create(body, user.userId);
  }
}
