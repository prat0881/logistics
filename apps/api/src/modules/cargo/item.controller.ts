import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from "@nestjs/common";
import {
  itemCreateSchema,
  itemUpdateSchema,
  type ItemCreateInput,
  type ItemUpdateInput,
} from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { ItemService } from "./item.service";

// Auth-only (Exec+) — no @Roles, matching PackageController/CargoController. Mounted one level
// below PackageController's own `:pid` collection, for `:pid`'s items (Task 7).
@Controller("queries/:id/cargo/:cid/packages/:pid/items")
export class ItemController {
  constructor(private readonly items: ItemService) {}

  @Post()
  create(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @Param("pid") pid: string,
    @Body(new ZodValidationPipe(itemCreateSchema)) body: ItemCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.items.create(id, cid, pid, body, user);
  }

  @Patch(":iid")
  update(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @Param("pid") pid: string,
    @Param("iid") iid: string,
    @Body(new ZodValidationPipe(itemUpdateSchema)) body: ItemUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.items.update(id, cid, pid, iid, body, user);
  }

  @Delete(":iid")
  @HttpCode(204)
  async remove(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @Param("pid") pid: string,
    @Param("iid") iid: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.items.remove(id, cid, pid, iid, user);
  }
}
