import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { FfScope as FfScopeType } from "../rfq/rfq-token.service";

export const FfScope = createParamDecorator((_data: unknown, ctx: ExecutionContext): FfScopeType => {
  return ctx.switchToHttp().getRequest().ffScope;
});
