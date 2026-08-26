import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import {
  Role,
  rejectSchema,
  reopenComparisonSchema,
  requestRequoteSchema,
  sendForApprovalSchema,
  type RejectInput,
  type ReopenComparisonInput,
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

  // S5.5 (design §10.1) — negotiation. Delegates to NegotiationService (a dedicated service, not
  // AwardService, since it orchestrates RfqService's token/deadline reset + comms alongside the
  // status/decision writes — see negotiation.service.ts).
  //
  // S5.9.5 (design D3) — Executive ONLY, and deliberately EXCLUDING the higher roles. This is the
  // first workflow write in the codebase to do that, and it is not an oversight to be normalised
  // away: the product owner's rule is that negotiation with a forwarder is always the Executive's,
  // and a Manager/Administrator's route to a revised price is Reject-with-a-reason. The UI has
  // enforced this since S5.9.1 R3; the server never shared the rule, so a checker could negotiate
  // straight through the API — the same shape as register B1, already found and closed once.
  @Roles(Role.EXECUTIVE)
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

  // The two TERMINAL endpoints (S5.4 Task 4) — query-scoped (no :legId).
  // generate-client-quote freezes the award snapshot + rolls the query to QUOTING_CLIENT;
  // Manager+ gated like approve/reject above (it's the moment a client-facing quote is
  // committed to).
  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post("generate-client-quote")
  @HttpCode(200)
  generateClientQuote(@Param("id") id: string, @CurrentUser() user: RequestUser) {
    return this.award.generateClientQuote(id, user);
  }

  // S5.9.5 (design D6) — Manager/Admin only. Reopening supersedes an ISSUED client quotation and
  // deletes a DRAFT one (see `reopenComparison`), which is a checker-tier act, not a maker one; the
  // route carried no @Roles at all before this, so an Executive could do it.
  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post("reopen-comparison")
  @HttpCode(200)
  reopenComparison(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(reopenComparisonSchema)) body: ReopenComparisonInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.award.reopenComparison(id, body, user);
  }
}
