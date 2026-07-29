import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { RfqTokenService } from "../rfq/rfq-token.service";

@Injectable()
export class RfqTokenGuard implements CanActivate {
  constructor(private readonly token: RfqTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const raw = request.params?.token as string | undefined;
    const scope = raw ? await this.token.resolveByToken(raw) : null;
    if (!scope) throw new UnauthorizedException("This RFQ link is invalid or has expired");
    request.ffScope = scope;
    return true;
  }
}
