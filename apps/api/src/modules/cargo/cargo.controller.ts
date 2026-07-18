import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
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
import type { MsdsUpload } from "../files/files.service";
import { CargoService } from "./cargo.service";

@Controller("queries/:id/cargo")
export class CargoController {
  constructor(private readonly cargo: CargoService) {}

  @Post()
  create(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(cargoCreateSchema)) body: CargoCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.cargo.create(id, body, user);
  }

  // Static segment "export" — does not collide with @Post() (create, zero extra segments) or
  // @Post(":cid/msds") (two extra segments): path-to-segment-count makes all three unambiguous
  // regardless of declaration order.
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

  @Post(":cid/msds")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadMsds(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @UploadedFile() file: MsdsUpload,
    @CurrentUser() user: RequestUser,
  ) {
    return this.cargo.attachMsds(id, cid, file, user);
  }
}
