import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import type { FfPortalRfqDto, QuoteDraft } from "@svyft/shared";
import { quoteDraftSchema } from "@svyft/shared";
import { Public } from "../auth/decorators/public.decorator";
import { RfqTokenGuard } from "./rfq-token.guard";
import { FfScope } from "./ff-scope.decorator";
import type { FfScope as FfScopeType } from "../rfq/rfq-token.service";
import { FfPortalService } from "./ff-portal.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";

@Public()
@UseGuards(RfqTokenGuard)
@Controller("ff/rfq/:token")
export class FfPortalController {
  constructor(private readonly portal: FfPortalService) {}

  @Get()
  resolve(@FfScope() scope: FfScopeType): Promise<FfPortalRfqDto> {
    return this.portal.resolveScope(scope);
  }

  @Patch("quotes/:legId")
  saveDraft(
    @FfScope() scope: FfScopeType,
    @Param("legId") legId: string,
    @Body(new ZodValidationPipe(quoteDraftSchema)) draft: QuoteDraft,
  ) {
    return this.portal.saveDraft(scope, legId, draft);
  }

  @Post("quotes/:legId/submit")
  @HttpCode(201)
  submit(@FfScope() scope: FfScopeType, @Param("legId") legId: string) {
    return this.portal.submit(scope, legId);
  }
}
