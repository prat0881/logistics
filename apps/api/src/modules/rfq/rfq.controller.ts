import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import {
  distributeSchema,
  ffSelectionSchema,
  reissueTokenSchema,
  type DistributeInput,
  type FfSelectionInput,
  type ReissueTokenInput,
} from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { EligibilityService } from "./eligibility.service";
import { RfqService } from "./rfq.service";

@Controller("queries/:id")
export class RfqController {
  constructor(
    private readonly eligibility: EligibilityService,
    private readonly rfq: RfqService,
  ) {}

  @Get("legs/:legId/eligible-ffs")
  eligibleFfs(@Param("id") id: string, @Param("legId") legId: string, @Query("broaden") broaden?: string) {
    return this.eligibility.getEligibleFfs(id, legId, broaden === "true");
  }

  // Executive+ (no @Roles) — authenticated only. Read model for the Query Workspace grid.
  @Get("rfq-state")
  rfqState(@Param("id") id: string) {
    return this.rfq.getRfqState(id);
  }

  // Executive+ (no @Roles) — authenticated only, per the resolved RBAC decision
  @Put("legs/:legId/ff-selection")
  setSelection(
    @Param("id") id: string,
    @Param("legId") legId: string,
    @Body(new ZodValidationPipe(ffSelectionSchema)) body: FfSelectionInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.rfq.setFfSelection(id, legId, body.ffIds, user);
  }

  // Executive+ (no @Roles) — authenticated only
  @Post("distribute-all")
  distributeAll(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(distributeSchema)) body: DistributeInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.rfq.distributeAll(id, body, user);
  }

  // Executive+ (no @Roles) — authenticated only
  @Post("legs/:legId/distribute")
  distribute(
    @Param("id") id: string,
    @Param("legId") legId: string,
    @Body(new ZodValidationPipe(distributeSchema)) body: DistributeInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.rfq.distributeLeg(id, legId, body, user);
  }

  // Executive+ (no @Roles) — authenticated only. Keyed by (query, FF) so it works even
  // when the lost distribute response is exactly why the caller has no rfqId.
  @Post("rfqs/reissue-token")
  reissueToken(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(reissueTokenSchema)) body: ReissueTokenInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.rfq.reissueToken(id, body.freightForwarderId, user);
  }
}
