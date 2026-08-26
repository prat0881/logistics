import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import {
  Role,
  chargeLineCreateSchema,
  chargeLineUpdateSchema,
  type ChargeLineCreateInput,
  type ChargeLineDefinitionAdminDto,
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

  // Additive admin read — never touches list() above. That handler is active-only and shaped
  // for the RFQ workspace popover (role/zone); this one is the editable admin representation
  // (category/variant/isAdditional) including inactive rows, gated to Admin/Manager because it
  // exposes dormant definitions and editable fields the quoting surface never needed. Declared
  // as a literal "admin" segment, not a query param on list(), and there is no `@Get(":id")` in
  // this controller for it to collide with — if one is ever added, it must be declared below
  // this route so it cannot shadow it.
  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Get("admin")
  listAdmin(): Promise<ChargeLineDefinitionAdminDto[]> {
    return this.svc.listAdmin();
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
