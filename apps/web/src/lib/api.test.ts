import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchJson, postJson, patchJson, ApiError, setUnauthorizedHandler } from "./api";

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

describe("unauthorized (401) handler (U1)", () => {
  afterEach(() => setUnauthorizedHandler(null));

  it("fires the handler on a 401 from a protected (non-auth) endpoint", async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: "Unauthorized" }),
        text: async () => "",
      }),
    );
    await expect(fetchJson("/api/queries")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauth).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire the handler for /api/auth/ 401s (login errors, me-probe)", async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => "",
      }),
    );
    await expect(postJson("/api/auth/login", {})).rejects.toBeInstanceOf(ApiError);
    expect(onUnauth).not.toHaveBeenCalled();
  });

  it("does NOT fire the handler on non-401 errors", async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "",
      }),
    );
    await expect(fetchJson("/api/queries")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauth).not.toHaveBeenCalled();
  });
});
