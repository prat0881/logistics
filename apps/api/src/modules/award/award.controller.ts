import { Body, Controller, HttpCode, Param, Post, Put } from "@nestjs/common";
import {
  Role,
  rejectSchema,
  sendForApprovalSchema,
  shortlistSchema,
  type RejectInput,
  type SendForApprovalInput,
  type ShortlistInput,
} from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { AwardService } from "./award.service";

// Maker/checker workflow (S5.4 design §9). shortlist/send-for-approval (steps 1+3) are the
// maker half — Executive+ (no @Roles), same auth-only convention as comparison.controller.ts /
// rfq.controller.ts. approve/reject (steps 2+4) are the checker half — Manager+, gated with
// @Roles per the fx-rates.controller.ts precedent; the service additionally enforces four-eyes
// (the sender may not decide their own send).
@Controller("queries/:id")
export class AwardController {
  constructor(private readonly award: AwardService) {}

  @Put("legs/:legId/shortlist")
  shortlist(
    @Param("id") id: string,
    @Param("legId") legId: string,
    @Body(new ZodValidationPipe(shortlistSchema)) body: ShortlistInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.award.shortlist(id, legId, body, user);
  }

  // Action endpoint, not a resource creation — 200, not the POST default 201 (mirrors
  // auth.controller.ts's login/refresh).
  @Post("legs/:legId/send-for-approval")
  @HttpCode(200)
  sendForApproval(
    @Param("id") id: string,
    @Param("legId") legId: string,
    @Body(new ZodValidationPipe(sendForApprovalSchema)) body: SendForApprovalInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.award.sendForApproval(id, legId, body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post("legs/:legId/approve")
  @HttpCode(200)
  approve(
    @Param("id") id: string,
    @Param("legId") legId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.award.approve(id, legId, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post("legs/:legId/reject")
  @HttpCode(200)
  reject(
    @Param("id") id: string,
    @Param("legId") legId: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: RejectInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.award.reject(id, legId, body, user);
  }
}
