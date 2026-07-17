import { PasswordService } from "../src/modules/auth/password.service";
import { generateRefreshToken, hashRefreshToken } from "../src/modules/auth/refresh-token.util";

describe("PasswordService", () => {
  const svc = new PasswordService();

  it("hashes to something other than the plaintext", async () => {
    const hash = await svc.hash("s3cret");
    expect(hash).not.toBe("s3cret");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await svc.hash("s3cret");
    expect(await svc.verify("s3cret", hash)).toBe(true);
    expect(await svc.verify("wrong", hash)).toBe(false);
  });
});

describe("refresh-token util", () => {
  it("generates a unique 64-char hex token", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("hashes deterministically with sha256 (64 hex chars)", () => {
    expect(hashRefreshToken("abc")).toBe(hashRefreshToken("abc"));
    expect(hashRefreshToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
