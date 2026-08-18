import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import {
  Role,
  quotationIssueSchema,
  quotationPatchSchema,
  type QuotationIssue,
  type QuotationPatch,
} from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import type { RequestUser } from "../auth/types";
import { QuotationService } from "./quotation.service";

// Manager+ to build/price/issue a client quotation (design doc "Decisions" — RBAC row),
// matching the existing gate on generating the client quote (§16 O4). Class-level so every
// route (including Task 4's issue/revise) inherits it.
@Roles(Role.ADMINISTRATOR, Role.MANAGER)
@Controller("queries/:id/quotation")
export class QuotationController {
  constructor(private readonly quotation: QuotationService) {}

  @Get()
  get(@Param("id") id: string) {
    return this.quotation.getOrCreateDraft(id);
  }

  @Patch()
  patch(@Param("id") id: string, @Body(new ZodValidationPipe(quotationPatchSchema)) body: QuotationPatch) {
    return this.quotation.patch(id, body);
  }

  // Action endpoint, not a resource creation — 200, not the POST default 201 (mirrors
  // award.controller.ts's approve/reject/generate-client-quote).
  @Post("issue")
  @HttpCode(200)
  issue(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(quotationIssueSchema)) body: QuotationIssue,
    @CurrentUser() user: RequestUser,
  ) {
    return this.quotation.issue(id, body, user);
  }

  @Post("revise")
  @HttpCode(200)
  revise(@Param("id") id: string) {
    return this.quotation.revise(id);
  }
}
