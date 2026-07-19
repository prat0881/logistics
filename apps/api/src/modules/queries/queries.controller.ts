import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import {
  checklistPatchSchema,
  queryListQuerySchema,
  querySaveSchema,
  type ChecklistPatchInput,
  type QueryListParams,
  type QuerySaveInput,
} from "@svyft/shared";
import type { Paginated } from "@svyft/shared";
import type { QueryListRow } from "@svyft/shared";
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

  @Get()
  list(
    @Query(new ZodValidationPipe(queryListQuerySchema)) params: QueryListParams,
  ): Promise<Paginated<QueryListRow>> {
    return this.queries.list(params);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.queries.get(id);
  }

  @Patch(":id")
  patch(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(querySaveSchema)) body: QuerySaveInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.queries.patch(id, body, user);
  }

  @Post(":id/create")
  @HttpCode(201)
  createQuery(@Param("id") id: string, @CurrentUser() user: RequestUser) {
    return this.queries.createQuery(id, user);
  }

  // Nest distinguishes PATCH :id/checklist from PATCH :id by path depth — no ordering hazard.
  @Patch(":id/checklist")
  patchChecklist(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(checklistPatchSchema)) body: ChecklistPatchInput,
  ) {
    return this.queries.patchChecklist(id, body);
  }
}
