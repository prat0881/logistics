import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from "@nestjs/common";
import {
  cargoCreateSchema,
  cargoUpdateSchema,
  type CargoCreateInput,
  type CargoUpdateInput,
} from "@svyft/shared";
import type { Response } from "express";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { CargoService } from "./cargo.service";

// Auth-only (Exec+) — no @Roles, matching the pre-re-model cargo endpoints. Package/item/MSDS
// routes are added by Tasks 5/7 under the same :id/cargo/... prefix; the packing-list export
// route below is Task 9.
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

  // Static segment "export" — does not collide with @Post() (create, zero extra segments): path-
  // to-segment-count makes them unambiguous regardless of declaration order. (@Patch(":cid")/
  // @Delete(":cid") below are a different HTTP method each, so no collision risk from those
  // either.) Mirrors the pre-Task-4 route mechanics verbatim; only the worksheet CONTENTS
  // (cargo.service.ts `exportXlsx`) differ — new per-item grain, design §8.3.
  @Post("export")
  @HttpCode(201)
  async export(@Param("id") id: string, @Res() res: Response) {
    const buf = await this.cargo.exportXlsx(id);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="query-${id}-cargo.xlsx"`);
    res.send(buf);
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
