import { Controller, Get, UseGuards } from "@nestjs/common";
import type { FfPortalRfqDto } from "@svyft/shared";
import { Public } from "../auth/decorators/public.decorator";
import { RfqTokenGuard } from "./rfq-token.guard";
import { FfScope } from "./ff-scope.decorator";
import type { FfScope as FfScopeType } from "../rfq/rfq-token.service";
import { FfPortalService } from "./ff-portal.service";

@Public()
@UseGuards(RfqTokenGuard)
@Controller("ff/rfq/:token")
export class FfPortalController {
  constructor(private readonly portal: FfPortalService) {}

  @Get()
  resolve(@FfScope() scope: FfScopeType): Promise<FfPortalRfqDto> {
    return this.portal.resolveScope(scope);
  }
}
