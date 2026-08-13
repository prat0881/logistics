import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  packageCreateSchema,
  packageUpdateSchema,
  type PackageCreateInput,
  type PackageUpdateInput,
} from "@svyft/shared";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import type { MsdsUpload } from "../files/files.service";
import { PackageService } from "./package.service";

// Auth-only (Exec+) — no @Roles, matching CargoController (Task 4) and the pre-re-model cargo
// endpoints. Item CRUD (Task 7) is added under the same :id/cargo/:cid/packages/... prefix by a
// later task.
@Controller("queries/:id/cargo/:cid/packages")
export class PackageController {
  constructor(private readonly packages: PackageService) {}

  @Post()
  create(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @Body(new ZodValidationPipe(packageCreateSchema)) body: PackageCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.packages.create(id, cid, body, user);
  }

  @Patch(":pid")
  update(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @Param("pid") pid: string,
    @Body(new ZodValidationPipe(packageUpdateSchema)) body: PackageUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.packages.update(id, cid, pid, body, user);
  }

  @Delete(":pid")
  @HttpCode(204)
  async remove(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @Param("pid") pid: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.packages.remove(id, cid, pid, user);
  }

  // Mirrors the pre-re-model cargo MSDS route: multipart, field name "file", PDF-only (validated
  // in FilesService.storeMsds by declared mime + magic bytes), 10MB cap.
  @Post(":pid/msds")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadMsds(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @Param("pid") pid: string,
    @UploadedFile() file: MsdsUpload,
    @CurrentUser() user: RequestUser,
  ) {
    return this.packages.attachMsds(id, cid, pid, file, user);
  }

  // Task 6 "add N copies": clone a saved package `count` times (2..50). `:cid` stays in the route
  // for consistent nesting under this controller's prefix, but isn't forwarded to the service —
  // PackageService.copy looks the source package up by (id, queryId) alone, per the brief's exact
  // signature (see package.service.ts for why). 201 is Nest's default success code for @Post.
  @Post(":pid/copies")
  copy(
    @Param("id") id: string,
    @Param("pid") pid: string,
    @Body(new ZodValidationPipe(z.object({ count: z.number().int().min(2).max(50) })))
    body: { count: number },
    @CurrentUser() user: RequestUser,
  ) {
    return this.packages.copy(id, pid, body.count, user);
  }
}
