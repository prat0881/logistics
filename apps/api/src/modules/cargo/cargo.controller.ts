import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import {
  cargoCreateSchema,
  cargoUpdateSchema,
  type CargoCreateInput,
  type CargoUpdateInput,
} from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { CargoService } from "./cargo.service";

// Auth-only (Exec+) — no @Roles, matching the pre-re-model cargo endpoints. Package/item/MSDS/
// export routes are added by Tasks 5/7/9 under the same :id/cargo/... prefix.
@Controller("queries/:id/cargo")
export class CargoController {
  constructor(private readonly cargo: CargoService) {}

  @Get()
  list(@Param("id") id: string) {
    return this.cargo.getTree(id);
  }

  @Post()
  create(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(cargoCreateSchema)) body: CargoCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.cargo.create(id, body, user);
  }

  @Patch(":cid")
  update(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @Body(new ZodValidationPipe(cargoUpdateSchema)) body: CargoUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.cargo.update(id, cid, body, user);
  }

  @Delete(":cid")
  @HttpCode(204)
  async remove(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.cargo.remove(id, cid, user);
  }
}
