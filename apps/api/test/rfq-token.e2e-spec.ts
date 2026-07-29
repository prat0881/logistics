import { RfqTokenService } from "../src/modules/rfq/rfq-token.service";

describe("RfqTokenService", () => {
  // PrismaService injected via DI at runtime; only mint/hash are tested here (no DB calls)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new RfqTokenService(null as any);
  it("mints a 256-bit hex token with a matching sha256 hash", () => {
    const { token, hash } = svc.mint();
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes -> 64 hex
    expect(hash).toBe(svc.hash(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("mints distinct tokens", () => {
    expect(svc.mint().token).not.toBe(svc.mint().token);
  });
});
