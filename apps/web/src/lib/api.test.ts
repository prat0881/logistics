import { describe, it, expect, vi, afterEach } from "vitest";
import { postJson, patchJson, ApiError } from "./api";

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
    await expect(postJson("/api/queries/x/create")).rejects.toBeInstanceOf(ApiError);
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
    await expect(postJson("/api/x")).rejects.toBeInstanceOf(ApiError);
    await expect(postJson("/api/x")).rejects.toMatchObject({
      status: 400,
      issues: [{ path: ["email"] }],
    });
  });

  it("ApiError is an instance of Error", async () => {
    expect.assertions(3);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ message: "Internal error" }),
        text: async () => "",
      }),
    );
    await expect(postJson("/api/x")).rejects.toBeInstanceOf(Error);
    await expect(postJson("/api/x")).rejects.toBeInstanceOf(ApiError);
    await expect(postJson("/api/x")).rejects.toMatchObject({ status: 500 });
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

  it("patchJson tolerates 204 no-content response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => { throw new Error("no body"); },
        text: async () => "",
      }),
    );
    const result = await patchJson("/api/x", { foo: "bar" });
    expect(result).toBeUndefined();
  });
});
