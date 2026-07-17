import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Role, vesselCreateSchema, vesselUpdateSchema } from "@svyft/shared";
import type { VesselCreateInput, VesselUpdateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { VesselsService } from "./vessels.service";

@Controller("vessels")
export class VesselsController {
  constructor(private readonly vessels: VesselsService) {}

  @Get()
  list(
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("page") page = "1",
    @Query("pageSize") pageSize = "20",
  ) {
    return this.vessels.list({
      q,
      status,
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.min(Math.max(1, Number(pageSize) || 20), 100),
    });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.vessels.get(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  create(@Body(new ZodValidationPipe(vesselCreateSchema)) body: VesselCreateInput) {
    return this.vessels.create(body);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(vesselUpdateSchema)) body: VesselUpdateInput,
  ) {
    return this.vessels.update(id, body);
  }
}
