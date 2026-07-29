import { UnauthorizedException } from "@nestjs/common";
import { RfqTokenGuard } from "../src/modules/ff-portal/rfq-token.guard";

function mkCtx(token: string) {
  const request: any = { params: { token } };
  const context: any = { switchToHttp: () => ({ getRequest: () => request }) };
  return { context, request };
}

describe("RfqTokenGuard (unit)", () => {
  it("resolves the token, attaches ffScope, and allows", async () => {
    const scope = { rfq: { id: "r1", queryId: "q1" }, quotes: [] };
    const guard = new RfqTokenGuard({ resolveByToken: async () => scope } as any);
    const { context, request } = mkCtx("raw-token");
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.ffScope).toBe(scope);
  });
  it("throws 401 (UnauthorizedException) when the token does not resolve", async () => {
    const guard = new RfqTokenGuard({ resolveByToken: async () => null } as any);
    const { context } = mkCtx("bad-token");
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
