import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import {
  Role,
  chargeLineCreateSchema,
  chargeLineUpdateSchema,
  type ChargeLineCreateInput,
  type ChargeLineDefinitionDto,
  type ChargeLineUpdateInput,
} from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import type { RequestUser } from "../auth/types";
import { ChargeCatalogueService } from "./charge-catalogue.service";

@Controller("charge-line-definitions")
export class ChargeCatalogueController {
  constructor(private readonly svc: ChargeCatalogueService) {}

  @Get()
  list(): Promise<ChargeLineDefinitionDto[]> {
    return this.svc.list();
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  create(
    @Body(new ZodValidationPipe(chargeLineCreateSchema)) body: ChargeLineCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.svc.create(body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(chargeLineUpdateSchema)) body: ChargeLineUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.svc.update(id, body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.svc.remove(id);
  }
}
