import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import {
  Role,
  rejectSchema,
  requestRequoteSchema,
  sendForApprovalSchema,
  type RejectInput,
  type RequestRequoteInput,
  type SendForApprovalInput,
} from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { AwardService } from "./award.service";
import { NegotiationService } from "./negotiation.service";

// Maker/checker workflow (S5.4 design §9). send-for-approval (steps 1+3 merged, S5.9 Task 3
// register B2/B3 — it now names the offer it acts on and runs the selection + send in one
// transaction) is the maker half — Executive+ (no @Roles), same auth-only convention as
// comparison.controller.ts / rfq.controller.ts. approve/reject (steps 2+4) are the checker
// half — Manager+, gated with @Roles per the fx-rates.controller.ts precedent; the service
// additionally enforces four-eyes (the sender may not decide their own send). The old
// `PUT .../legs/:legId/shortlist` route is retired — nothing but the single send-for-approval
// call selects an offer any more.
@Controller("queries/:id")
export class AwardController {
  constructor(
    private readonly award: AwardService,
    private readonly negotiation: NegotiationService,
  ) {}

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

  // S5.5 (design §10.1) — negotiation. Executive+ (no @Roles), same maker tier as
  // shortlist/send-for-approval/reject above: asking an FF to revise their price is not itself
  // a checker-level decision. Delegates to NegotiationService (a dedicated service, not
  // AwardService, since it orchestrates RfqService's token/deadline reset + comms alongside the
  // status/decision writes — see negotiation.service.ts).
  @Post("legs/:legId/quotes/:quoteId/request-requote")
  @HttpCode(200)
  requestRequote(
    @Param("id") id: string,
    @Param("legId") legId: string,
    @Param("quoteId") quoteId: string,
    @Body(new ZodValidationPipe(requestRequoteSchema)) body: RequestRequoteInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.negotiation.requestRequote(id, legId, quoteId, body, user);
  }

  // The two TERMINAL endpoints (S5.4 Task 4) — query-scoped (no :legId), neither takes a body.
  // generate-client-quote freezes the award snapshot + rolls the query to QUOTING_CLIENT;
  // Manager+ gated like approve/reject above (it's the moment a client-facing quote is
  // committed to). reopen-comparison reverses it back to QUOTED and is Executive+ (no @Roles),
  // same auth-only convention as shortlist/send-for-approval — reopening is not itself a
  // checker-level decision, just undoing the freeze.
  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post("generate-client-quote")
  @HttpCode(200)
  generateClientQuote(@Param("id") id: string, @CurrentUser() user: RequestUser) {
    return this.award.generateClientQuote(id, user);
  }

  @Post("reopen-comparison")
  @HttpCode(200)
  reopenComparison(@Param("id") id: string, @CurrentUser() user: RequestUser) {
    return this.award.reopenComparison(id, user);
  }
}
