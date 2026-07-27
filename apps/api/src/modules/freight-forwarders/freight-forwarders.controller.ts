import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Role, freightForwarderCreateSchema, freightForwarderUpdateSchema } from "@svyft/shared";
import type { FreightForwarderCreateInput, FreightForwarderUpdateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { FreightForwardersService } from "./freight-forwarders.service";

@Controller("freight-forwarders")
export class FreightForwardersController {
  constructor(private readonly ffs: FreightForwardersService) {}

  @Get()
  list(
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("page") page = "1",
    @Query("pageSize") pageSize = "20",
  ) {
    return this.ffs.list({
      q,
      status,
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.min(Math.max(1, Number(pageSize) || 20), 100),
    });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.ffs.get(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  create(@Body(new ZodValidationPipe(freightForwarderCreateSchema)) body: FreightForwarderCreateInput) {
    return this.ffs.create(body);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(freightForwarderUpdateSchema)) body: FreightForwarderUpdateInput,
  ) {
    return this.ffs.update(id, body);
  }
}
