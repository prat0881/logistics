import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { useFfRfq, useSaveDraft, useSubmit } from "./useFfPortal";

afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useFfPortal", () => {
  it("useFfRfq fetches the scoped RFQ", async () => {
    vi.stubGlobal("fetch", mockFetch((url) =>
      url.endsWith("/api/ff/rfq/tok") ? { status: 200, body: { rfqNumber: "R-9", legs: [] } } : { status: 404 }));
    const { result } = renderHook(() => useFfRfq("tok"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.rfqNumber).toBe("R-9");
  });

  it("useFfRfq does not retry on 401 (surfaces immediately)", async () => {
    const fx = mockFetch(() => ({ status: 401, body: {} }));
    vi.stubGlobal("fetch", fx);
    const { result } = renderHook(() => useFfRfq("bad"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as unknown as { status: number }).status).toBe(401);
    expect(fx).toHaveBeenCalledTimes(1);
  });

  it("useSaveDraft PATCHes the draft", async () => {
    const fx = mockFetch(() => ({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fx);
    const { result } = renderHook(() => useSaveDraft("tok", "L1"), { wrapper: wrapper() });
    await result.current.mutateAsync({ legId: "L1" } as never);
    expect(fx).toHaveBeenCalledWith("/api/ff/rfq/tok/quotes/L1", expect.objectContaining({ method: "PATCH" }));
  });

  it("useSubmit POSTs { version } to the submit endpoint and returns { quoteId, status }", async () => {
    const fx = mockFetch(() => ({ status: 201, body: { quoteId: "Q9", status: "QUOTED" } }));
    vi.stubGlobal("fetch", fx);
    const { result } = renderHook(() => useSubmit("tok", "L1"), { wrapper: wrapper() });
    // S5.9 D10: the caller passes the leg's current `version` (echoed from the GET DTO it's
    // rendering) — the stale-page guard's whole point is that this must NOT be omittable.
    const res = await result.current.mutateAsync("v-abc123");
    expect(res).toEqual({ quoteId: "Q9", status: "QUOTED" });
    expect(fx).toHaveBeenCalledWith(
      "/api/ff/rfq/tok/quotes/L1/submit",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        body: JSON.stringify({ version: "v-abc123" }),
      }),
    );
  });
});
