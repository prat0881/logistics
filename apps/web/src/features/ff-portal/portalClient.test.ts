import { describe, it, expect, afterEach, vi } from "vitest";
import { mockFetch } from "@/test/mock-fetch";
import { portalGet, portalPatch, portalPost, PortalError } from "./portalClient";

afterEach(() => vi.unstubAllGlobals());

describe("portalClient", () => {
  it("GET returns parsed JSON on 200", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 200, body: { rfqNumber: "R-1" } })));
    await expect(portalGet("/api/ff/rfq/tok")).resolves.toEqual({ rfqNumber: "R-1" });
  });

  it("GET sends credentials:omit (never the cookie)", async () => {
    const fx = mockFetch(() => ({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fx);
    await portalGet("/api/ff/rfq/tok");
    expect(fx).toHaveBeenCalledWith("/api/ff/rfq/tok", expect.objectContaining({ credentials: "omit" }));
  });

  it("401 throws PortalError(401) and does NOT import lib/api onUnauthorized", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 401, body: { message: "bad token" } })));
    const err = await portalGet("/api/ff/rfq/bad").catch((e) => e);
    expect(err).toBeInstanceOf(PortalError);
    expect(err.status).toBe(401);
  });

  it("422 carries findings on the error", async () => {
    const findings = [{ rule: "Q1", severity: "blocking", scope: { type: "leg", id: "L1" }, message: "x" }];
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 422, body: { findings } })));
    const err: PortalError = await portalPost("/api/ff/rfq/tok/quotes/L1/submit", {}).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.findings).toEqual(findings);
  });

  it("409 throws PortalError(409)", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 409, body: {} })));
    const err: PortalError = await portalPost("/api/ff/rfq/tok/quotes/L1/submit", {}).catch((e) => e);
    expect(err.status).toBe(409);
  });

  it("PATCH sends JSON body + Content-Type", async () => {
    const fx = mockFetch(() => ({ status: 200, body: { ok: true } }));
    vi.stubGlobal("fetch", fx);
    await portalPatch("/api/ff/rfq/tok/quotes/L1", { legId: "L1" });
    expect(fx).toHaveBeenCalledWith(
      "/api/ff/rfq/tok/quotes/L1",
      expect.objectContaining({
        method: "PATCH",
        credentials: "omit",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ legId: "L1" }),
      }),
    );
  });
});
