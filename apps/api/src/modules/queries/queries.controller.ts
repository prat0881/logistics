import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { querySaveSchema, type QuerySaveInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { QueriesService } from "./queries.service";

@Controller("queries")
export class QueriesController {
  constructor(private readonly queries: QueriesService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(querySaveSchema)) body: QuerySaveInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.queries.create(body, user);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.queries.get(id);
  }
}
