import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { RfqTokenGuard } from "../src/modules/ff-portal/rfq-token.guard";
import type { RfqTokenService } from "../src/modules/rfq/rfq-token.service";

function mkCtx(token: string) {
  const request: { params: { token: string }; ffScope?: unknown } = { params: { token } };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  return { context, request };
}

describe("RfqTokenGuard (unit)", () => {
  it("resolves the token, attaches ffScope, and allows", async () => {
    const scope = { rfq: { id: "r1", queryId: "q1" }, quotes: [] };
    const guard = new RfqTokenGuard({ resolveByToken: async () => scope } as unknown as RfqTokenService);
    const { context, request } = mkCtx("raw-token");
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.ffScope).toBe(scope);
  });

  it("throws 401 (UnauthorizedException) when the token does not resolve", async () => {
    const guard = new RfqTokenGuard({ resolveByToken: async () => null } as unknown as RfqTokenService);
    const { context } = mkCtx("bad-token");
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
