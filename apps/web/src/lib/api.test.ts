import { describe, it, expect, vi, afterEach } from "vitest";
import { postJson, ApiError } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("ApiError", () => {
  it("throws ApiError with findings on 422", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({
          findings: [{ rule: "R1", severity: "blocking", scope: { type: "leg" }, message: "broken" }],
        }),
        text: async () => "",
      }),
    );
    await expect(postJson("/api/queries/x/create")).rejects.toMatchObject({
      status: 422,
      findings: [{ rule: "R1" }],
    });
  });

  it("throws ApiError with issues on 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ message: "Validation failed", issues: [{ path: ["email"], message: "bad" }] }),
        text: async () => "",
      }),
    );
    await expect(postJson("/api/x")).rejects.toMatchObject({
      status: 400,
      issues: [{ path: ["email"] }],
    });
  });

  it("ApiError is an instance of Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ message: "Internal error" }),
        text: async () => "",
      }),
    );
    try {
      await postJson("/api/x");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(500);
    }
  });

  it("postJson tolerates 204 no-content response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => { throw new Error("no body"); },
        text: async () => "",
      }),
    );
    const result = await postJson("/api/x");
    expect(result).toBeUndefined();
  });
});
