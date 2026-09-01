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

describe("raise()", () => {
  it("falls back to a status message when the server sends an empty message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ message: "" }),
      } as unknown as Response),
    );
    await expect(fetchJson("/api/clients")).rejects.toMatchObject({
      status: 409,
      message: "Request failed: 409",
    });
  });

  it("falls back when the message is whitespace only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ message: "   " }),
      } as unknown as Response),
    );
    await expect(fetchJson("/api/clients")).rejects.toMatchObject({
      message: "Request failed: 400",
    });
  });

  it("preserves a real server message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ message: "This client already has a primary contact" }),
      } as unknown as Response),
    );
    await expect(fetchJson("/api/clients")).rejects.toMatchObject({
      message: "This client already has a primary contact",
    });
  });

  // ZodValidationPipe throws `{ message: "Validation failed", issues }` for every schema
  // rejection. raise() is the shared fetch boundary for the whole app, so it surfaces the
  // body's own `message` as-is rather than reaching into `issues` — a caller that wants a
  // specific issue's text (e.g. the masters' `masterErrorMessage` helper) reads `issues` off the
  // thrown `ApiError` itself, which is why `issues` must still come through intact below.
  it("uses the body's message even when issues are present, and still passes issues through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          message: "Validation failed",
          issues: [
            { path: ["contacts"], message: "One contact must be marked Primary" },
            { path: ["city"], message: "Required" },
          ],
        }),
      } as unknown as Response),
    );
    await expect(fetchJson("/api/clients")).rejects.toMatchObject({
      status: 400,
      message: "Validation failed",
      issues: [{ path: ["contacts"] }, { path: ["city"] }],
    });
  });

  it("does not let an issue's message override a real server message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          message: "This client already has a primary contact",
          issues: [{ path: ["contacts"], message: "One contact must be marked Primary" }],
        }),
      } as unknown as Response),
    );
    await expect(fetchJson("/api/clients")).rejects.toMatchObject({
      message: "This client already has a primary contact",
    });
  });

  it("still produces an ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as unknown as Response),
    );
    await expect(fetchJson("/api/clients")).rejects.toBeInstanceOf(ApiError);
  });
});
