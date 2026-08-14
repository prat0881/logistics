import { Body, Controller, HttpCode, Param, Post, Put } from "@nestjs/common";
import {
  sendForApprovalSchema,
  shortlistSchema,
  type SendForApprovalInput,
  type ShortlistInput,
} from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { AwardService } from "./award.service";

// Maker half of the maker-checker workflow (S5.4 design §9 steps 1+3) — Executive+ (no
// @Roles), same auth-only convention as comparison.controller.ts / rfq.controller.ts. The
// checker half (approve/reject; Manager+ + four-eyes) lands in Task 3.
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
}
